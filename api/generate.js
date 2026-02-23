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

  // Flux1.dev base model from Astria gallery — confirmed ID from docs
  const BASE_TUNE_ID = '1504944';

  const isGroup = category === 'family' || category === 'couples';
  const isMultiSubject = isGroup || isMultiPhoto || (photoCount || 1) > 1;
  const effectiveGender = isGroup ? 'mixed'
    : (gender && gender !== 'auto') ? gender : null;

  const genderWord = effectiveGender === 'male' ? 'man'
    : effectiveGender === 'female' ? 'woman'
    : 'person';

  function buildPrompt(styleCore, cat, gen, isMulti, faceIdTuneId) {
    // <faceid:tuneId:strength> token tells Astria to use the person's face
    const faceToken = `<faceid:${faceIdTuneId}:1>`;
    const styleBase = styleCore || getDefaultStyle(cat, gen);
    const gw = gen === 'male' ? 'man' : gen === 'female' ? 'woman' : 'person';

    if (isMulti || cat === 'couples') {
      return `${faceToken} hyperrealistic classical oil painting portrait of a couple, man wearing dark double-breasted frock coat with white cravat and high collar, woman wearing elegant period silk gown with lace trim at neckline, seated together in intimate pose, lush dark forest landscape background with rocky outcrops and moody dramatic sky, warm candlelit chiaroscuro lighting, painted in the masterful style of Joshua Reynolds and John Constable, photorealistic faces and skin, luminous glowing skin tones, rich deep charcoal amber ivory gold palette, museum-quality oil painting, 8k`;
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
      return `${faceToken} hyperrealistic classical oil painting portrait of a woman wearing an elegant empire-waist silk gown with delicate lace trim at the décolletage, pearl drop earrings, hair pinned up with soft curls framing the face, lush romantic landscape background, warm soft diffused lighting, painted in the style of Elisabeth Vigée Le Brun and Thomas Gainsborough, photorealistic face, luminous glowing skin, museum-quality masterpiece, 8k`;
    }
    return `${faceToken} hyperrealistic classical oil painting portrait of a man wearing a dark navy wool tailcoat with velvet lapels and a crisp white linen cravat, dramatic rocky forest landscape background, Rembrandt side lighting from upper left, painted in the masterful style of Sir Thomas Lawrence and Joshua Reynolds, photorealistic face and skin, luminous warm skin tones, confident half-body three-quarter pose, museum-quality masterpiece, 8k`;
  }

  function getDefaultStyle(cat, gen) {
    const styles = {
      pets:     'regal oil painting, style of George Stubbs, ermine-trimmed royal mantle, dark stone background',
      family:   'formal 18th century oil painting, style of Joshua Reynolds, velvet frock coats, silk brocade gowns',
      children: 'formal 18th century child portrait, style of Thomas Lawrence, opulent velvet robes',
      couples:  'Victorian aristocratic oil portrait, style of John Singer Sargent, dark painterly background',
      self:     'formal 18th century aristocratic oil painting, style of Joshua Reynolds, dark warm background',
    };
    return styles[cat] || styles.self;
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

  console.log('[generate] category:', category, '| gender:', effectiveGender);

  try {
    const imageBuffer = Buffer.from(imageBase64, 'base64');

    // ── STEP 1: Create FaceID tune (instant — no training needed) ─────────────
    console.log('[generate] creating FaceID tune...');
    const tuneForm = new FormData();
    tuneForm.append('tune[title]', `pawtraits-faceid-${Date.now()}`);
    tuneForm.append('tune[name]', genderWord);
    tuneForm.append('tune[model_type]', 'faceid');
    tuneForm.append('tune[base_tune_id]', BASE_TUNE_ID);
    tuneForm.append('tune[images][]', imageBuffer, {
      filename: 'face.jpg',
      contentType: imageMimeType,
    });

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

    // ── STEP 2: Generate portrait using FaceID tune ───────────────────────────
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

    // ── STEP 3: Poll for result ───────────────────────────────────────────────
    const maxWait = 50000;
    const startTime = Date.now();

    while (true) {
      const imageUrl = extractImageUrl(promptData.images || []);

      if (imageUrl) {
        console.log('[generate] got image URL:', imageUrl.substring(0, 80));

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
