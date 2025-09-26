const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// صفحة فحص بسيطة
app.get('/', (req, res) => {
  res.send('✅ LikeCard connector is running. Use /webhook for Shopify.');
});

// Webhook من Shopify
app.post('/webhook', async (req, res) => {
  try {
    const order = req.body;
    console.log("📩 Shopify Topic:", req.headers['x-shopify-topic']);
    console.log("🧾 Order name/id:", order.name, order.id);

    // استخراج المنتجات من الطلب
    const items = order.line_items.map(i => ({
      title: i.title,
      sku: i.sku,
      id: i.product_id || i.id
    }));
    console.log("🧺 Line items:", items);

    // تجهيز بيانات LikeCard
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const hash = crypto
      .createHash('sha256')
      .update(
        timestamp +
        process.env.LIKECARD_EMAIL.toLowerCase() +
        process.env.LIKECARD_PHONE +
        process.env.LIKECARD_HASH_KEY
      )
      .digest('hex');

    // إعداد form-data
    const form = new FormData();
    form.append('deviceId', process.env.LIKECARD_DEVICE_ID);
    form.append('email', process.env.LIKECARD_EMAIL);
    form.append('securityCode', process.env.LIKECARD_SECURITY_CODE);
    form.append('langId', '1'); // 1 = عربي
    form.append('productId', items[0]?.id || ''); // <-- هنا صار يرسل id
    form.append('referenceId', `order_${order.id}`);
    form.append('time', timestamp);
    form.append('hash', hash);
    form.append('quantity', '1');

    // إرسال الطلب إلى LikeCard
    const response = await axios.post(
      'https://taxes.like4app.com/online/create_order',
      form,
      { headers: form.getHeaders() }
    );

    console.log("📦 LikeCard Response:", response.data);

    res.status(200).json({ success: true, likecard: response.data });
  } catch (err) {
    console.error("❌ LikeCard Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// تشغيل السيرفر
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("🪝 Webhook: POST /webhook");
  console.log("🧪 Test: GET /");
});
