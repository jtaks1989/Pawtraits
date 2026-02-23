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

  function buildPrompt(styleCore, cat, gen, isMulti) {
    if (styleCore) return styleCore;

    if (isMulti || cat === 'couples') {
      return `hyperrealistic classical oil painting portrait of a couple, man wearing dark double-breasted frock coat with white cravat and high collar, woman wearing elegant period silk gown with lace trim at neckline, seated together in intimate pose, lush dark forest landscape with rocky outcrops and moody dramatic sky with golden light breaking through clouds, warm candlelit chiaroscuro lighting, painted in the masterful style of Joshua Reynolds and John Constable, photorealistic faces and skin, luminous glowing skin tones, rich jewel-tone palette deep charcoal amber ivory gold, museum-quality oil painting, 8k ultra detailed`;
    }

    if (cat === 'family') {
      return `hyperrealistic classical oil painting family group portrait, men wearing dark formal frock coats with white cravats, women wearing elegant silk brocade gowns with lace trim, grand interior with rich red velvet drapes and warm candlelight, painted in the style of Joshua Reynolds, photorealistic faces, luminous skin tones, museum-quality masterpiece, 8k`;
    }

    if (cat === 'pets') {
      return `hyperrealistic classical oil painting portrait of a noble pet wearing a miniature ermine-trimmed royal mantle, dark stone architectural background with warm amber directional lighting, dramatic side lighting, painted in the style of George Stubbs and Edwin Landseer, rich warm palette deep brown gold ivory, museum-quality masterpiece, 8k`;
    }

    if (cat === 'children') {
      return `hyperrealistic classical oil painting portrait of a child wearing opulent velvet robes with intricate lace trim and a small gold coronet, dark warm background with soft glowing light, painted in the style of Thomas Lawrence, photorealistic face, luminous skin tones, museum-quality masterpiece, 8k`;
    }

    if (gen === 'female') {
      return `hyperrealistic classical oil painting portrait of a woman wearing an elegant empire-waist silk gown with delicate lace trim at the décolletage, pearl drop earrings, hair pinned up with soft curls framing the face, lush romantic landscape background with trees and golden atmospheric sky, warm soft diffused lighting from the left, deep rich shadows, painted in the exquisite style of Elisabeth Vigée Le Brun and Thomas Gainsborough, photorealistic face, luminous glowing skin, cream ivory sage green warm gold palette, museum-quality masterpiece, 8k`;
    }

    return `hyperrealistic classical oil painting portrait of a man wearing a dark navy wool tailcoat with velvet lapels and a crisp white linen cravat tied at the throat, dramatic rocky forest landscape background with atmospheric depth and moody dark sky, dramatic Rembrandt side lighting from upper left casting deep warm amber shadows, painted in the masterful style of Sir Thomas Lawrence and Joshua Reynolds, photorealistic face and skin, luminous warm skin tones, confident half-body three-quarter pose, deep forest green umber charcoal palette, museum-quality masterpiece, 8k`;
  }

  function buildNegative(gen, isMulti) {
    return [
      'modern clothing', 'suit and tie', 'tuxedo', 'bow tie', 'contemporary fashion', 'casual clothes', 'jeans', 't-shirt',
      'cartoon', 'anime', '3d render', 'digital art', 'illustration',
      'ugly', 'deformed', 'distorted face', 'bad anatomy', 'extra limbs',
      'blurry', 'low quality', 'jpeg artifacts',
      'watermark', 'text', 'logo', 'signature',
      'picture frame', 'ornate frame', 'decorative border',
      'overexposed', 'washed out', 'flat lighting',
      (!isMulti && gen === 'male') ? 'dress, feminine clothing, woman, female' : '',
      (!isMulti && gen === 'female') ? 'masculine clothing, man, male' : '',
    ].filter(Boolean).join(', ');
  }

  const prompt = buildPrompt(stylePrompt, category, effectiveGender, isMultiSubject);
  const negativePrompt = buildNegative(effectiveGender, isMultiSubject);

  console.log('[generate] category:', category, '| gender:', effectiveGender, '| multi:', isMultiSubject);
  console.log('[generate] prompt:', prompt.substring(0, 250));

  try {
    const imageDataUrl = `data:${imageMimeType};base64,${imageBase64}`;

    // Using confirmed-working IP-Adapter version hash with improved prompts
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
          controlnet_conditioning_scale: 0.75,
          num_inference_steps: 40,
          guidance_scale: 8.5,
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
    console.log('[generate] prediction started:', prediction.id, prediction.status);

    const maxWait = 180000;
    const startTime = Date.now();
    while (
      prediction.status !== 'succeeded' &&
      prediction.status !== 'failed' &&
      prediction.status !== 'canceled'
    ) {
      if (Date.now() - startTime > maxWait) throw new Error('Generation timed out. Please try again.');
      await new Promise(r => setTimeout(r, 2500));
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` },
      });
      prediction = await pollRes.json();
      console.log('[generate] poll:', prediction.status);
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
