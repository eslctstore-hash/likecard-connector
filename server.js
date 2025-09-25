const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const morgan = require('morgan');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(morgan('dev'));

// 🔑 دالة لتوليد الهاش حسب متطلبات LikeCard
function generateHash(time) {
  const email = process.env.LIKECARD_EMAIL.toLowerCase();
  const phone = process.env.LIKECARD_PHONE;
  const key = process.env.LIKECARD_HASH_KEY;

  return crypto.createHash('sha256')
    .update(time + email + phone + key)
    .digest('hex');
}

// 🏠 مسار رئيسي للتأكد أن السيرفر شغال
app.get('/', (req, res) => {
  res.send('✅ LikeCard connector is running. POST to /webhook');
});

// 🧪 مسار اختبار يدوي
app.get('/test-likecard/:productId', async (req, res) => {
  try {
    const productId = req.params.productId;
    const time = Math.floor(Date.now() / 1000).toString();
    const hash = generateHash(time);

    const response = await axios.post(
      'https://taxes.like4app.com/online/create_order',
      {
        deviceId: process.env.LIKECARD_DEVICE_ID,
        email: process.env.LIKECARD_EMAIL,
        securityCode: process.env.LIKECARD_SECURITY_CODE,
        langId: "1",
        productId,
        referenceId: "Test_" + Date.now(),
        time,
        hash,
        quantity: "1"
      },
      { headers: { "Content-Type": "multipart/form-data" } }
    );

    res.json(response.data);
  } catch (err) {
    console.error("❌ Test LikeCard Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 🪝 Webhook من Shopify
app.post('/webhook', async (req, res) => {
  const topic = req.headers['x-shopify-topic'];
  const order = req.body;

  console.log("📩 Shopify Topic:", topic);
  console.log("🧾 Order name/id:", order.name, order.id);

  const lineItems = order.line_items.map(item => ({
    title: item.title,
    sku: item.sku,
    id: item.product_id
  }));
  console.log("🧺 Line items:", lineItems);

  try {
    // مثال: معالجة أول منتج فقط (تقدر توسعها لاحقًا)
    const productId = lineItems[0]?.sku || "376";

    const time = Math.floor(Date.now() / 1000).toString();
    const hash = generateHash(time);

    const response = await axios.post(
      'https://taxes.like4app.com/online/create_order',
      {
        deviceId: process.env.LIKECARD_DEVICE_ID,
        email: process.env.LIKECARD_EMAIL,
        securityCode: process.env.LIKECARD_SECURITY_CODE,
        langId: "1",
        productId,
        referenceId: "Order_" + order.id,
        time,
        hash,
        quantity: "1"
      },
      { headers: { "Content-Type": "multipart/form-data" } }
    );

    console.log("📦 LikeCard Response:", response.data);
    res.status(200).json(response.data);

  } catch (err) {
    console.error("❌ LikeCard Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 🚀 شغل السيرفر على المنفذ اللي توفره Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("🔎 Health: GET /  أو  /_health");
  console.log("🪝 Webhook: POST /webhook");
  console.log("🧪 Test: GET /test-likecard/<productId>");
});
