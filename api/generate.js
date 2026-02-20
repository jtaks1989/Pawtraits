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

  // ─── Determine subject context ────────────────────────────────────────────
  const count = photoCount || 1;
  const isGroup  = category === 'family' || category === 'couples';
  const isPet    = category === 'pets';
  const isChild  = category === 'children';

  // Resolve effective gender
  // - couples/family always → mixed/group (never single-gender override)
  // - auto/null → let the style prompt and model decide (don't inject gender text)
  const effectiveGender = isGroup ? 'mixed'
    : (gender && gender !== 'auto') ? gender
    : null;

  // ─── Build subject opening line ───────────────────────────────────────────
  // This goes at the very START of the prompt so the model reads it first.
  function buildSubjectLine(cat, gen, count, isMulti) {
    if (cat === 'pets') {
      return 'A single animal subject (pet).';
    }
    if (cat === 'children') {
      return 'A single child subject.';
    }
    if (cat === 'couples' || cat === 'family' || isMulti || count > 1) {
      const n = count > 1 ? count : 2;
      return `CRITICAL: This is a GROUP PORTRAIT of EXACTLY ${n} people. The reference image shows ${n} people side-by-side. The final painting MUST include ALL ${n} people together — both faces must be clearly visible and given equal prominence. Do NOT paint only one person. Do NOT drop any subject. Paint a formal dual-subject / group composition.`;
    }
    if (gen === 'male') {
      return 'IMPORTANT: Subject is MALE. Paint as a man with masculine features. Do NOT paint as a woman. Use masculine aristocratic attire: velvet frock coat, breeches, white cravat or jabot — absolutely no dress, gown, or feminine clothing on this subject.';
    }
    if (gen === 'female') {
      return 'IMPORTANT: Subject is FEMALE. Paint as a woman with feminine features. Use feminine aristocratic attire: silk or velvet gown, pearl jewellery, lace trim collar or cuffs.';
    }
    // auto/null — no gender injection, let style + image speak
    return 'A single portrait subject.';
  }

  // ─── Get fallback base prompt (when no stylePrompt passed) ────────────────
  function getDefaultPrompt(cat, gen) {
    const isMale   = gen === 'male';
    const isFemale = gen === 'female';

    const attire = isMale
      ? 'rich velvet frock coat with gold buttons and white cravat, breeches, masculine aristocratic attire'
      : isFemale
        ? 'elegant silk brocade gown with pearl jewellery and lace trim, feminine aristocratic attire'
        : 'appropriate period aristocratic attire';

    const prompts = {
      pets:
        'regal aristocratic oil painting portrait of this pet, posed on a dark embroidered velvet cushion, draped in an ermine-trimmed royal mantle, dark stone architectural background with a column, painted in the style of George Stubbs, warm directional lighting, museum-quality oil painting, visible brushwork, 18th century masterpiece',
      family:
        'formal 18th century aristocratic oil painting group portrait, all subjects wearing period attire — men in embroidered velvet frock coats, women in silk brocade gowns with pearl jewellery and lace trim — rich red velvet curtain background, painted in the style of Joshua Reynolds and Thomas Gainsborough, warm candlelit atmosphere, museum-quality oil painting',
      children:
        'formal 18th century aristocratic portrait painting of this child, wearing opulent velvet robes with lace trim and a small gold coronet, soft rosy cheeks, holding a small flower, dark warm background, painted in the style of Thomas Lawrence, warm glowing light, museum-quality oil painting, visible brushwork',
      couples:
        'formal Victorian-era aristocratic oil painting portrait of a couple — man in dark formal frock coat with white cravat, woman in rich dark velvet gown with white lace collar and decorative cameo brooch — both subjects clearly visible, dark brown painterly background, painted in the style of John Singer Sargent, warm directional side lighting, museum-quality oil painting',
      self:
        `formal 18th century aristocratic oil painting self-portrait, subject wearing ${attire}, three-quarter view, gazing directly at viewer with quiet confidence, dark warm background, painted in the style of Joshua Reynolds and Thomas Gainsborough, warm side lighting, museum-quality oil painting, visible brushwork`,
    };

    return prompts[cat] || prompts.self;
  }

  // ─── Assemble final prompt ─────────────────────────────────────────────────
  function buildPrompt(baseStylePrompt, cat, gen, count, isMulti) {
    const subjectLine = buildSubjectLine(cat, gen, count, isMulti);
    const corestyle   = baseStylePrompt || getDefaultPrompt(cat, gen);

    // For multi-subject: append a strong composition instruction at the end too
    const isMultiSubject = cat === 'couples' || cat === 'family' || isMulti || count > 1;
    const multiTail = isMultiSubject
      ? ` The composition must show ALL subjects side by side, both clearly painted with full face detail. This is a double portrait — do not reduce to one person.`
      : '';

    // For male subjects: append a clothing enforcement line at the end
    const genderTail = (!isMultiSubject && gen === 'male')
      ? ` The subject must be dressed in masculine attire only — velvet coat, breeches, cravat. Absolutely no dress, skirt, or gown.`
      : (!isMultiSubject && gen === 'female')
        ? ` The subject must be dressed in feminine aristocratic attire — silk or velvet gown, pearls, lace.`
        : '';

    return `${subjectLine} ${corestyle}${multiTail}${genderTail}`;
  }

  // ─── Negative prompt (strong gender + quality enforcement) ─────────────────
  function buildNegativePrompt(gen, isMultiSubject) {
    const base = 'modern clothing, photograph, photorealistic render, digital art, cartoon, anime, 3d render, ugly, deformed, blurry, low quality, watermark, text, modern background, contemporary setting, casual clothes';
    const genderNeg = (!isMultiSubject && gen === 'male')
      ? ', dress on male, gown on male, feminine attire on male subject, skirt on male, woman instead of man'
      : (!isMultiSubject && gen === 'female')
        ? ', masculine attire on female, man instead of woman'
        : '';
    const multiNeg = isMultiSubject
      ? ', single person only, one face, solo portrait, cropped to one subject'
      : '';
    return base + genderNeg + multiNeg;
  }

  const isMultiSubject = category === 'couples' || category === 'family' || isMultiPhoto || count > 1;

  const prompt         = buildPrompt(stylePrompt, category, effectiveGender, count, isMultiPhoto);
  const negativePrompt = buildNegativePrompt(effectiveGender, isMultiSubject);

  console.log('[generate] category:', category, '| gender:', effectiveGender, '| count:', count, '| isMultiPhoto:', isMultiPhoto);
  console.log('[generate] prompt:', prompt.substring(0, 200) + '...');

  try {
    const imageDataUrl = `data:${imageMimeType};base64,${imageBase64}`;

    // Tune IP adapter scale:
    // - Higher (0.9) for single subjects → stronger face transfer
    // - Slightly lower (0.75) for multi-subject → gives model more room to compose both faces
    const ipAdapterScale = isMultiSubject ? 0.75 : 0.90;

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
          controlnet_conditioning_scale: 0.8,
          num_inference_steps: 30,
          guidance_scale: 7.5,
          width: 768,
          height: 1024,
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

    // ─── Printify upload (optional) ──────────────────────────────────────────
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
