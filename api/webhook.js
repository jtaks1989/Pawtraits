const Stripe = require('stripe');

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function saveToAirtable(order) {
  const AIRTABLE_KEY     = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  if (!AIRTABLE_KEY || !AIRTABLE_BASE_ID) {
    console.log('Airtable not configured — skipping save');
    return;
  }
  try {
    const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AIRTABLE_KEY}`,
      },
      body: JSON.stringify({
        fields: {
          'Order ID':       order.orderId,
          'Customer Name':  order.customerName,
          'Email':          order.email,
          'Package':        order.package,
          'Category':       order.category,
          'Price':          order.price,
          'Address Line 1': order.address1,
          'Address Line 2': order.address2 || '',
          'City':           order.city,
          'State':          order.state,
          'Postcode':       order.postcode,
          'Country':        order.country,
          'Portrait URL':   order.portraitUrl || '',
          'Status':         'New Order',
          'Order Date':     order.date,
        },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Airtable save error:', err);
    } else {
      console.log('✅ Order saved to Airtable');
    }
  } catch (err) {
    console.error('Airtable error:', err.message);
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig     = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);
  let event;

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const metadata = session.metadata || {};
    const shipping = session.shipping_details;
    const addr     = shipping?.address || {};
    const nameParts = (shipping?.name || session.customer_details?.name || 'Customer').split(' ');

    const order = {
      orderId:      session.id,
      customerName: shipping?.name || session.customer_details?.name || 'Customer',
      email:        session.customer_email || session.customer_details?.email || '',
      package:      metadata.pkg_label || metadata.pkg || '—',
      category:     metadata.cat_label || '—',
      price:        `$${((session.amount_total || 0) / 100).toFixed(2)}`,
      address1:     addr.line1 || '',
      address2:     addr.line2 || '',
      city:         addr.city || '',
      state:        addr.state || '',
      postcode:     addr.postal_code || '',
      country:      addr.country || '',
      portraitUrl:  metadata.printify_image_url || '',
      date:         new Date().toISOString().split('T')[0],
    };

    console.log(`✅ Payment: ${order.customerName} — ${order.package} — ${order.price}`);
    await saveToAirtable(order);
  }

  return res.status(200).json({ received: true });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
