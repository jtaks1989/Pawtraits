const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory conversation store per phone number
const conversations = {};

const SYSTEM_PROMPT = `You are an elegant portrait consultant for Pawtraits, a luxury bespoke AI portrait studio. Your role is to guide customers through commissioning their aristocratic oil painting portrait via WhatsApp.

CONVERSATION FLOW — follow this order strictly:

STEP 1 — GREETING
Warmly welcome them. Ask what type of portrait they would like:
- Solo Portrait (one person)
- Couples Portrait (two people)  
- Family Portrait (up to 5 people)
- Pet Portrait (cats, dogs, any pet)

STEP 2 — FORMAT
Ask which format they prefer:
- Digital Download — $39 (instant delivery)
- Fine Art Print — printed on archival paper, free delivery
- Canvas Print — gallery quality on wood, ready to hang, free delivery

STEP 3 — SIZE (only if they choose Print or Canvas)
Fine Art Print sizes: 20×25cm ($89) · 30×40cm ($119) · 45×60cm ($199)
Canvas Print sizes: 30×40cm ($299) · 45×60cm ($399) · 60×90cm ($499) · 100×150cm ($899)

STEP 4 — STYLE
Ask which of our 9 portrait styles they prefer. Present them as a numbered list:
1. Belle Époque — romantic early 1900s elegance
2. Casati — dramatic theatrical grandeur  
3. French Romance — soft Parisian oil painting
4. Grand Monarch — full royal regalia
5. Nobel — distinguished scholarly dignity
6. Red Forest — moody autumnal landscape
7. Storm — dramatic atmospheric masterpiece
8. Tweed — refined English countryside
9. Velázquez — Spanish Golden Age opulence

STEP 5 — SUMMARY
Repeat back their full order beautifully before asking for their photo. Example: "Wonderful choice ♛ Here is your order summary..." then list type, format, size, style.

STEP 6 — PHOTO REQUEST
Ask them to send a clear photo. Specify: face clearly visible, good lighting, front-facing preferred. Tell them their preview will be ready within 24 hours.

STEP 7 — CONFIRMATION (when photo is received)
When you see [PHOTO RECEIVED] in their message, confirm warmly. Tell them:
- Their portrait is now being crafted
- They will receive a watermarked preview within 24 hours
- They only pay once they love it
- Thank them for choosing Pawtraits

RULES:
- Be warm, concise, and elegant — this is a luxury service
- Keep replies short — maximum 4 lines unless presenting options
- Use ♛ or ✨ sparingly for elegance
- Never rush — guide them gently through each step one at a time
- If they ask about pricing, answer clearly and move the conversation forward
- If they go off topic, gently bring them back to the portrait order`;

async function sendMessage(to, text) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    }
  );
  const data = await res.json();
  console.log('[WhatsApp] Sent:', JSON.stringify(data));
  return data;
}

async function getReply(phone, userMessage) {
  if (!conversations[phone]) {
    conversations[phone] = [];
  }

  conversations[phone].push({ role: 'user', content: userMessage });

  // Keep last 30 messages
  const history = conversations[phone].slice(-30);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
    ],
    max_tokens: 400,
    temperature: 0.75,
  });

  const reply = completion.choices[0].message.content;
  conversations[phone].push({ role: 'assistant', content: reply });

  return reply;
}

module.exports = async function handler(req, res) {

  // ── WEBHOOK VERIFICATION (Meta sends a GET to verify your endpoint)
  if (req.method === 'GET') {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      console.log('[WhatsApp] Webhook verified');
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  // ── INCOMING MESSAGES
  if (req.method === 'POST') {
    try {
      const body = req.body;

      // Acknowledge immediately — WhatsApp requires fast 200 response
      res.status(200).end();

      if (body.object !== 'whatsapp_business_account') return;

      const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
      if (!messages || messages.length === 0) return;

      const message = messages[0];
      const from    = message.from;
      let userText  = '';

      if (message.type === 'text') {
        userText = message.text.body;
      } else if (['image', 'video', 'document'].includes(message.type)) {
        userText = '[PHOTO RECEIVED]';
      } else {
        return; // ignore audio, stickers etc
      }

      console.log(`[WhatsApp] From: ${from} | Text: ${userText}`);

      const reply = await getReply(from, userText);
      await sendMessage(from, reply);

    } catch (err) {
      console.error('[WhatsApp] Error:', err.message);
    }
    return;
  }

  res.status(405).end();
};
```

---

**Part 2 — Add 3 environment variables to Vercel**

Go to Vercel → Settings → Environment Variables → add these:

| Name | Value |
|------|-------|
| `WHATSAPP_PHONE_ID` | (from Meta, see setup below) |
| `WHATSAPP_TOKEN` | (from Meta, see setup below) |
| `WHATSAPP_VERIFY_TOKEN` | any word you choose e.g. `pawtraits2024` |

---

**Part 3 — Meta WhatsApp Setup (one time)**

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create App**
2. Choose **Business** type → give it a name → Create
3. Inside the app → find **WhatsApp** → click **Set up**
4. You'll see your **Phone Number ID** and a temporary **Access Token** — copy both to Vercel
5. Under **Webhooks** → click **Configure**
6. Set **Callback URL** to: `https://yoursite.com/api/whatsapp`
7. Set **Verify Token** to: `pawtraits2024` (whatever you set above)
8. Subscribe to the **messages** field
9. Click **Verify and Save**

---

**Part 4 — Update the WhatsApp links on your landing page**

In `index.html`, do a find and replace. Change every WhatsApp link text from whatever it currently says to:
```
I am interested in commissioning a portrait from Pawtraits ♛
```

The encoded version for all your `href` links is:
```
https://wa.me/971567481702?text=I%20am%20interested%20in%20commissioning%20a%20portrait%20from%20Pawtraits%20%E2%99%9B
