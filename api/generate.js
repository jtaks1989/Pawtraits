module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageMimeType = 'image/jpeg', category, catLabel } = req.body;
  if (!imageBase64 || !category) return res.status(400).json({ error: 'Missing fields' });

  const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
  if (!REPLICATE_KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not configured' });

  const stylePrompts = {
    pets:     'Transform this pet into a formal aristocratic oil painting portrait in the style of 18th century masters. The pet is posed with dignified stillness on a dark embroidered velvet cushion, draped in an ermine-trimmed royal mantle, wearing a delicate pearl necklace. Dark stone architectural background with a column. Painted in the style of George Stubbs and Edwin Landseer. Preserve the exact breed, fur colour, markings, and facial features of the animal. Museum-quality oil painting, warm directional lighting, visible brushwork.',
    family:   'Transform this family photo into a formal 18th century aristocratic oil painting portrait. The subjects wear period attire — the man in an embroidered velvet frock coat, the woman in a silk brocade gown with pearl jewellery and lace trim, children in ornate period garments. Rich red velvet curtain in background, dark warm setting. Painted in the style of Joshua Reynolds and Thomas Gainsborough. Preserve the exact facial features and likeness of each person. Museum-quality oil painting, warm candlelit lighting.',
    children: 'Transform this photo of a child into a formal 18th century aristocratic portrait painting. The child wears opulent velvet robes with lace trim and a small gold coronet or ribbon. Soft rosy cheeks, warm glowing light on the face, dark warm background. Holding a small flower. Painted in the style of Thomas Lawrence. Preserve the exact facial features and likeness of the child. Museum-quality oil painting, warm directional lighting, visible brushwork.',
    couples:  'Transform this photo into a formal Victorian-era aristocratic oil painting portrait of a couple. The man wears a dark formal frock coat with white shirt, the woman wears a rich dark velvet gown with white lace collar, cuffs, and a decorative cameo brooch. Their hands gently touching. Dark brown painterly background. Painted in the style of John Singer Sargent. Preserve the exact facial features and likeness of both people. Museum-quality oil painting, warm directional side lighting.',
    self:     'Transform this photo into a formal 18th century aristocratic oil painting self-portrait. The subject wears a rich velvet coat, white cravat or lace collar, waistcoat with gold buttons. Three-quarter view, gazing directly at the viewer with quiet confidence. Dark warm background. Painted in the style of Joshua Reynolds and Thomas Gainsborough. Preserve the exact facial features and likeness of the person. Museum-quality oil painting, warm side lighting, visible brushwork.',
  };

  try {
    const imageDataUrl = `data:${imageMimeType};base64,${imageBase64}`;
    const prompt = stylePrompts[category] || stylePrompts.self;

    // Step 1: Start Replicate prediction with flux-kontext-pro
    const startRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${REPLICATE_KEY}`,
        'Prefer': 'wait=60',
      },
      body: JSON.stringify({
        input: {
          prompt,
          input_image: imageDataUrl,
          output_format: 'jpg',
          output_quality: 90,
          safety_tolerance: 2,
          aspect_ratio: '3:4',
        }
      }),
    });

    if (!startRes.ok) {
      const e = await startRes.json().catch(() => ({}));
      throw new Error(e?.detail || e?.error || `Replicate API HTTP ${startRes.status}`);
    }

    let prediction = await startRes.json();

    // Step 2: Poll until complete (max 90 seconds)
    const maxWait = 90000;
    const pollInterval = 2000;
    const startTime = Date.now();

    while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled') {
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

    // Step 3: Get output image URL and convert to base64
    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!outputUrl) throw new Error('No image returned from Replicate');

    const imgRes = await fetch(outputUrl);
    if (!imgRes.ok) throw new Error('Failed to fetch generated image');
    const imgBuffer = await imgRes.arrayBuffer();
    const b64 = Buffer.from(imgBuffer).toString('base64');

    // Step 4: Printify upload (optional)
    let printifyImageId = null, printifyImageUrl = null;
    const PK = process.env.PRINTIFY_API_KEY, PS = process.env.PRINTIFY_SHOP_ID;
    if (PK && PS) {
      try {
        const pRes = await fetch('https://api.printify.com/v1/uploads/images.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PK}` },
          body: JSON.stringify({ file_name: `portrait-${category}-${Date.now()}.jpg`, contents: b64 }),
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
