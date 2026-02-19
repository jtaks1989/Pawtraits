module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageMimeType = 'image/jpeg', category, catLabel } = req.body;
  if (!imageBase64 || !category) return res.status(400).json({ error: 'Missing fields' });

  const XAI_KEY = process.env.XAI_API_KEY;
  if (!XAI_KEY) return res.status(500).json({ error: 'XAI_API_KEY not configured' });

  const modifiers = {
    pets:     'The pet is the sole subject, posed with dignified stillness on a dark velvet embroidered cushion or cushioned throne. Draped with a luxurious ermine-trimmed royal mantle with black spots. A delicate pearl or jewelled necklace around their neck. The animal faces forward, calm and regal, painted with extraordinary fur detail. Dark stone architectural background with a column or arch visible. Formal aristocratic pet portrait, no human figures.',
    family:   'An aristocratic family group portrait. The adults wear rich 18th-century attire — the man in an embroidered velvet frock coat, the woman in a silk brocade gown with pearl jewellery and lace trim. Any children or babies dressed in ornate period garments. Subjects are close together with natural warmth, set against a dark background with a rich red velvet curtain draped to one side. Warm candlelit atmosphere, formal yet intimate.',
    children: 'A formal aristocratic portrait of a child dressed in opulent 18th-century robes — rich velvet or silk with lace trim, a small gold coronet or ribbon in their hair. Soft, cherubic features with rosy cheeks and innocent eyes. The child holds a small flower or toy. Warm glowing light on the face, dark warm background. Timeless, painterly, full of warmth and innocence.',
    couples:  'A formal Victorian-era oil painting of a couple. The man stands behind or beside the woman, dressed in a dark formal frock coat with a white shirt. The woman is seated, wearing a rich dark velvet or silk gown with intricate white lace collar, cuffs, and a decorative cameo brooch. Their hands are gently touching. Warm directional lighting from one side, dark brown painterly background. Intimate yet dignified, deeply realistic skin tones.',
    self:     'A dramatic formal portrait of a single noble figure in 18th-century aristocratic attire — rich velvet coat, white cravat or lace collar, waistcoat with gold buttons. Three-quarter view, the subject gazes directly at the viewer with quiet confidence and gravitas. Warm side lighting illuminates the face, dark background with subtle shadow. Masterful rendering of fabric texture and lifelike skin.',
  };

  try {
    // Step 1: Vision
    const vRes = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_KEY}` },
      body: JSON.stringify({
        model: 'grok-2-vision-1212',
        max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${imageMimeType};base64,${imageBase64}`, detail: 'high' } },
          { type: 'text', text: `Describe this ${catLabel} in precise detail for a classical portrait oil painter: physical appearance, colouring, distinguishing features, approximate age, expression, and any notable characteristics. Be specific about fur/hair colour, eye colour, face shape, and markings. Max 120 words. No preamble, no commentary.` }
        ]}]
      }),
    });
    if (!vRes.ok) {
      const e = await vRes.json().catch(() => ({}));
      throw new Error(e?.error?.message || `Vision API HTTP ${vRes.status}`);
    }
    const vData = await vRes.json();
    const description = vData.choices?.[0]?.message?.content?.trim() || 'a noble subject';

    // Step 2: Image generation
    const prompt = `A breathtaking formal aristocratic oil painting in the style of Thomas Gainsborough, Joshua Reynolds, and John Singer Sargent. Subject: ${description}. ${modifiers[category] || ''} Warm directional side lighting with soft shadows. Rich, dark warm background — deep brown, dark olive, or near-black. Masterful oil painting technique with visible brushwork, lifelike skin tones, and exquisite fabric detail — velvet, silk, lace rendered with photographic realism. Museum-quality canvas texture, no modern elements, no text, painted circa 1780–1890. Ultra high resolution. Vertical portrait orientation.`;

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

    // Step 3: Printify upload (optional)
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
