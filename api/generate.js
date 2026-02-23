const FormData = require('form-data');

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

  const BASE_TUNE_ID = 690204;

  const isGroup = category === 'family' || category === 'couples';
  const isMultiSubject = isGroup || isMultiPhoto || (photoCount || 1) > 1;
  const effectiveGender = isGroup ? 'mixed'
    : (gender && gender !== 'auto') ? gender : null;

  const genderWord = effectiveGender === 'female' ? 'woman' : 'man';

  function extractImageUrl(images) {
    if (!images || images.length === 0) return null;
    const first = images[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') {
      return first.url || first.src || first.image_url || first.uri || Object.values(first)[0] || null;
    }
    return null;
  }

  console.log('[generate] category:', category, '| gender:', effectiveGender, '| genderWord:', genderWord);

  try {
    // ── STEP 1: Upload image to imgur ─────────────────────────────────────────
    console.log('[generate] uploading image to imgur...');
    const imgurRes = await fetch('https://api.imgur.com/3/image', {
      method: 'POST',
      headers: {
        'Authorization': 'Client-ID 546c25a59c58ad7',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: imageBase64, type: 'base64' }),
    });

    if (!imgurRes.ok) {
      const e = await imgurRes.text();
      console.error('[generate] imgur error:', e);
      throw new Error('Image upload failed: ' + imgurRes.status);
    }

    const imgurData = await imgurRes.json();
    const uploadedImageUrl = imgurData?.data?.link;
    if (!uploadedImageUrl) throw new Error('No image URL from imgur');
    console.log('[generate] image uploaded:', uploadedImageUrl);

    // ── STEP 2: Create FaceID tune ────────────────────────────────────────────
    console.log('[generate] creating FaceID tune...');
    const tuneRes = await fetch('https://api.astria.ai/tunes', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ASTRIA_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tune: {
          title: `pawtraits-${genderWord}-${Date.now()}`,
          name: genderWord,
          model_type: 'faceid',
          base_tune_id: BASE_TUNE_ID,
          image_urls: [uploadedImageUrl],
        },
      }),
    });

    if (!tuneRes.ok) {
      const rawText = await tuneRes.text().catch(() => 'unreadable');
      console.error('[generate] FaceID tune error:', tuneRes.status, rawText);
      throw new Error('FaceID tune failed ' + tuneRes.status + ': ' + rawText);
    }

    const tuneData = await tuneRes.json();
    const faceIdTuneId = tuneData.id;
    console.log('[generate] FaceID tune created, id:', faceIdTuneId);

    // ── STEP 3: Test with minimal prompt ─────────────────────────────────────
    const testPrompt = `<faceid:${faceIdTuneId}:1.0> ${genderWord} in renaissance oil painting`;
    console.log('[generate] prompt:', testPrompt);

    const promptForm = new FormData();
    promptForm.append('prompt[text]', testPrompt);
    promptForm.append('prompt[num_images]', '1');
    promptForm.append('prompt[steps]', '30');

    const promptRes = await fetch(
      `https://api.astria.ai/tunes/${BASE_TUNE_ID}/prompts`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ASTRIA_KEY}`,
          ...promptForm.getHeaders(),
        },
        body: promptForm,
      }
    );

    if (!promptRes.ok) {
      const rawText = await promptRes.text().catch(() => 'unreadable');
      console.error('[generate] prompt error:', promptRes.status, rawText);
      throw new Error('Prompt failed ' + promptRes.status + ': ' + rawText);
    }

    let promptData = await promptRes.json();
    console.log('[generate] prompt created id:', promptData.id);
    console.log('[generate] prompt raw response:', JSON.stringify(promptData).substring(0, 300));

    // ── STEP 4: Poll for result ───────────────────────────────────────────────
    const maxWait = 50000;
    const startTime = Date.now();

    while (true) {
      const generatedUrl = extractImageUrl(promptData.images || []);

      if (generatedUrl) {
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

      if (Date.now() - startTime > maxWait) {
        throw new Error('Generation is taking longer than expected. Please retry.');
      }

      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await fetch(
        `https://api.astria.ai/tunes/${BASE_TUNE_ID}/prompts/${promptData.id}`,
        { headers: { 'Authorization': `Bearer ${ASTRIA_KEY}` } }
      );
      promptData = await pollRes.json();
      console.log('[generate] poll — images:', (promptData.images || []).length, '| elapsed:', Math.round((Date.now() - startTime) / 1000) + 's');
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
