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

  const FAL_KEY = process.env.FAL_API_KEY;
  if (!FAL_KEY) return res.status(500).json({ error: 'FAL_API_KEY not configured' });

  const isGroup = category === 'family' || category === 'couples';
  const isMultiSubject = isGroup || isMultiPhoto || (photoCount || 1) > 1;
  const effectiveGender = isGroup ? 'mixed'
    : (gender && gender !== 'auto') ? gender : null;

  function buildPrompt(styleCore, cat, gen, isMulti) {
    if (styleCore) return styleCore;
    if (isMulti || cat === 'couples') {
      return `aristocratic couple portrait, man wearing dark double-breasted frock coat with white cravat, woman wearing elegant period silk gown with lace trim, seated together in intimate pose, lush dark forest landscape background, warm candlelit chiaroscuro lighting, classical oil painting style of Joshua Reynolds, photorealistic faces, luminous skin tones, rich charcoal amber ivory gold palette, museum-quality masterpiece`;
    }
    if (cat === 'family') {
      return `aristocratic family group portrait, men wearing dark formal frock coats with white cravats, women wearing elegant silk brocade gowns, grand interior with red velvet drapes and warm candlelight, classical oil painting style of Joshua Reynolds, photorealistic faces, luminous skin tones, museum-quality masterpiece`;
    }
    if (cat === 'pets') {
      return `noble pet portrait wearing miniature ermine-trimmed royal mantle, dark stone architectural background with warm amber lighting, classical oil painting style of George Stubbs, museum-quality masterpiece`;
    }
    if (cat === 'children') {
      return `aristocratic child portrait wearing opulent velvet robes with lace trim and small gold coronet, dark warm background with soft glowing light, classical oil painting style of Thomas Lawrence, photorealistic face, museum-quality masterpiece`;
    }
    if (gen === 'female') {
      return `aristocratic woman portrait wearing elegant empire-waist silk gown with lace trim at décolletage, pearl drop earrings, hair pinned up with soft curls, romantic landscape background with golden atmospheric sky, soft diffused lighting, classical oil painting style of Elisabeth Vigée Le Brun, photorealistic face, luminous glowing skin, museum-quality masterpiece`;
    }
    return `aristocratic man portrait wearing dark navy wool tailcoat with velvet lapels and crisp white linen cravat, dramatic rocky forest landscape background, Rembrandt side lighting, classical oil painting style of Sir Thomas Lawrence and Joshua Reynolds, photorealistic face, luminous warm skin tones, confident half-body three-quarter pose, museum-quality masterpiece`;
  }

  const prompt = buildPrompt(stylePrompt, category, effectiveGender, isMultiSubject);
  console.log('[generate] category:', category, '| gender:', effectiveGender);
  console.log('[generate] prompt:', prompt.substring(0, 150));

  try {
    const imageUrl = `data:${imageMimeType};base64,${imageBase64}`;

    // ── Submit to fal.ai InstantID ────────────────────────────────────────────
    console.log('[generate] submitting to fal.ai...');
    const submitRes = await fetch('https://queue.fal.run/fal-ai/instantid', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        face_image_url: imageUrl,
        prompt: prompt,
        negative_prompt: 'cartoon, anime, sketch, drawing, modern clothing, photo, photograph, ugly, deformed, blurry, low quality',
        num_inference_steps: 30,
        guidance_scale: 7,
        controlnet_conditioning_scale: 0.8,
        ip_adapter_scale: 0.8,
        num_images: 1,
        enable_safety_checker: false,
      }),
    });

    if (!submitRes.ok) {
      const rawText = await submitRes.text().catch(() => 'unreadable');
      console.error('[generate] fal submit error:', submitRes.status, rawText);
      throw new Error('fal.ai submit failed ' + submitRes.status + ': ' + rawText);
    }

    const submitData = await submitRes.json();
    const requestId = submitData.request_id;
    console.log('[generate] fal request_id:', requestId);

    // ── Poll for result ───────────────────────────────────────────────────────
    const maxWait = 50000;
    const startTime = Date.now();

    while (true) {
      await new Promise(r => setTimeout(r, 3000));

      const statusRes = await fetch(`https://queue.fal.run/fal-ai/instantid/requests/${requestId}/status`, {
        headers: { 'Authorization': `Key ${FAL_KEY}` },
      });
      const statusData = await statusRes.json();
      console.log('[generate] status:', statusData.status, '| elapsed:', Math.round((Date.now() - startTime) / 1000) + 's');

      if (statusData.status === 'COMPLETED') {
        const resultRes = await fetch(`https://queue.fal.run/fal-ai/instantid/requests/${requestId}`, {
          headers: { 'Authorization': `Key ${FAL_KEY}` },
        });
        const result = await resultRes.json();
        console.log('[generate] result:', JSON.stringify(result).substring(0, 200));

        const generatedUrl = result?.images?.[0]?.url || result?.image?.url || null;
        if (!generatedUrl) throw new Error('No image URL in fal.ai result');

        console.log('[generate] got image URL:', generatedUrl.substring(0, 80));
        const imgRes = await fetch(generatedUrl);
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
      }

      if (statusData.status === 'FAILED') {
        throw new Error('fal.ai generation failed: ' + JSON.stringify(statusData));
      }

      if (Date.now() - startTime > maxWait) {
        throw new Error('Generation is taking longer than expected. Please retry.');
      }
    }

  } catch (err) {
    console.error('[generate] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};
