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

  const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
  if (!REPLICATE_KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not configured' });

  const count = photoCount || 1;
  const isGroup = category === 'family' || category === 'couples';
  const isMultiSubject = isGroup || isMultiPhoto || count > 1;

  const effectiveGender = isGroup ? 'mixed'
    : (gender && gender !== 'auto') ? gender
    : null;

  function buildSubjectLine(cat, gen, isMulti, count) {
    if (cat === 'pets' || cat === 'children') return '';
    if (cat === 'couples' || cat === 'family' || isMulti || count > 1) {
      const n = count > 1 ? count : 2;
      return `group portrait of ${n} people,`;
    }
    if (gen === 'male')   return 'portrait of a man,';
    if (gen === 'female') return 'portrait of a woman,';
    return '';
  }

  function getDefaultPrompt(cat, gen) {
    const attire = gen === 'male'
      ? 'dark velvet frock coat, white cravat'
      : gen === 'female'
        ? 'silk brocade gown, pearl jewellery, lace trim'
        : 'period aristocratic attire';
    const prompts = {
      pets:     'regal aristocratic oil painting of a pet, ermine-trimmed royal mantle, dark stone architectural background, style of George Stubbs, warm directional lighting, visible brushwork',
      family:   'formal 18th century aristocratic group oil painting, velvet frock coats, silk brocade gowns, red velvet curtain background, style of Joshua Reynolds, warm candlelit atmosphere',
      children: 'formal 18th century aristocratic portrait of a child, opulent velvet robes, lace trim, gold coronet, style of Thomas Lawrence, warm glowing light, visible brushwork',
      couples:  'formal Victorian aristocratic oil painting of a couple, man in dark frock coat with white cravat, woman in dark velvet gown with lace collar, dark painterly background, style of John Singer Sargent',
      self:     `formal 18th century aristocratic oil painting, ${attire}, three-quarter view, dark warm background, style of Joshua Reynolds and Gainsborough, warm side lighting, visible brushwork`,
    };
    return prompts[cat] || prompts.self;
  }

  function buildPrompt(baseStylePrompt, cat, gen, count, isMulti) {
    const subjectLine = buildSubjectLine(cat, gen, isMulti, count);
    const coreStyle   = baseStylePrompt || getDefaultPrompt(cat, gen);

    const genderTail = (!isMultiSubject && gen === 'male')
      ? ', masculine aristocratic attire, dark coat, white cravat, no dress no gown'
      : (!isMultiSubject && gen === 'female')
        ? ', feminine aristocratic attire, silk gown, pearls, lace'
        : '';

    const groupTail = isMultiSubject
      ? ', both people clearly visible, side by side, equal prominence, full bodies shown'
      : '';

    return [subjectLine, coreStyle, genderTail, groupTail].filter(Boolean).join(' ');
  }

  function buildNegativePrompt(gen, isMultiSubject) {
    const base = [
      'picture frame', 'ornate frame', 'decorative frame', 'canvas frame', 'painting frame',
      'border', 'gilded frame', 'frame around painting', 'framed artwork',
      'modern clothing', 'photograph', 'photorealistic render', 'digital art', 'cartoon',
      'anime', '3d render', 'ugly', 'deformed', 'blurry', 'low quality', 'watermark', 'text',
      'modern background', 'contemporary', 'casual clothes',
    ].join(', ');

    const genderNeg = (!isMultiSubject && gen === 'male')
      ? ', dress on male, gown on male, feminine clothing on man, woman instead of man'
      : (!isMultiSubject && gen === 'female')
        ? ', masculine attire on female, man instead of woman'
        : '';

    const multiNeg = isMultiSubject ? ', single person only, one face, solo portrait' : '';

    return base + genderNeg + multiNeg;
  }

  const prompt         = buildPrompt(stylePrompt, category, effectiveGender, count, isMultiPhoto);
  const negativePrompt = buildNegativePrompt(effectiveGender, isMultiSubject);

  console.log('[generate] category:', category, '| gender:', effectiveGender, '| count:', count, '| multi:', isMultiPhoto);
  console.log('[generate] prompt:', prompt.substring(0, 300));

  try {
    const imageDataUrl = `data:${imageMimeType};base64,${imageBase64}`;

    const ipAdapterScale  = isMultiSubject ? 0.55 : 0.85;
    const controlnetScale = isMultiSubject ? 0.65 : 0.80;
    const outputWidth     = isMultiSubject ? 1024 : 768;
    const outputHeight    = isMultiSubject ? 768  : 1024;

    const startRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${REPLICATE_KEY}`,
        'Prefer': 'wait=60',
      },
      body: JSON.stringify({
        version: '9cad10c7870bac9d6b587f406aef28208f964454abff5c4152f7dec9b0212a9a',
        input: {
          image: imageDataUrl,
          prompt,
          negative_prompt: negativePrompt,
          ip_adapter_scale: ipAdapterScale,
          controlnet_conditioning_scale: controlnetScale,
          num_inference_steps: 40,
          guidance_scale: 8.0,
          width: outputWidth,
          height: outputHeight,
        },
      }),
    });

    if (!startRes.ok) {
      const e = await startRes.json().catch(() => ({}));
      throw new Error(e?.detail || e?.error || `Replicate API HTTP ${startRes.status}`);
    }

    let prediction = await startRes.json();

    const maxWait = 120000;
    const pollInterval = 2000;
    const startTime = Date.now();

    while (
      prediction.status !== 'succeeded' &&
      prediction.status !== 'failed' &&
      prediction.status !== 'canceled'
    ) {
      if (Date.now() - startTime > maxWait) throw new Error('Generation timed out. Please try again.');
      await new Promise(r => setTimeout(r, pollInterval));
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` },
      });
      prediction = await pollRes.json();
    }

    if (prediction.status !== 'succeeded') {
      throw new Error(prediction.error || 'Generation failed');
    }

    const replicateImageUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!replicateImageUrl) throw new Error('No image returned from Replicate');

    const imgRes = await fetch(replicateImageUrl);
    if (!imgRes.ok) throw new Error('Failed to fetch generated image');
    const imgBuffer = await imgRes.arrayBuffer();
    const b64 = Buffer.from(imgBuffer).toString('base64');

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

    const portraitImageUrl = printifyImageUrl || replicateImageUrl;

    return res.status(200).json({
      imageData: `data:image/jpeg;base64,${b64}`,
      printifyImageId,
      printifyImageUrl,
      portraitImageUrl,
    });

  } catch (err) {
    console.error('[generate] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
