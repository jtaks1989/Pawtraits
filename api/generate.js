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

  // FaceID tune must be created against Realistic Vision — confirmed in Astria docs
  const FACEID_BASE_TUNE_ID = '690204';
  // Generation happens on Flux.1 dev — confirmed working in UI
  const FLUX_TUNE_ID = '1504944';

  const isGroup = category === 'family' || category === 'couples';
  const isMultiSubject = isGroup || isMultiPhoto || (photoCount || 1) > 1;
  const effectiveGender = isGroup ? 'mixed'
    : (gender && gender !== 'auto') ? gender : null;

  // Default to man if gender not specified — prevents feminine output
  const genderWord = effectiveGender === 'female' ? 'woman' : 'man';

  function buildPrompt(styleCore, cat, gen, isMulti, faceIdTuneId) {
    const faceToken = `<faceid:${faceIdTuneId}:1.0>`;
    if (styleCore) return `${faceToken} ${styleCore}`;
    if (isMulti || cat === 'couples') {
      return `${faceToken} hyperrealistic classical oil painting portrait of a man and a woman couple, man wearing dark double-breasted wool frock coat with white cravat and high collar, woman wearing elegant period silk gown with lace trim at neckline, seated together in intimate pose, lush dark forest landscape background with rocky outcrops and moody dramatic sky, warm candlelit chiaroscuro lighting, painted in the masterful style of Joshua Reynolds and John Constable, photorealistic faces and skin, luminous glowing skin tones, rich deep charcoal amber ivory gold palette, museum-quality oil painting, 8k`;
    }
    if (cat === 'family') {
      return `${faceToken} hyperrealistic classical oil painting family group portrait, men wearing dark formal frock coats with white cravats, women wearing elegant silk brocade gowns with lace trim, grand interior with rich red velvet drapes and warm candlelight, painted in the style of Joshua Reynolds, photorealistic faces, luminous skin tones, museum-quality masterpiece, 8k`;
    }
    if (cat === 'pets') {
      return `${faceToken} hyperrealistic classical oil painting portrait of a noble pet wearing a miniature ermine-trimmed royal mantle, dark stone architectural background with warm amber directional lighting, painted in the style of George Stubbs, museum-quality masterpiece, 8k`;
    }
    if (cat === 'children') {
      return `${faceToken} hyperrealistic classical oil painting portrait of a child wearing opulent velvet robes with intricate lace trim and a small gold coronet, dark warm background with soft glowing light, painted in the style of Thomas Lawrence, photorealistic face, museum-quality masterpiece, 8k`;
    }
    if (gen === 'female') {
      return `${faceToken} hyperrealistic classical oil painting portrait of a woman, wearing an elegant empire-waist silk gown with delicate lace trim at the décolletage, pearl drop earrings, hair pinned up with soft curls framing the face, lush romantic landscape background with trees and golden atmospheric sky, warm soft diffused lighting from the left, painted in the style of Elisabeth Vigée Le Brun and Thomas Gainsborough, photorealistic face, luminous glowing skin, cream ivory sage green warm gold palette, museum-quality masterpiece, 8k`;
    }
    return `${faceToken} hyperrealistic classical oil painting portrait of a man, wearing a dark navy wool tailcoat with velvet lapels and a crisp white linen cravat tied at the throat, masculine aristocratic attire, dramatic rocky forest landscape background with atmospheric depth and moody dark sky, Rembrandt side lighting from upper left casting deep warm amber shadows, painted in the masterful style of Sir Thomas Lawrence and Joshua Reynolds, photorealistic face and skin, luminous warm skin tones, confident half-body three-quarter pose, museum-quality masterpiece, 8k`;
  }

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
    // ── STEP 1: Upload image to imgur to get a real HTTP URL ──────────────────
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

    // ── STEP 2: Create FaceID tune using Realistic Vision base (per Astria docs)
    console.log('[generate] creating FaceID tune on Realistic Vision...');
    const tuneForm = new FormData();
    tuneForm.append('tune[title]', `pawtraits-${genderWord}-${Date.now()}`);
    tuneForm.append('tune[name]', genderWord);
    tuneForm.append('tune[model_type]', 'faceid');
    tuneForm.append('tune[base_tune_id]', FACEID_BASE_TUNE_ID);
    tuneForm.append('tune[image_urls][]', uploadedImageUrl);

    const tuneRes = await fetch('https://api.astria.ai/tunes', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ASTRIA_KEY}`,
        ...tuneForm.getHeaders(),
      },
      body: tuneForm,
    });

    if (!tuneRes.ok) {
      const rawText = await tuneRes.text().catch(() => 'unreadable');
      console.error('[generate] FaceID tune error:', tuneRes.status, rawText);
      throw new Error('FaceID tune failed ' + tuneRes.status + ': ' + rawText);
    }

    const tuneData = await tuneRes.json();
    const faceIdTuneId = tuneData.id;
    console.log('[generate] FaceID tune created, id:', faceIdTuneId);

    // ── STEP 3: Generate portrait on Flux.1 dev ───────────────────────────────
    const prompt = buildPrompt(stylePrompt, category, effectiveGender, isMultiSubject, faceIdTuneId);
    console.log('[generate] prompt:', prompt.substring(0, 200));

    const promptForm = new FormData();
    promptForm.append('prompt[text]', prompt);
    promptForm.append('prompt[num_images]', '1');
    promptForm.append('prompt[face_correct]', 'true');
    promptForm.append('prompt[super_resolution]', 'true');
    promptForm.append('prompt[w]', '832');
    promptForm.append('prompt[h]', '1216');
    promptForm.append('prompt[steps]', '30');
    promptForm.append('prompt[cfg_scale]', '4');

    const promptRes = await fetch(
      `https://api.astria.ai/tunes/${FLUX_TUNE_ID}/prompts`,
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
        `https://api.astria.ai/tunes/${FLUX_TUNE_ID}/prompts/${promptData.id}`,
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
