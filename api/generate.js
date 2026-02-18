/**
 * /api/generate
 * Proxies two xAI calls server-side so the API key is never exposed to the browser:
 *   1. Grok Vision  → analyses the uploaded photo
 *   2. Grok Imagine → generates the Renaissance portrait
 *   3. Printify     → uploads the generated image to Printify's media library
 *
 * Required env vars (set in Vercel dashboard):
 *   XAI_API_KEY
 *   PRINTIFY_API_KEY
 *   PRINTIFY_SHOP_ID
 */

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imageBase64, imageMimeType = 'image/jpeg', category, catLabel } = req.body;

  if (!imageBase64 || !category) {
    return res.status(400).json({ error: 'Missing imageBase64 or category' });
  }

  const XAI_KEY = process.env.XAI_API_KEY;
  if (!XAI_KEY) {
    return res.status(500).json({ error: 'Server misconfiguration: XAI_API_KEY not set' });
  }

  const catPromptModifiers = {
    pets:     'This is a beloved pet. Dress them in miniature royal regalia with a velvet cushion. The animal should look regal, dignified, and noble.',
    family:   'This is a family group portrait. Pose them together in aristocratic fashion with warm familial closeness.',
    children: 'This is a child. Crown them with a small gold coronet and dress them in royal robes. Cherubic, innocent, regal.',
    couples:  'This is a couple. Pose them together with a tender, aristocratic intimacy. Two nobles deeply bonded.',
    self:     'This is a solo self-portrait. Dramatic three-quarter view, piercing gaze, self-assured noble bearing.',
  };

  try {
    // ── STEP 1: Grok Vision — analyse the photo ──────────────────────────────
    const visionRes = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-2-vision-1212',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${imageMimeType};base64,${imageBase64}`,
                detail: 'high',
              },
            },
            {
              type: 'text',
              text: `Analyse this photo of my ${catLabel.toLowerCase()} and describe the subject(s) in vivid detail for a Renaissance portrait painter. Include: species or type (if animal), age estimate, hair/fur colour, eye colour, skin tone, distinguishing features, expression, and any notable physical characteristics. Be specific and descriptive. Maximum 120 words. No preamble.`,
            },
          ],
        }],
      }),
    });

    if (!visionRes.ok) {
      const err = await visionRes.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${visionRes.status}`;
      if (visionRes.status === 401) throw new Error('Invalid xAI API key. Check your XAI_API_KEY environment variable.');
      throw new Error(`Grok Vision error: ${msg}`);
    }

    const visionData = await visionRes.json();
    const subjectDescription = visionData.choices?.[0]?.message?.content?.trim() || 'a noble subject';

    // ── STEP 2: Grok Imagine — generate the portrait ─────────────────────────
    const catModifier = catPromptModifiers[category] || '';
    const portraitPrompt = `A breathtaking Renaissance oil painting portrait in the style of the old masters — Rembrandt van Rijn, Anthony van Dyck, Johannes Vermeer. The subject: ${subjectDescription}. ${catModifier} Dramatic chiaroscuro lighting with warm golden candlelight casting rich shadows. Deep jewel-toned background in burgundy and forest green with subtle texture. Elaborate period regalia — velvet robes, gold chain of office, intricate lace ruff collar, ornate jewellery. Painted with masterful brushwork, rich impasto texture, aged museum-quality canvas. Highly detailed, cinematic, 17th century Flemish painting style. Ultra high resolution.`;

    const imgRes = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-2-image',
        prompt: portraitPrompt,
        n: 1,
        response_format: 'b64_json',
      }),
    });

    if (!imgRes.ok) {
      const err = await imgRes.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${imgRes.status}`;
      throw new Error(`Grok Imagine error: ${msg}`);
    }

    const imgData = await imgRes.json();
    const b64 = imgData.data?.[0]?.b64_json;
    if (!b64) throw new Error('No image returned from Grok Imagine.');

    // ── STEP 3: Upload to Printify image library ──────────────────────────────
    // This gives us a permanent image URL and ID to use when creating the print order
    const PRINTIFY_KEY  = process.env.PRINTIFY_API_KEY;
    const PRINTIFY_SHOP = process.env.PRINTIFY_SHOP_ID;

    let printifyImageId  = null;
    let printifyImageUrl = null;

    if (PRINTIFY_KEY && PRINTIFY_SHOP) {
      try {
        const printifyUpload = await fetch('https://api.printify.com/v1/uploads/images.json', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${PRINTIFY_KEY}`,
          },
          body: JSON.stringify({
            file_name: `portrait-${category}-${Date.now()}.jpg`,
            contents: b64,  // base64 string
          }),
        });

        if (printifyUpload.ok) {
          const pData = await printifyUpload.json();
          printifyImageId  = pData.id;
          printifyImageUrl = pData.preview_url || pData.url;
        } else {
          console.error('Printify upload failed:', await printifyUpload.text());
        }
      } catch (pErr) {
        // Non-fatal — portrait generation still succeeds, just log it
        console.error('Printify upload error:', pErr.message);
      }
    }

    // ── Return everything to the frontend ─────────────────────────────────────
    return res.status(200).json({
      imageData: `data:image/jpeg;base64,${b64}`,
      printifyImageId,
      printifyImageUrl,
      subjectDescription,  // for debugging / display
    });

  } catch (err) {
    console.error('generate error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
