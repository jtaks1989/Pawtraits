module.exports.config = {
  api: { bodyParser: { sizeLimit: '20mb' } }
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageMimeType = 'image/jpeg', category, catLabel } = req.body;
  if (!imageBase64 || !category) return res.status(400).json({ error: 'Missing fields' });

  const XAI_KEY = process.env.XAI_API_KEY;
  if (!XAI_KEY) return res.status(500).json({ error: 'XAI_API_KEY not configured' });

  const modifiers = {
    pets:     'This is a beloved pet. Dress them in miniature royal regalia. Regal, dignified, noble.',
    family:   'Aristocratic family group portrait with warm familial closeness.',
    children: 'Crown the child with a gold coronet and royal robes. Cherubic, innocent, regal.',
    couples:  'Tender aristocratic intimacy. Two nobles deeply bonded.',
    self:     'Dramatic three-quarter view, piercing gaze, self-assured noble bearing.',
  };

  try {
    const vRes = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_KEY}` },
      body: JSON.stringify({
        model: 'grok-2-vision-1212',
        max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${imageMimeType};base64,${imageBase64}`, detail: 'high' } },
          { type: 'text', text: `Describe this ${catLabel} in vivid detail for a Renaissance portrait painter. Species, age, colours, features, expression. Max 120 words. No preamble.` }
        ]}]
      }),
    });
    if (!vRes.ok) {
      const e = await vRes.json().catch(() => ({}));
      throw new Error(e?.error?.message || `Vision API HTTP ${vRes.status}`);
    }
    const vData = await vRes.json();
    const description = vData.choices?.[0]?.message?.content?.trim() || 'a noble subject';

    const prompt = `A breathtaking Renaissance oil painting in the style of Rembrandt, Van Dyck, Vermeer. Subject: ${description}. ${modifiers[category] || ''} Dramatic chiaroscuro lighting, warm golden candlelight, jewel-toned background, velvet robes, gold chain, lace ruff collar. Masterful brushwork, impasto texture, museum-quality canvas. Ultra high resolution.`;

    const iRes = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_KEY}` },
      body: JSON.stringify({ model: 'grok-2-image', prompt, n: 1, response_format: 'b64_json' }),
    });
    if (!iRes.ok) {
      const e = await iRes.json().catch(() => ({}));
      throw new Error(e?.error?.message || `Image API HTTP ${iRes.status}`);
    }
    const iData = await iRes.json();
    const b64 = iData.data?.[0]?.b64_json;
    if (!b64) throw new Error('No image returned');

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
