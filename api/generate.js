module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    imageBase64,
    imageMimeType = 'image/jpeg',
    category,
    catLabel,
    style,
    stylePrompt,
    gender,
    photoCount,
    isMultiPhoto,
  } = req.body;

  if (!imageBase64 || !category) {
    return res.status(400).json({ error: 'Missing fields: imageBase64 and category are required' });
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const count      = photoCount || 1;
  const isGroup    = category === 'family' || category === 'couples';
  const isMultiSubject = isGroup || isMultiPhoto || count > 1;
  const effectiveGender = isGroup ? 'mixed'
    : (gender && gender !== 'auto') ? gender
    : null;

  function buildGeminiPrompt(baseStylePrompt, cat, gen, isMultiSubject) {
    const styleCore = baseStylePrompt || getDefaultPrompt(cat, gen);

    const subjectCtx = isMultiSubject
      ? 'Transform ALL people visible in this photo into a formal aristocratic oil painting portrait. Paint every person shown — do not omit anyone. Compose them together naturally as a group portrait.'
      : cat === 'pets'
        ? 'Transform this pet into a regal aristocratic oil painting portrait.'
        : gen === 'male'
          ? 'Transform this man into a formal aristocratic oil painting portrait. Paint as a man in masculine period attire.'
          : gen === 'female'
            ? 'Transform this woman into a formal aristocratic oil painting portrait. Paint as a woman in feminine period attire.'
            : 'Transform the person in this photo into a formal aristocratic oil painting portrait.';

    return `${subjectCtx} ${styleCore}. Preserve the facial features and likeness of every person from the photo. Output ONLY the finished painting — no frames, no borders, no modern backgrounds. The result must look like a genuine museum-quality oil painting.`;
  }

  function getDefaultPrompt(cat, gen) {
    const prompts = {
      pets:     'Paint in the style of George Stubbs — regal animal portrait, ermine-trimmed royal mantle, dark architectural background, warm directional lighting, visible impasto brushwork',
      family:   'Paint in the style of Joshua Reynolds — formal 18th century family group portrait, men in velvet frock coats, women in silk brocade gowns, red velvet curtain background, warm candlelit atmosphere',
      children: 'Paint in the style of Thomas Lawrence — formal 18th century child portrait, opulent velvet robes with lace trim, gold coronet, dark warm background, warm glowing light',
      couples:  'Paint in the style of John Singer Sargent — intimate Victorian aristocratic portrait, man in dark frock coat with white cravat, woman in dark velvet gown with lace collar, dark painterly background',
      self:     'Paint in the style of Joshua Reynolds — formal 18th century self-portrait, period aristocratic attire, dark warm background, warm side lighting, visible brushwork',
    };
    return prompts[cat] || prompts.self;
  }

  const prompt = buildGeminiPrompt(stylePrompt, category, effectiveGender, isMultiSubject);

  console.log('[generate] category:', category, '| gender:', effectiveGender, '| multi:', isMultiSubject);
  console.log('[generate] prompt:', prompt.substring(0, 200));

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: imageMimeType, data: imageBase64 } },
            ],
          }],
          generationConfig: {
           responseModalities: ['TEXT', 'IMAGE'],
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const e = await geminiRes.json().catch(() => ({}));
      throw new Error(e?.error?.message || `Gemini API HTTP ${geminiRes.status}`);
    }

    const geminiData = await geminiRes.json();
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inline_data?.data);

    if (!imagePart) {
      console.error('[generate] Gemini response:', JSON.stringify(geminiData).substring(0, 500));
      throw new Error('Gemini did not return an image. Check your API key and model access.');
    }

    const b64 = imagePart.inline_data.data;
    const mimeType = imagePart.inline_data.mime_type || 'image/jpeg';

    let printifyImageId = null, printifyImageUrl = null;
    const PK = process.env.PRINTIFY_API_KEY, PS = process.env.PRINTIFY_SHOP_ID;
    if (PK && PS) {
      try {
        const pRes = await fetch('https://api.printify.com/v1/uploads/images.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PK}` },
          body: JSON.stringify({
            file_name: `portrait-${category}-${Date.now()}.jpg`,
            contents: b64,
          }),
        });
        if (pRes.ok) {
          const p = await pRes.json();
          printifyImageId = p.id;
          printifyImageUrl = p.preview_url || p.url || null;
        }
      } catch (e) {
        console.error('Printify upload error:', e.message);
      }
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
