const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // ── GET: fetch all orders
  if (req.method === 'GET') {
    try {
      const paymentIntents = await stripe.paymentIntents.list({
        limit: 100,
      });

      const orders = paymentIntents.data
        .filter(pi => pi.status === 'succeeded')
        .map(pi => ({
          id: pi.id,
          amount: pi.amount,
          currency: pi.currency,
          created: pi.created,
          status: pi.metadata?.fulfillment_status || 'new',
          name: pi.metadata?.name || '—',
          email: pi.metadata?.email || '—',
          phone: pi.metadata?.phone || '—',
          package: pi.metadata?.package || '—',
          size: pi.metadata?.size || '—',
          address: pi.metadata?.address || '—',
          notes: pi.metadata?.notes || '',
        }));

      return res.status(200).json({ orders });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: update fulfillment status
  if (req.method === 'POST') {
    try {
      const { id, status } = req.body;
      await stripe.paymentIntents.update(id, {
        metadata: { fulfillment_status: status }
      });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).end();
};
