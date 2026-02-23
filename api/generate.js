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

  const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
  if (!REPLICATE_KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not configured' });

  const isGroup = category === 'family' || category === 'couples';
  const isMultiSubject = isGroup || isMultiPhoto || (photoCount || 1) > 1;
  const effectiveGender = isGroup ? 'mixed'
    : (gender && gender !== 'auto') ? gender : null;

  function getDefaultStyle(cat, gen) {
    const styles = {
      pets:     'regal oil painting portrait, style of George Stubbs, ermine-trimmed royal mantle, dark stone architectural background, warm directional lighting, visible impasto brushwork, museum-quality',
      family:   'formal 18th century oil painting, style of Joshua Reynolds, men in velvet frock coats, women in silk brocade gowns, red velvet curtain background, warm candlelit atmosphere, museum-quality',
      children: 'formal 18th century child portrait, style of Thomas Lawrence, opulent velvet robes with lace trim, gold coronet, dark warm background, warm glowing light, museum-quality oil painting',
      couples:  'intimate Victorian aristocratic oil portrait, style of John Singer Sargent, man in dark frock coat with white cravat, woman in dark velvet gown with lace collar, dark painterly background, museum-quality',
      self:     'formal 18th century aristocratic oil painting, style of Joshua Reynolds and Gainsborough, period attire, dark warm background, warm side lighting, visible brushwork, museum-quality',
    };
    return styles[cat] || styles.self;
  }

  function buildPrompt(styleCore, cat, gen, isMulti) {
    const styleBase = styleCore || getDefaultStyle(cat, gen);
    const genderWord = gen === 'male' ? 'man' : gen === 'female' ? 'woman' : 'person';
    const subject = isMulti ? 'couple img' : cat === 'pets' ? 'pet' : `${genderWord} img`;
    return `oil painting portrait of a ${subject}, ${styleBase}, no frame, no border`;
  }

  function buildNegative() {
    return 'modern clothing, photograph, photorealistic, digital art, cartoon, anime, ugly, deformed, blurry, low quality, watermark, text, frame, border, picture frame';
  }

  const prompt = buildPrompt(stylePrompt, category, effectiveGender, isMultiSubject);
  const negativePrompt = buildNegative();

  console.log('[generate] category:', category, '| gender:', effectiveGender);
  console.log('[generate] prompt:', prompt.substring(0, 200));

  try {
    const imageDataUrl = `data:${imageMimeType};base64,${imageBase64}`;

    // Use model endpoint directly — no version hash needed, always uses latest
    const startRes = await fetch('https://api.replicate.com/v1/models/tencentarc/photomaker-style/predictions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${REPLICATE_KEY}`,
        'Prefer': 'wait=60',
      },
      body: JSON.stringify({
        input: {
          prompt,
          negative_prompt: negativePrompt,
          input_image: imageDataUrl,
          num_steps: 50,
          style_strength_ratio: 35,
          guidance_scale: 5,
          num_outputs: 1,
          style_name: 'Photographic (Default)',
          disable_safety_checker: true,
        },
      }),
    });

    if (!startRes.ok) {
      const e = await startRes.json().catch(() => ({}));
      throw new Error(e?.detail || e?.error || 'Replicate HTTP ' + startRes.status);
    }

    let prediction = await startRes.json();

    // Poll until done
    const maxWait = 120000;
    const startTime = Date.now();
    while (
      prediction.status !== 'succeeded' &&
      prediction.status !== 'failed' &&
      prediction.status !== 'canceled'
    ) {
      if (Date.now() - startTime > maxWait) throw new Error('Generation timed out. Please try again.');
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` },
      });
      prediction = await pollRes.json();
    }

    if (prediction.status !== 'succeeded') {
      throw new Error(prediction.error || 'Generation failed');
    }

    const imageUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!imageUrl) throw new Error('No image returned');

    // Fetch image and convert to base64
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error('Failed to fetch generated image');
    const imgBuffer = await imgRes.arrayBuffer();
    const b64 = Buffer.from(imgBuffer).toString('base64');

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
      imageData: `data:image/jpeg;base64,${b64}`,
      printifyImageId,
      printifyImageUrl,
      portraitImageUrl: printifyImageUrl || null,
    });

  } catch (err) {
    console.error('[generate] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
