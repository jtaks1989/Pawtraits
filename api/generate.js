module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    category,
    stylePrompt,
    gender,
    photoCount,
    isMultiPhoto,
  } = req.body;

  if (!category) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  const isGroup = category === 'family' || category === 'couples';
  const isMultiSubject = isGroup || isMultiPhoto || (photoCount || 1) > 1;
  const effectiveGender = isGroup ? 'mixed'
    : (gender && gender !== 'auto') ? gender : null;

  function buildDescription(cat, gen, isMulti) {
    if (isMulti || cat === 'couples') return 'a couple, a man and a woman side by side';
    if (cat === 'family') return 'a family group';
    if (cat === 'pets') return 'a noble dog';
    if (cat === 'children') return 'a young child';
    if (gen === 'male') return 'a man';
    if (gen === 'female') return 'a woman';
    return 'a person';
  }

  function getDefaultStyle(cat, gen) {
    const styles = {
      pets:     'Style of George Stubbs — regal animal portrait, ermine-trimmed royal mantle, dark stone architectural background, warm directional lighting, visible impasto brushwork',
      family:   'Style of Joshua Reynolds — formal 18th century family group portrait, men in velvet frock coats, women in silk brocade gowns, red velvet curtain background, warm candlelit atmosphere',
      children: 'Style of Thomas Lawrence — formal 18th century child portrait, opulent velvet robes with lace trim, gold coronet, dark warm background, warm glowing light',
      couples:  'Style of John Singer Sargent — intimate Victorian aristocratic oil portrait, man in dark frock coat with white cravat, woman in dark velvet gown with lace collar, dark painterly background',
      self:     'Style of Joshua Reynolds — formal 18th century self-portrait, period aristocratic attire, dark warm background, warm side lighting, visible brushwork',
    };
    return styles[cat] || styles.self;
  }

  function buildPrompt(description, styleCore, cat, gen, isMulti) {
    const styleBase = styleCore || getDefaultStyle(cat, gen);
    const prefix = isMulti || cat === 'couples' || cat === 'family'
      ? `Formal aristocratic group oil painting portrait of ${description}.`
      : cat === 'pets'
        ? `Regal aristocratic oil painting portrait of ${description}.`
        : `Formal aristocratic oil painting portrait of ${description}.`;
    return `${prefix} ${styleBase}. No picture frame, no border. Museum-quality oil painting, rich painterly brushwork, dramatic lighting, dark background.`;
  }

  console.log('[generate] category:', category, '| gender:', effectiveGender, '| multi:', isMultiSubject);

  try {
    const description = buildDescription(category, effectiveGender, isMultiSubject);
    const fullPrompt = buildPrompt(description, stylePrompt, category, effectiveGender, isMultiSubject);
    console.log('[generate] prompt:', fullPrompt.substring(0, 200));

    // Call DALL-E 3
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: fullPrompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
        quality: 'hd',
      }),
    });

    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e?.error?.message || 'OpenAI API HTTP ' + r.status);
    }

    const data = await r.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error('DALL-E did not return an image');

    // Printify upload (optional)
    let printifyImageId = null, printifyImageUrl = null;
    const PK = process.env.PRINTIFY_API_KEY, PS = process.env.PRINTIFY_SHOP_ID;
    if (PK && PS) {
      try {
        const pRes = await fetch('https://api.printify.com/v1/uploads/images.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PK}` },
          body: JSON.stringify({ file_name: `portrait-${category}-${Date.now()}.jpg`, contents: b64 }),
        });
        if (pRes.ok) {
          const p = await pRes.json();
          printifyImageId = p.id;
          printifyImageUrl = p.preview_url || p.url || null;
        }
      } catch (e) { console.error('Printify error:', e.message); }
    }

    return res.status(200).json({
      imageData: `data:image/png;base64,${b64}`,
      printifyImageId,
      printifyImageUrl,
      portraitImageUrl: printifyImageUrl || null,
    });

  } catch (err) {
    console.error('[generate] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
