const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');

const {
  MERCHANT_EMAIL,
  MERCHANT_PHONE,
  HASH_KEY,
  SECURITY_CODE,
  DEVICE_ID,
  LANG_ID
} = process.env;

const LIKECARD_BASE_URL = 'https://taxes.like4app.com/online';

const app = express();
app.use(express.json());

// === Helper: Generate Hash ===
function generateHash(time) {
  const data = `${time}${MERCHANT_EMAIL.toLowerCase()}${MERCHANT_PHONE}${HASH_KEY}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// === Create LikeCard Order ===
async function createLikeCardOrder(productId, referenceId) {
  const time = Math.floor(Date.now() / 1000).toString();
  const hash = generateHash(time);

  const form = new FormData();
  form.append('deviceId', DEVICE_ID);
  form.append('email', MERCHANT_EMAIL);
  form.append('securityCode', SECURITY_CODE);
  form.append('langId', LANG_ID);
  form.append('productId', productId);
  form.append('referenceId', referenceId);
  form.append('time', time);
  form.append('hash', hash);
  form.append('quantity', '1');
  form.append('optionalFields', '');

  const headers = {
    ...form.getHeaders(),
    'Content-Type': 'multipart/form-data; boundary=---011000010111000001101001'
  };

  const res = await axios.post(`${LIKECARD_BASE_URL}/create_order`, form, { headers });
  return res.data;
}

// === Test endpoint ===
app.get('/test-likecard/:sku', async (req, res) => {
  try {
    const sku = req.params.sku;
    const ref = `TEST_${Date.now()}`;
    const result = await createLikeCardOrder(sku, ref);
    res.json(result);
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
