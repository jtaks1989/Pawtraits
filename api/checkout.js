/**
 * /api/checkout
 * Creates a dynamic Stripe Checkout Session so we can:
 *   - Pass the Printify image ID as metadata
 *   - Collect the customer's shipping address for the print order
 *   - Know exactly which package was purchased in the webhook
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY
 *   NEXT_PUBLIC_BASE_URL  (e.g. https://pawtraits-omega.vercel.app)
 */

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Package definitions — prices in cents
const PACKAGES = {
  squire: {
    label:       'Squire Pack',
    description: '8×10 archival canvas print + 300 DPI digital file',
    amount:      4900,   // $49.00
  },
  noble: {
    label:       'Noble Pack',
    description: '12×16 archival canvas print with ornate gold frame + digital file',
    amount:      8900,   // $89.00
  },
  royal: {
    label:       'Royal Pack',
    description: '18×24 archival canvas print with walnut frame + digital file',
    amount:      14900,  // $149.00
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pkg, printifyImageId, printifyImageUrl, catLabel } = req.body;

  if (!pkg || !PACKAGES[pkg]) {
    return res.status(400).json({ error: 'Invalid package' });
  }

  const pack = PACKAGES[pkg];
  const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://pawtraits-omega.vercel.app';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',

      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: pack.amount,
          product_data: {
            name: `Pawtraits — ${pack.label}`,
            description: pack.description,
            images: printifyImageUrl ? [printifyImageUrl] : [],
          },
        },
        quantity: 1,
      }],

      // Collect shipping address — passed to Printify when creating the order
      shipping_address_collection: {
        allowed_countries: [
          'US', 'GB', 'CA', 'AU', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE',
          'AT', 'CH', 'SE', 'NO', 'DK', 'FI', 'IE', 'PT', 'PL', 'CZ',
          'AE', 'SA', 'SG', 'JP', 'NZ',
        ],
      },

      // Shipping options (flat rate — adjust as needed)
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 0, currency: 'usd' },
            display_name: 'Standard Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 7 },
              maximum: { unit: 'business_day', value: 14 },
            },
          },
        },
      ],

      // Store everything needed to fulfil the order via Printify
      metadata: {
        pkg,
        pkg_label:            pack.label,
        cat_label:            catLabel || '',
        printify_image_id:    printifyImageId  || '',
        printify_image_url:   printifyImageUrl || '',
      },

      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${BASE_URL}/#pricing`,
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
