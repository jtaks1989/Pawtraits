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
  } = req.body;

  if (!imageBase64 || !category) return res.status(400).json({ error: 'Missing fields: imageBase64 and category are required' });

  const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
  if (!REPLICATE_KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not configured' });

  function buildPrompt(baseStylePrompt, cat, gen, count) {
    let prompt = baseStylePrompt || getDefaultPrompt(cat, gen, count);

    if ((cat === 'self' || (cat !== 'pets' && count === 1)) && gen) {
      if (gen === 'male') {
        prompt = prompt
          .replace(/in a dress|wearing a dress|gown(?! with white lace collar)/g, 'in a velvet frock coat with gold buttons and white cravat')
          .replace(/feminine attire/g, 'formal masculine aristocratic attire');
        prompt = 'Male subject. ' + prompt + '. Subject is male — dress in masculine aristocratic attire: velvet coat, breeches, white cravat or shirt, no dress or feminine clothing.';
      } else if (gen === 'female') {
        prompt = prompt
          .replace(/frock coat|velvet coat/g, 'silk brocade gown')
          .replace(/white cravat/g, 'pearl jewellery and lace trim');
        prompt = 'Female subject. ' + prompt + '. Subject is female — dress in elegant feminine aristocratic attire: silk or velvet gown, pearls, lace.';
      }
    }

    if (count > 1) {
      prompt += `. IMPORTANT: The reference image contains ${count} separate people shown side-by-side. The final portrait MUST show ALL ${count} people together in a single group composition — do not omit anyone. Each person should be visible and given equal prominence in the painting.`;
    }

    return prompt;
  }

  function getDefaultPrompt(cat, gen, count) {
    const isMale   = gen === 'male';
    const isFemale = gen === 'female';

    const defaultPrompts = {
      pets:     'a regal aristocratic oil painting portrait of this pet, posed on a dark embroidered velvet cushion, draped in an ermine-trimmed royal mantle, dark stone architectural background with a column, painted in the style of George Stubbs, warm directional lighting, museum-quality oil painting, visible brushwork, 18th century masterpiece',
      family:   'a formal 18th century aristocratic oil painting group portrait, subjects wearing period attire, men in embroidered velvet frock coats, women in silk brocade gowns with pearl jewellery and lace trim, rich red velvet curtain in background, painted in the style of Joshua Reynolds and Thomas Gainsborough, warm candlelit atmosphere, museum-quality oil painting',
      children: 'a formal 18th century aristocratic portrait painting of this child, wearing opulent velvet robes with lace trim and a small gold coronet, soft rosy cheeks, holding a small flower, dark warm background, painted in the style of Thomas Lawrence, warm glowing light, museum-quality oil painting, visible brushwork',
      couples:  'a formal Victorian-era aristocratic oil painting portrait of this couple, man in dark formal frock coat with white shirt, woman in rich dark velvet gown with white lace collar and decorative cameo brooch, dark brown painterly background, painted in the style of John Singer Sargent, warm directional side lighting, museum-quality oil painting',
      self:     isMale
        ? 'a formal 18th century aristocratic oil painting self-portrait of a male subject, wearing a rich velvet coat with gold buttons and white cravat, masculine aristocratic attire, three-quarter view, gazing directly at viewer, dark warm background, painted in the style of Joshua Reynolds and Thomas Gainsborough, warm side lighting, museum-quality oil painting, visible brushwork'
        : isFemale
          ? 'a formal 18th century aristocratic oil painting self-portrait of a female subject, wearing an elegant silk brocade gown with pearl jewellery and lace trim, feminine aristocratic attire, three-quarter view, gazing directly at viewer, dark warm background, painted in the style of Thomas Gainsborough and Joshua Reynolds, warm side lighting, museum-quality oil painting, visible brushwork'
          : 'a formal 18th century aristocratic oil painting self-portrait, subject wearing appropriate period aristocratic attire, three-quarter view, gazing directly at viewer with quiet confidence, dark warm background, painted in the style of Joshua Reynolds and Thomas Gainsborough, warm side lighting, museum-quality oil painting, visible brushwork',
    };

    return defaultPrompts[cat] || defaultPrompts.self;
  }

  const negativePrompt = 'modern clothing, photograph, photorealistic, digital art, cartoon, anime, 3d render, ugly, deformed, blurry, low quality, watermark, text, modern background, contemporary, casual clothes, wrong gender clothing, dress on male, masculine attire on female';

  const prompt = buildPrompt(stylePrompt, category, gender, photoCount || 1);
  console.log('Generation prompt:', prompt.substring(0, 150) + '...');

  try {
    const imageDataUrl = `data:${imageMimeType};base64,${imageBase64}`;

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
          ip_adapter_scale: 0.85,
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
      imageData:        `data:image/jpeg;base64,${b64}`,
      printifyImageId,
      printifyImageUrl,
      portraitImageUrl,
    });

  } catch (err) {
    console.error('generate error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
