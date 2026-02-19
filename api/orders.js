async function handler(req, res) {
  // Simple password check
  const { password } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const AIRTABLE_KEY     = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Airtable not configured' });
  }

  try {
    const res2 = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Orders?sort[0][field]=Order%20Date&sort[0][direction]=desc&maxRecords=100`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_KEY}` } }
    );
    if (!res2.ok) {
      const err = await res2.text();
      return res.status(500).json({ error: err });
    }
    const data = await res2.json();
    const orders = (data.records || []).map(r => ({ id: r.id, ...r.fields }));
    return res.status(200).json({ orders });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = handler;
