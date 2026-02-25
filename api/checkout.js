const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    package: pkg,
    size,
    amount,
    currency = 'usd',
    name,
    email,
    phone,
    address,
    notes,
  } = req.body;

  if (!amount || !pkg) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Build metadata to match dashboard expectations
    const metadata = {
      package: pkg,
      size: size || '—',
      name: name || '',
      email: email || '',
      phone: phone || '',
      address: address ? JSON.stringify(address) : '—',
      notes: notes || '',
      fulfillment_status: 'new',
    };

    // Find or create Stripe customer
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        name,
        email,
        phone,
      });
    }

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: customer.id,
      receipt_email: email,
      description: `Eternised — ${pkg}${size ? ' · ' + size : ''}`,
      metadata,
      automatic_payment_methods: { enabled: true },
    });

    console.log('[checkout] created:', paymentIntent.id, '| amount:', amount, '| package:', pkg, '| size:', size);

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
    });

  } catch (err) {
    console.error('[checkout] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
