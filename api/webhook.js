/**
 * /api/webhook
 * Listens for Stripe's `checkout.session.completed` event.
 * When a customer pays, this automatically creates a Printify print order.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET   ← get from Stripe Dashboard → Webhooks
 *   PRINTIFY_API_KEY
 *   PRINTIFY_SHOP_ID
 *
 * Printify product variant IDs (set after creating products in Printify):
 *   PRINTIFY_PRODUCT_ID_SQUIRE   + PRINTIFY_VARIANT_ID_SQUIRE
 *   PRINTIFY_PRODUCT_ID_NOBLE    + PRINTIFY_VARIANT_ID_NOBLE
 *   PRINTIFY_PRODUCT_ID_ROYAL    + PRINTIFY_VARIANT_ID_ROYAL
 *
 * Setup steps:
 *   1. In Stripe Dashboard → Webhooks → Add endpoint
 *      URL: https://pawtraits-omega.vercel.app/api/webhook
 *      Event: checkout.session.completed
 *   2. Copy the signing secret and add as STRIPE_WEBHOOK_SECRET in Vercel
 */

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Map package keys → Printify product + variant IDs (set in Vercel env vars)
function getPrintifyVariant(pkg) {
  const map = {
    squire: {
      product_id: process.env.PRINTIFY_PRODUCT_ID_SQUIRE,
      variant_id: parseInt(process.env.PRINTIFY_VARIANT_ID_SQUIRE),
    },
    noble: {
      product_id: process.env.PRINTIFY_PRODUCT_ID_NOBLE,
      variant_id: parseInt(process.env.PRINTIFY_VARIANT_ID_NOBLE),
    },
    royal: {
      product_id: process.env.PRINTIFY_PRODUCT_ID_ROYAL,
      variant_id: parseInt(process.env.PRINTIFY_VARIANT_ID_ROYAL),
    },
  };
  return map[pkg] || null;
}

// Vercel needs raw body for Stripe signature verification
export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  ()    => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig     = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);
  let event;

  // ── Verify the webhook came from Stripe ──────────────────────────────────
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // ── Handle the payment completed event ───────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const metadata = session.metadata || {};
    const shipping = session.shipping_details;

    const {
      pkg,
      pkg_label,
      cat_label,
      printify_image_id,
      printify_image_url,
    } = metadata;

    console.log(`✅ Payment received for ${pkg_label} — ${session.customer_email}`);

    const PRINTIFY_KEY  = process.env.PRINTIFY_API_KEY;
    const PRINTIFY_SHOP = process.env.PRINTIFY_SHOP_ID;

    if (!PRINTIFY_KEY || !PRINTIFY_SHOP) {
      console.error('Printify env vars missing — skipping order creation');
      return res.status(200).json({ received: true });
    }

    if (!printify_image_id && !printify_image_url) {
      console.error('No Printify image ID/URL in session metadata');
      return res.status(200).json({ received: true });
    }

    const variant = getPrintifyVariant(pkg);
    if (!variant?.product_id || !variant?.variant_id) {
      console.error(`Printify product/variant not configured for package: ${pkg}`);
      return res.status(200).json({ received: true });
    }

    // Build shipping address for Printify
    const addr    = shipping?.address || {};
    const nameParts = (shipping?.name || 'Customer').split(' ');
    const firstName = nameParts[0] || 'Customer';
    const lastName  = nameParts.slice(1).join(' ') || '.';

    // ── Create the Printify order ─────────────────────────────────────────
    try {
      const printifyOrder = await fetch(
        `https://api.printify.com/v1/shops/${PRINTIFY_SHOP}/orders.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${PRINTIFY_KEY}`,
          },
          body: JSON.stringify({
            external_id: session.id,   // Stripe session ID as our reference
            label: `${cat_label || 'Portrait'} — ${pkg_label}`,
            line_items: [
              {
                product_id: variant.product_id,
                variant_id: variant.variant_id,
                quantity:   1,
                // Apply the customer's portrait to the print area
                print_areas: {
                  front: printify_image_url || '',
                },
                // If we have the Printify image ID, use it directly
                ...(printify_image_id ? { metadata: { image_id: printify_image_id } } : {}),
              },
            ],
            shipping_method: 1,  // Standard shipping
            send_shipping_notification: true,
            address_to: {
              first_name: firstName,
              last_name:  lastName,
              email:      session.customer_email || session.customer_details?.email || '',
              phone:      session.customer_details?.phone || '',
              country:    addr.country  || 'US',
              region:     addr.state    || '',
              address1:   addr.line1    || '',
              address2:   addr.line2    || '',
              city:       addr.city     || '',
              zip:        addr.postal_code || '',
            },
          }),
        }
      );

      if (!printifyOrder.ok) {
        const errText = await printifyOrder.text();
        console.error('Printify order creation failed:', errText);
      } else {
        const orderData = await printifyOrder.json();
        console.log(`🖨️  Printify order created: ${orderData.id}`);
      }
    } catch (printifyErr) {
      console.error('Printify order error:', printifyErr.message);
    }
  }

  return res.status(200).json({ received: true });
}
