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

  // Prompts engineered to match Surrealium-quality hyperrealistic classical oil portraits
  function buildPrompt(styleCore, cat, gen, isMulti) {

    // SELF PORTRAIT — male
    if ((cat === 'self' || cat === 'children') && gen === 'male') {
      return styleCore || `hyperrealistic classical oil painting portrait of a man, 
        wearing a dark navy wool tailcoat with velvet lapels, crisp white linen cravat tied at throat, 
        high collar shirt, painted in the style of Sir Thomas Lawrence and Joshua Reynolds, 
        rich dark forest and rocky landscape background with atmospheric depth, 
        dramatic Rembrandt side lighting from upper left, warm amber glow on face, 
        deep shadows, visible confident brushwork on clothing, 
        photorealistic face and skin, luminous skin tones, 
        half-body portrait composition, three-quarter pose, 
        dark olive and umber background palette, masterpiece, 8k`;
    }

    // SELF PORTRAIT — female
    if ((cat === 'self' || cat === 'children') && gen === 'female') {
      return styleCore || `hyperrealistic classical oil painting portrait of a woman, 
        wearing an elegant empire-waist silk gown with lace trim at décolletage, 
        pearl drop earrings, hair pinned up with loose curls framing face, 
        painted in the style of Elisabeth Vigée Le Brun and Thomas Gainsborough, 
        soft romantic landscape background with trees and golden sky, 
        warm diffused window light from left, soft shadows, 
        luminous skin tones, photorealistic face, 
        half-body portrait composition, slight three-quarter pose, 
        cream ivory and sage green palette, masterpiece, 8k`;
    }

    // COUPLES portrait
    if (isMulti || cat === 'couples') {
      return styleCore || `hyperrealistic classical oil painting portrait of a couple, 
        man wearing dark double-breasted frock coat with white cravat, 
        woman wearing elegant period silk gown with lace trim, 
        seated together in intimate pose, woman leaning toward man, hands together, 
        painted in the style of John Constable and Joshua Reynolds, 
        lush dark forest background with rocky outcrops and moody sky, 
        warm candlelit atmosphere, dramatic chiaroscuro lighting, 
        photorealistic faces, luminous skin tones, 
        rich jewel-tone palette of deep brown charcoal amber ivory, 
        masterpiece classical portrait, 8k`;
    }

    // FAMILY portrait
    if (cat === 'family') {
      return styleCore || `hyperrealistic classical oil painting group portrait of a family, 
        formal 18th century aristocratic attire, men in dark frock coats with white cravats, 
        women in silk brocade gowns with lace trim, children in period clothing, 
        painted in the style of Joshua Reynolds and Gainsborough, 
        grand interior setting with red velvet drapes and marble columns, 
        warm candlelit atmosphere, soft directional lighting, 
        photorealistic faces, luminous skin tones, masterpiece, 8k`;
    }

    // PETS portrait
    if (cat === 'pets') {
      return styleCore || `hyperrealistic classical oil painting portrait of a noble pet, 
        wearing a miniature ermine-trimmed royal mantle, 
        painted in the style of George Stubbs and Edwin Landseer, 
        dark stone architectural background with warm amber lighting, 
        dramatic side lighting, visible confident impasto brushwork, 
        rich warm palette of deep brown gold ivory, masterpiece, 8k`;
    }

    // DEFAULT fallback
    return styleCore || `hyperrealistic classical oil painting portrait, 
      formal aristocratic 18th century attire, period clothing, 
      dark warm painterly background, dramatic Rembrandt lighting, 
      photorealistic face, luminous skin tones, masterpiece, 8k`;
  }

  function buildNegative(gen, isMulti) {
    return [
      'modern clothing', 'contemporary', 'casual', 'jeans', 't-shirt',
      'photograph', 'photo', 'digital art', 'cartoon', 'anime', '3d render',
      'ugly', 'deformed', 'blurry', 'low quality', 'bad anatomy', 'extra limbs',
      'watermark', 'text', 'logo',
      'picture frame', 'ornate frame', 'decorative frame', 'border', 'mat',
      'overexposed', 'underexposed', 'washed out',
      (!isMulti && gen === 'male') ? 'dress, feminine clothing, woman' : '',
      (!isMulti && gen === 'female') ? 'masculine clothing, suit and tie, man' : '',
    ].filter(Boolean).join(', ');
  }

  const prompt = buildPrompt(stylePrompt, category, effectiveGender, isMultiSubject);
  const negativePrompt = buildNegative(effectiveGender, isMultiSubject);

  console.log('[generate] category:', category, '| gender:', effectiveGender, '| multi:', isMultiSubject);
  console.log('[generate] prompt:', prompt.substring(0, 250));

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
          ip_adapter_scale: 0.8,
          controlnet_conditioning_scale: 0.7,
          num_inference_steps: 40,
          guidance_scale: 7.5,
          width: 768,
          height: 1024,
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
