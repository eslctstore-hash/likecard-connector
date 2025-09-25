const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// 🔑 دالة لتوليد الـ hash
function generateHash(time) {
  const email = process.env.LIKECARD_EMAIL.toLowerCase();
  const phone = process.env.LIKECARD_PHONE;
  const key = process.env.LIKECARD_HASH_KEY;
  return crypto.createHash('sha256').update(time + email + phone + key).digest('hex');
}

// 📩 Webhook من Shopify
app.post('/shopify/order', async (req, res) => {
  console.log('📩 Shopify Order:', req.body);

  try {
    const order = req.body;
    const lineItem = order.line_items[0]; // ناخذ أول منتج (ممكن تعمل Loop بعدين)

    const timestamp = Math.floor(Date.now() / 1000).toString(); // time بالثواني
    const hash = generateHash(timestamp);

    // طلب LikeCard
    const formData = {
      deviceId: process.env.LIKECARD_DEVICE_ID,
      email: process.env.LIKECARD_EMAIL,
      securityCode: process.env.LIKECARD_SECURITY_CODE,
      langId: "1", // انجليزي
      productId: lineItem.sku, // خلي SKU في Shopify يساوي ProductID من LikeCard
      referenceId: "Shopify_" + order.id, // رقم مرجعي
      time: timestamp,
      hash: hash,
      quantity: "1"
    };

    const response = await axios.post(
      'https://taxes.like4app.com/online/create_order',
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } }
    );

    console.log('📦 LikeCard Response:', response.data);
    res.status(200).send({ success: true, data: response.data });

  } catch (err) {
    console.error('❌ LikeCard Error:', err.response?.data || err.message);
    res.status(500).send({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
