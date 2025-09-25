const express = require("express");
const morgan = require("morgan");
const axios = require("axios");
const crypto = require("crypto");
const FormData = require("form-data");

const app = express();

// middlewares
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(":method :url :status :res[content-length] - :response-time ms"));

// صفحة فحص سريعة
app.get("/", (req, res) => {
  res.send("✅ LikeCard connector is running. POST to /webhook");
});

app.get("/_health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), uptime: process.uptime() });
});

// توليد الـ hash حسب متطلبات LikeCard
function generateHash(time) {
  const email = (process.env.LIKECARD_EMAIL || "").toLowerCase().trim();
  const phone = (process.env.LIKECARD_PHONE || "").trim();
  const key = process.env.LIKECARD_HASH_KEY || "";
  return crypto.createHash("sha256").update(`${time}${email}${phone}${key}`).digest("hex");
}

// دالة إرسال الطلب إلى LikeCard
async function createLikeCardOrder(productId, referenceId) {
  const time = Math.floor(Date.now() / 1000).toString();
  const hash = generateHash(time);

  const form = new FormData();
  form.append("deviceId", process.env.LIKECARD_DEVICE_ID);
  form.append("email", (process.env.LIKECARD_EMAIL || "").toLowerCase());
  form.append("phone", process.env.LIKECARD_PHONE);
  form.append("securityCode", process.env.LIKECARD_SECURITY_CODE);
  form.append("langId", "1");
  form.append("productId", String(productId));
  form.append("referenceId", referenceId); // لازم يكون Unique
  form.append("time", time);
  form.append("hash", hash);
  form.append("quantity", "1");

  const resp = await axios.post("https://taxes.like4app.com/online/create_order", form, {
    timeout: 15000,
    headers: {
      ...form.getHeaders(),
      Accept: "application/json",
      "User-Agent": "likecard-connector/1.0 (+render)"
    },
    validateStatus: () => true, // لا ترمِي exception على 4xx
  });

  return resp;
}

// Webhook من Shopify (POST)
app.post("/webhook", async (req, res) => {
  const topic = req.get("x-shopify-topic");
  const order = req.body;

  console.log("📩 Shopify Topic:", topic);
  console.log("🧾 Order name/id:", order?.name, order?.id);
  console.log("🧺 Line items:", order?.line_items?.map(li => ({ title: li.title, sku: li.sku, id: li.product_id })));

  try {
    const first = order?.line_items?.[0];
    const skuOrId = first?.sku || first?.variant_id || first?.product_id;
    if (!skuOrId) throw new Error("No product SKU found in order");

    const ref = `ORDER_${order?.id || Date.now()}`;
    const likeResp = await createLikeCardOrder(String(skuOrId), ref);

    console.log("📦 LikeCard Response:", likeResp.data);
    // رجّع 200 بسرعة عشان Shopify ما يعيد المحاولة كثير
    if (likeResp.status >= 200 && likeResp.status < 300) {
      return res.status(200).send("OK");
    } else {
      return res.status(502).send("LikeCard error");
    }
  } catch (e) {
    console.error("❌ Error in webhook:", e.response?.data || e.message);
    return res.status(500).send("Error");
  }
});

// مسار اختبار يدوي من المتصفح
app.get("/test-likecard/:productId", async (req, res) => {
  try {
    const resp = await createLikeCardOrder(req.params.productId, `MANUAL_${Date.now()}`);
    res.status(resp.status).json(resp.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// المنفذ
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("🔎 Health: GET /  أو  /_health");
  console.log("🪝 Webhook: POST /webhook");
  console.log("🧪 Test: GET /test-likecard/<productId>");
});
