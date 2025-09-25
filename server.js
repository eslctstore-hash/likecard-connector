const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// استقبال Webhook من Shopify
app.post('/shopify/order', async (req, res) => {
  console.log('📩 Shopify Order:', req.body);

  try {
    // مثال طلب إلى LikeCard API
    const response = await axios.post('https://like4card.com/api/purchase', {
      deviceId: process.env.LIKECARD_DEVICE_ID,
      email: process.env.LIKECARD_EMAIL,
      securityCode: process.env.LIKECARD_SECURITY_CODE,
      phone: process.env.LIKECARD_PHONE,
      hashKey: process.env.LIKECARD_HASH_KEY,
      // بيانات المنتج هنا...
    });

    console.log('📦 LikeCard Response:', response.data);

    res.status(200).send({ success: true, data: response.data });
  } catch (err) {
    console.error('❌ LikeCard Error:', err.message);
    res.status(500).send({ success: false, error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
