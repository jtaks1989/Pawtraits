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

  const ASTRIA_KEY = process.env.ASTRIA_API_KEY;
  if (!ASTRIA_KEY) return res.status(500).json({ error: 'ASTRIA_API_KEY not configured' });

  const FLUX_TUNE_ID = process.env.ASTRIA_TUNE_ID || '1504944';

  const isGroup = category === 'family' || category === 'couples';
  const isMultiSubject = isGroup || isMultiPhoto || (photoCount || 1) > 1;
  const effectiveGender = isGroup ? 'mixed'
    : (gender && gender !== 'auto') ? gender : null;

  function buildPrompt(styleCore, cat, gen, isMulti) {
    if (styleCore) return styleCore;

    if (isMulti || cat === 'couples') {
      return `a hyperrealistic classical oil painting portrait of a couple, man wearing dark double-breasted frock coat with white cravat and high collar, woman wearing elegant period silk gown with lace trim at neckline, seated together in intimate pose, lush dark forest landscape background with rocky outcrops and moody dramatic sky with golden light breaking through clouds, warm candlelit chiaroscuro lighting, painted in the masterful style of Joshua Reynolds and John Constable, photorealistic faces and skin, luminous glowing skin tones, rich deep charcoal amber ivory gold palette, museum-quality oil painting, 8k ultra detailed`;
    }
    if (cat === 'family') {
      return `a hyperrealistic classical oil painting family group portrait, men wearing dark formal frock coats with white cravats, women wearing elegant silk brocade gowns with lace trim, grand interior with rich red velvet drapes and warm candlelight, painted in the style of Joshua Reynolds, photorealistic faces, luminous skin tones, museum-quality masterpiece, 8k`;
    }
    if (cat === 'pets') {
      return `a hyperrealistic classical oil painting portrait of a noble pet wearing a miniature ermine-trimmed royal mantle, dark stone architectural background with warm amber directional lighting, dramatic side lighting, painted in the style of George Stubbs and Edwin Landseer, rich warm palette deep brown gold ivory, museum-quality masterpiece, 8k`;
    }
    if (cat === 'children') {
      return `a hyperrealistic classical oil painting portrait of a child wearing opulent velvet robes with intricate lace trim and a small gold coronet, dark warm background with soft glowing light, painted in the style of Thomas Lawrence, photorealistic face, luminous skin tones, museum-quality masterpiece, 8k`;
    }
    if (gen === 'female') {
      return `a hyperrealistic classical oil painting portrait of a woman wearing an elegant empire-waist silk gown with delicate lace trim at the décolletage, pearl drop earrings, hair pinned up with soft curls framing the face, lush romantic landscape background with trees and golden atmospheric sky, warm soft diffused lighting from the left, painted in the style of Elisabeth Vigée Le Brun and Thomas Gainsborough, photorealistic face, luminous glowing skin, cream ivory sage green warm gold palette, museum-quality masterpiece, 8k`;
    }
    return `a hyperrealistic classical oil painting portrait of a man wearing a dark navy wool tailcoat with velvet lapels and a crisp white linen cravat tied at the throat, dramatic rocky forest landscape background with atmospheric depth and moody dark sky, dramatic Rembrandt side lighting from upper left casting deep warm amber shadows, painted in the masterful style of Sir Thomas Lawrence and Joshua Reynolds, photorealistic face and skin, luminous warm skin tones, confident half-body three-quarter pose, deep forest green umber charcoal palette, museum-quality masterpiece, 8k`;
  }

  const prompt = buildPrompt(stylePrompt, category, effectiveGender, isMultiSubject);

  console.log('[generate] category:', category, '| gender:', effectiveGender);
  console.log('[generate] prompt:', prompt.substring(0, 200));

  try {
    const imageDataUrl = `data:${imageMimeType};base64,${imageBase64}`;

    const astriaRes = await fetch(
      `https://api.astria.ai/tunes/${FLUX_TUNE_ID}/prompts`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ASTRIA_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: {
            text: prompt,
            num_images: 1,
            w: 832,
            h: 1216,
            cfg_scale: 4,
            steps: 30,
            face_swap: imageDataUrl,
          },
        }),
      }
    );

    if (!astriaRes.ok) {
      const e = await astriaRes.json().catch(() => ({}));
      console.error('[generate] Astria error body:', JSON.stringify(e));
      throw new Error(e?.error || e?.message || JSON.stringify(e) || 'Astria API HTTP ' + astriaRes.status);
    }

    let promptData = await astriaRes.json();
    console.log('[generate] Astria prompt created, id:', promptData.id);

    // Poll until images are ready
    const maxWait = 180000;
    const startTime = Date.now();

    while (!promptData.images || promptData.images.length === 0) {
      if (Date.now() - startTime > maxWait) throw new Error('Generation timed out. Please try again.');
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await fetch(
        `https://api.astria.ai/tunes/${FLUX_TUNE_ID}/prompts/${promptData.id}`,
        { headers: { 'Authorization': `Bearer ${ASTRIA_KEY}` } }
      );
      promptData = await pollRes.json();
      console.log('[generate] poll — images ready:', (promptData.images || []).length);
    }

    const imageUrl = promptData.images[0].url;
    if (!imageUrl) throw new Error('No image URL returned from Astria');

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
