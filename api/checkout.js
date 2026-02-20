module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    pkg, pkgSize, pkgPrice,
    printifyImageId, printifyImageUrl,
    portraitImageUrl,  // Replicate CDN URL — persists ~24h, good for admin download
    catLabel,
  } = req.body;

  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });

  // ── Package definitions (must match frontend data-pkg values) ───────────────
  const PACKAGES = {
    digital: {
      label: 'Instant Masterpiece',
      description: 'High-resolution digital download · No watermark · Commercial use rights',
      baseAmount: 2900,
      physical: false,
    },
    print: {
      label: 'Fine Art Print',
      description: 'Museum-quality archival paper · Fade-resistant inks · Free worldwide shipping',
      baseAmount: 8900,
      physical: true,
    },
    canvas: {
      label: 'Large Canvas',
      description: 'Gallery canvas on wood frame · Ready to hang · Free worldwide shipping',
      baseAmount: 14900,
      physical: true,
    },
  };

  if (!pkg || !PACKAGES[pkg]) {
    return res.status(400).json({ error: `Invalid package: "${pkg}". Must be one of: digital, print, canvas` });
  }

  const pack = PACKAGES[pkg];

  // Accept price from frontend (validated: must be positive number)
  let amount = pack.baseAmount;
  if (pkgPrice) {
    const parsed = parseFloat(String(pkgPrice).replace(/[^0-9.]/g, ''));
    if (!isNaN(parsed) && parsed >= 1) {
      amount = Math.round(parsed * 100);
    }
  }

  const sizeStr = pkgSize ? ` — ${pkgSize.replace('x', ' × ')} cm` : '';
  const productDescription = pack.description + sizeStr;

  // Best available image URL for admin download
  const imageUrlForAdmin = printifyImageUrl || portraitImageUrl || '';

  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(STRIPE_KEY);

    const origin = req.headers.origin || req.headers.referer?.split('/').slice(0,3).join('/') || 'https://pawtraits-omega.vercel.app';

    const sessionParams = {
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          product_data: {
            name: `Pawtraits — ${pack.label}`,
            description: productDescription,
          },
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${origin}/?success=1`,
      cancel_url: `${origin}/`,
      metadata: {
        pkg,
        pkg_label:           pack.label,
        pkg_size:            pkgSize || '',
        cat_label:           catLabel || '',
        printify_image_id:   printifyImageId || '',
        printify_image_url:  imageUrlForAdmin,
        portrait_image_url:  imageUrlForAdmin,  // explicit field for admin download
      },
    };

    // Collect shipping address for physical products
    if (pack.physical) {
      sessionParams.shipping_address_collection = {
        allowed_countries: [
          'US','GB','AE','AU','CA','DE','FR','IT','ES','NL','JP','SG',
          'IN','SA','QA','KW','BH','OM','JO','LB','EG','ZA','BR','MX',
          'SE','NO','DK','FI','PL','PT','AT','CH','BE','IE','NZ','GR',
          'TR','RU','CZ','HU','RO','UA','AR','CL','CO','PE',
        ],
      };
      sessionParams.shipping_options = [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: 0, currency: 'usd' },
          display_name: 'Free Worldwide Shipping',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 7 },
            maximum: { unit: 'business_day', value: 10 },
          },
        },
      }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Checkout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
