require('dotenv').config();
const crypto = require('crypto');
const FormData = require('form-data');
const fetch = require('node-fetch');

function generateHash(time) {
  const email = process.env.LC_EMAIL.toLowerCase();
  const phone = process.env.LC_PHONE;
  const key = process.env.LC_KEY;
  return crypto.createHash('sha256').update(time + email + phone + key).digest('hex');
}

async function testOrder() {
  const time = Math.floor(Date.now() / 1000);

  const formData = new FormData();
  formData.append('deviceId', process.env.LC_DEVICE_ID);
  formData.append('email', process.env.LC_EMAIL);
  formData.append('phone', process.env.LC_PHONE);
  formData.append('securityCode', process.env.LC_SECURITY_CODE);
  formData.append('langId', '1');
  formData.append('productId', '376'); // جرب بمنتج تجريبي
  formData.append('referenceId', 'TEST-ORDER-123');
  formData.append('time', time);
  formData.append('hash', generateHash(time));
  formData.append('quantity', '1');

  console.log("🔑 Payload being sent:");
  console.log({
    deviceId: process.env.LC_DEVICE_ID,
    email: process.env.LC_EMAIL,
    phone: process.env.LC_PHONE,
    securityCode: process.env.LC_SECURITY_CODE,
    langId: '1',
    productId: '376',
    referenceId: 'TEST-ORDER-123',
    time,
    hash: generateHash(time),
    quantity: '1'
  });

  const res = await fetch("https://taxes.like4app.com/online/create_order", {
    method: "POST",
    body: formData,
    headers: formData.getHeaders(),
  });

  const data = await res.json();
  console.log("📦 Response from LikeCard:", data);
}

testOrder().catch(err => console.error("❌ Error:", err));
