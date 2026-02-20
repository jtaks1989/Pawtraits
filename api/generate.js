module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageMimeType = 'image/jpeg', category, catLabel, style, stylePrompt } = req.body;
  if (!imageBase64 || !category) return res.status(400).json({ error: 'Missing fields' });

  const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
  if (!REPLICATE_KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not configured' });

  const identityMap = {
    pets:     "The animal's face, breed, fur colour and distinctive markings must match the reference photo exactly. Every unique feature preserved.",
    family:   "Every person's face must be an exact likeness of the reference. Preserve facial structure, skin tone, hair colour and features for all subjects.",
    children: "The child's face must be an exact likeness of the reference. Preserve facial structure, eye colour and hair.",
    couples:  "Both people's faces must be exact likenesses. Preserve facial structure, skin tone, hair colour for each person.",
    self:     "The person's face must be an exact likeness of the reference. Preserve all facial features, structure and skin tone.",
  };

  const defaultStyle = {
    pets:     'formal 18th century aristocratic oil painting. Pet posed on embroidered velvet cushion draped in ermine-trimmed mantle. Stone column background. Style of George Stubbs.',
    family:   'formal 18th century aristocratic group portrait. Velvet frock coat, silk brocade gown, pearl jewellery. Red velvet curtain background. Style of Joshua Reynolds and Gainsborough.',
    children: 'formal 18th century aristocratic child portrait. Velvet robes, gold coronet, lace trim. Warm glowing light. Style of Thomas Lawrence.',
    couples:  'formal Victorian aristocratic couple portrait. Dark velvet, lace collar, dark painterly background. Style of John Singer Sargent.',
    self:     'formal 18th century aristocratic self-portrait. Rich velvet coat, white cravat, three-quarter view. Style of Joshua Reynolds.',
  };

  const artStyle = stylePrompt || defaultStyle[category] || defaultStyle.self;
  const identity = identityMap[category] || identityMap.self;

  const prompt = `${artStyle}. ${identity} Museum-quality oil painting with warm old-master directional lighting, visible painterly brushwork in background, extreme facial detail and accuracy. Do not alter the subject's age, gender, race or facial structure. Ultra-realistic identity preservation.`;

  const negativePrompt = 'modern clothing, photograph, photorealistic, digital art, cartoon, anime, 3d render, deformed, ugly, blurry, low quality, watermark, text, contemporary setting, casual clothes, neon, plastic, sunglasses, phone, pop art, stock photo, changed face, different person';

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
          image:                         imageDataUrl,
          prompt,
          negative_prompt:               negativePrompt,
          ip_adapter_scale:              0.85,
          controlnet_conditioning_scale: 0.8,
          num_inference_steps:           35,
          guidance_scale:                7.5,
          width:                         640,
          height:                        832,
          seed:                          -1,
        },
      }),
    });

    if (!startRes.ok) {
      const e = await startRes.json().catch(() => ({}));
      throw new Error(e?.detail || e?.error || `Replicate API HTTP ${startRes.status}`);
    }

    let prediction = await startRes.json();

    const maxWait = 120000, pollInterval = 2500, startTime = Date.now();

    while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled') {
      if (Date.now() - startTime > maxWait) throw new Error('Generation timed out. Please try again.');
      await new Promise(r => setTimeout(r, pollInterval));
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` },
      });
      prediction = await pollRes.json();
    }

    if (prediction.status !== 'succeeded') throw new Error(prediction.error || 'Generation failed');

    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!outputUrl) throw new Error('No image returned from Replicate');

    const imgRes = await fetch(outputUrl);
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
          body: JSON.stringify({ file_name: `portrait-${category}-${style||'default'}-${Date.now()}.jpg`, contents: b64 }),
        });
        if (pRes.ok) { const p = await pRes.json(); printifyImageId = p.id; printifyImageUrl = p.preview_url || p.url; }
      } catch (e) { console.error('Printify error:', e.message); }
    }

    return res.status(200).json({ imageData: `data:image/jpeg;base64,${b64}`, printifyImageId, printifyImageUrl });

  } catch (err) {
    console.error('generate error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
