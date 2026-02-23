const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    package: pkg,
    packageName,
    amount,
    currency = 'usd',
    customerName,
    email,
    phone,
    address,
  } = req.body;

  if (!amount || !pkg) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const metadata = {
      package: pkg,
      packageName: packageName || '',
      customerName: customerName || '',
      phone: phone || '',
    };

    if (address) {
      metadata.address_line1 = address.line1 || '';
      metadata.address_line2 = address.line2 || '';
      metadata.city = address.city || '';
      metadata.country = address.country || '';
      metadata.delivery_notes = address.notes || '';
    }

    // Find or create Stripe customer
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        name: customerName,
        email,
        phone,
        metadata,
      });
    }

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: customer.id,
      receipt_email: email,
      description: `Pawtraits — ${packageName}`,
      metadata,
      automatic_payment_methods: { enabled: true },
    });

    console.log('[checkout] created:', paymentIntent.id, '| amount:', amount, '| package:', pkg);

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
    });

  } catch (err) {
    console.error('[checkout] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
