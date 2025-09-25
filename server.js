const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const crypto = require("crypto");
const FormData = require("form-data");

const app = express();
app.use(bodyParser.json());

// دالة توليد الـ hash
function generateHash(time) {
  const email = process.env.LIKECARD_EMAIL.toLowerCase();
  const phone = process.env.LIKECARD_PHONE;
  const key = process.env.LIKECARD_HASH_KEY;

  return crypto
    .createHash("sha256")
    .update(time + email + phone + key)
    .digest("hex");
}

// Webhook من Shopify
app.post("/webhook", async (req, res) => {
  try {
    const order = req.body;
    console.log("📩 Shopify Order:", order);

    // خذ SKU من أول منتج (تقدر تعدل حسب احتياجك)
    const lineItem = order.line_items[0];
    const productId = lineItem?.sku || "376"; // SKU تجريبي إذا فاضي

    // تجهيز الوقت والهاش
    const time = Math.floor(Date.now() / 1000).toString();
    const hash = generateHash(time);

    // تجهيز الـ FormData
    const form = new FormData();
    form.append("deviceId", process.env.LIKECARD_DEVICE_ID);
    form.append("email", process.env.LIKECARD_EMAIL.toLowerCase());
    form.append("phone", process.env.LIKECARD_PHONE);
    form.append("securityCode", process.env.LIKECARD_SECURITY_CODE);
    form.append("langId", "1");
    form.append("productId", productId);
    form.append("referenceId", "ORDER_" + Date.now()); // لازم يكون Unique
    form.append("time", time);
    form.append("hash", hash);
    form.append("quantity", "1");

    // إرسال الطلب لـ LikeCard
    const response = await axios.post(
      "https://taxes.like4app.com/online/create_order",
      form,
      { headers: form.getHeaders() }
    );

    console.log("📦 LikeCard Response:", response.data);

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ LikeCard Error:", err.response?.data || err.message);
    res.status(500).send("Error");
  }
});

// المنفذ (Render يستخدم 3000)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
