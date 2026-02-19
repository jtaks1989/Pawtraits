const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pkg, printifyImageId, printifyImageUrl, catLabel } = req.body;
  const PACKAGES = {
    squire: { label: 'Squire Pack', description: '20×25 cm (8×10 in) archival canvas print + digital file', amount: 4900 },
    noble:  { label: 'Noble Pack',  description: '30×40 cm (12×16 in) archival canvas print + digital file', amount: 8900 },
    royal:  { label: 'Royal Pack',  description: '45×60 cm (18×24 in) archival canvas print + digital file', amount: 14900 },
  };
  if (!pkg || !PACKAGES[pkg]) return res.status(400).json({ error: 'Invalid package' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const pack = PACKAGES[pkg];
  const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://pawtraits-omega.vercel.app';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{ price_data: { currency: 'usd', unit_amount: pack.amount, product_data: { name: `Pawtraits — ${pack.label}`, description: pack.description } }, quantity: 1 }],
      shipping_address_collection: { allowed_countries: ['US','GB','CA','AU','DE','FR','IT','ES','NL','AE','SA','SG','JP','NZ','IN','ZA','BR','MX','SE','NO','DK','FI','BE','CH','AT','PL','PT','IE','HK','MY','TH','PH'] },
      shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 0, currency: 'usd' }, display_name: 'Standard Shipping (7–10 business days)', delivery_estimate: { minimum: { unit: 'business_day', value: 7 }, maximum: { unit: 'business_day', value: 10 } } } }],
      custom_fields: [
        { key: 'phone', label: { type: 'custom', custom: 'Phone number (for delivery)' }, type: 'text', optional: true }
      ],
      metadata: { pkg, pkg_label: pack.label, cat_label: catLabel || '', printify_image_id: printifyImageId || '', printify_image_url: printifyImageUrl || '' },
      success_url: `${BASE_URL}/?success=1`,
      cancel_url:  `${BASE_URL}/`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
