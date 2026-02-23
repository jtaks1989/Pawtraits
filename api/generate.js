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

  // Build subject description from category/gender (no vision step needed)
  function buildDescription(cat, gen, isMulti) {
    if (isMulti) return 'a man and a woman together';
    if (cat === 'pets') return 'a beloved pet animal';
    if (cat === 'children') return 'a young child';
    if (cat === 'family') return 'a family group';
    if (cat === 'couples') return 'a couple, a man and a woman';
    if (gen === 'male') return 'a man';
    if (gen === 'female') return 'a woman';
    return 'a person';
  }

  // Build final Imagen 3 prompt
  function buildPortraitPrompt(description, styleCore, cat, gen, isMulti) {
    const styleBase = styleCore || getDefaultStyle(cat, gen);
    const subjectPrefix = isMulti
      ? `Formal aristocratic group oil painting portrait of ${description}.`
      : cat === 'pets'
        ? `Regal aristocratic oil painting portrait of ${description}.`
        : `Formal aristocratic oil painting portrait of ${description}.`;
    return `${subjectPrefix} ${styleBase}. No picture frame, no border around the image. Museum-quality oil painting, rich painterly brushwork, dramatic lighting.`;
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

  // Generate portrait with Imagen 3
  async function generatePortrait(fullPrompt) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt: fullPrompt }],
          parameters: {
            sampleCount: 1,
            aspectRatio: '3:4',
            safetyFilterLevel: 'block_few',
            personGeneration: 'allow_adult',
          },
        }),
      }
    );
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e?.error?.message || 'Imagen API HTTP ' + r.status);
    }
    const d = await r.json();
    const b64 = d?.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) {
      console.error('Imagen response:', JSON.stringify(d).substring(0, 500));
      throw new Error('Imagen did not return an image');
    }
    return b64;
  }

  console.log('[generate] category:', category, '| gender:', effectiveGender, '| multi:', isMultiSubject);

  try {
    const description = buildDescription(category, effectiveGender, isMultiSubject);
    const fullPrompt = buildPortraitPrompt(description, stylePrompt, category, effectiveGender, isMultiSubject);
    console.log('[generate] prompt:', fullPrompt.substring(0, 200));

    const b64 = await generatePortrait(fullPrompt);

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
