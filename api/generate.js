module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    imageBase64,
    imageMimeType = 'image/jpeg',
    category,
    stylePrompt,
    gender,
    photoCount,
    isMultiPhoto,
  } = req.body;

  if (!imageBase64 || !category) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

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

    // gemini-2.0-flash-exp-image-generation with TEXT-only input = pure text-to-image
    // Works on standard Gemini API key, no Vertex AI / Cloud needed
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: fullPrompt }],
          }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
          },
        }),
      }
    );

    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e?.error?.message || 'Gemini API HTTP ' + r.status);
    }

    const data = await r.json();
    console.log('[generate] raw response keys:', JSON.stringify(data).substring(0, 300));

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inline_data?.data);

    if (!imagePart) {
      const textPart = parts.find(p => p.text);
      throw new Error('No image returned. Model said: ' + (textPart?.text?.substring(0, 200) || 'nothing'));
    }

    const b64 = imagePart.inline_data.data;
    const mimeType = imagePart.inline_data.mime_type || 'image/png';

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
      imageData: `data:${mimeType};base64,${b64}`,
      printifyImageId,
      printifyImageUrl,
      portraitImageUrl: printifyImageUrl || null,
    });

  } catch (err) {
    console.error('[generate] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
