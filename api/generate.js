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

  // Prompts tuned to match Surrealium-style hyperrealistic classical oil portraits.
  // InstantID preserves the real face — prompts only need to describe
  // the clothing, background, lighting and painting style.
  function buildPrompt(styleCore, cat, gen, isMulti) {

    if (styleCore) return styleCore;

    if (isMulti || cat === 'couples') {
      return `a hyperrealistic classical oil painting of a couple, 
        man wearing an elegant dark double-breasted frock coat with white cravat and high collar, 
        woman wearing a beautiful period silk gown with lace trim at neckline, 
        seated together in an intimate pose in a lush dark forest landscape with rocky outcrops, 
        dramatic moody sky with golden light breaking through clouds, 
        warm candlelit chiaroscuro lighting, rich jewel-tone palette of deep charcoal amber ivory gold, 
        painted in the masterful style of Joshua Reynolds and John Constable, 
        photorealistic faces, luminous glowing skin tones, 
        museum-quality oil painting, 8k ultra detailed`;
    }

    if (cat === 'family') {
      return `a hyperrealistic classical oil painting family group portrait, 
        men wearing dark formal frock coats with white cravats, 
        women wearing elegant silk brocade gowns with lace trim, 
        grand interior with red velvet drapes and warm candlelight, 
        painted in the style of Joshua Reynolds, 
        photorealistic faces, luminous skin tones, masterpiece, 8k`;
    }

    if (cat === 'pets') {
      return `a hyperrealistic classical oil painting portrait of a noble pet 
        wearing a miniature ermine-trimmed royal mantle, 
        dark stone architectural background with warm amber lighting, 
        dramatic side lighting, painted in the style of George Stubbs, 
        rich warm palette of deep brown gold ivory, masterpiece, 8k`;
    }

    if (cat === 'children') {
      return `a hyperrealistic classical oil painting portrait of a child, 
        wearing opulent velvet robes with intricate lace trim and a small gold coronet, 
        dark warm background with soft glowing light, 
        painted in the style of Thomas Lawrence, 
        photorealistic face, luminous skin tones, masterpiece, 8k`;
    }

    // self portrait
    if (gen === 'female') {
      return `a hyperrealistic classical oil painting portrait of a woman, 
        wearing an elegant empire-waist silk gown with delicate lace trim at the décolletage, 
        pearl drop earrings, hair pinned up with soft curls framing the face, 
        lush romantic landscape background with trees and a golden atmospheric sky, 
        warm soft diffused lighting from the left, deep rich shadows, 
        painted in the exquisite style of Elisabeth Vigée Le Brun and Thomas Gainsborough, 
        photorealistic face, luminous glowing skin, 
        cream ivory sage green warm gold palette, masterpiece, 8k`;
    }

    // male self portrait (default)
    return `a hyperrealistic classical oil painting portrait of a man, 
      wearing a dark navy wool tailcoat with velvet lapels and a crisp white linen cravat tied at the throat, 
      dramatic rocky forest landscape background with atmospheric depth and moody dark sky, 
      dramatic Rembrandt side lighting from upper left casting deep warm shadows, 
      painted in the masterful style of Sir Thomas Lawrence and Joshua Reynolds, 
      photorealistic face and skin, luminous warm skin tones, confident half-body composition, 
      slight three-quarter pose, deep forest green umber charcoal palette, masterpiece, 8k`;
  }

  function buildNegative(gen, isMulti) {
    return [
      'modern clothing', 'suit and tie', 'tuxedo', 'bow tie', 'contemporary fashion',
      'casual clothes', 'jeans', 't-shirt', 'hoodie',
      'cartoon', 'anime', '3d render', 'digital art', 'illustration',
      'ugly', 'deformed', 'distorted face', 'bad anatomy', 'extra limbs', 'floating limbs',
      'blurry', 'low quality', 'low resolution', 'jpeg artifacts',
      'watermark', 'text', 'logo', 'signature',
      'picture frame', 'ornate frame', 'decorative border', 'canvas border',
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

    // InstantID — locks onto the real face from the photo and composites it
    // photorealistically into the painted scene. This is how Surrealium works.
    const startRes = await fetch('https://api.replicate.com/v1/models/zsxkib/instant-id/predictions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${REPLICATE_KEY}`,
        'Prefer': 'wait=60',
      },
      body: JSON.stringify({
        input: {
          image: imageDataUrl,
          prompt,
          negative_prompt: negativePrompt,
          ip_adapter_scale: 0.8,       // face fidelity — high = more like the real person
          controlnet_conditioning_scale: 0.8,
          num_inference_steps: 30,
          guidance_scale: 7,
          width: 832,
          height: 1024,
          output_format: 'jpg',
          disable_safety_checker: true,
        },
      }),
    });

    if (!startRes.ok) {
      const e = await startRes.json().catch(() => ({}));
      throw new Error(e?.detail || e?.error || 'Replicate HTTP ' + startRes.status);
    }

    let prediction = await startRes.json();
    console.log('[generate] prediction started:', prediction.id, prediction.status);

    // Poll until done
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
      console.log('[generate] poll status:', prediction.status);
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
