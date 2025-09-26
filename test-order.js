const fetch = require('node-fetch');
const FormData = require('form-data');
const crypto = require('crypto');
require('dotenv').config();

async function testOrder() {
  const time = Math.floor(Date.now() / 1000);

  const email = process.env.LC_EMAIL.toLowerCase();
  const phone = process.env.LC_PHONE;
  const key = process.env.LC_KEY;

  const hash = crypto
    .createHash('sha256')
    .update(time + email + phone + key)
    .digest('hex');

  const formData = new FormData();
  formData.append('deviceId', process.env.LC_DEVICE_ID);
  formData.append('email', email);
  formData.append('phone', phone);
  formData.append('securityCode', process.env.LC_SECURITY_CODE);
  formData.append('langId', '1');
  formData.append('productId', '376'); // جرّب بمنتج تجريبي
  formData.append('referenceId', Date.now().toString());
  formData.append('time', time);
  formData.append('hash', hash);
  formData.append('quantity', '1');
  formData.append('optionalFields', '');

  console.log('🔑 Payload being sent:');
  for (const [k, v] of formData.entries()) {
    console.log(`${k}: ${v}`);
  }

  try {
    const res = await fetch('https://taxes.like4app.com/online/create_order', {
      method: 'POST',
      body: formData,
    });

    const text = await res.text();
    console.log('📦 Response:', text);
  } catch (err) {
    console.error('❌ Error sending request:', err);
  }
}

testOrder();
