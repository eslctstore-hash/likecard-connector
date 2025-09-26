// server.js
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');

// --- 1. متغيرات البيئة ---
const {
  MERCHANT_EMAIL, MERCHANT_PHONE, HASH_KEY, SECURITY_CODE, DEVICE_ID, LANG_ID,
  SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN
} = process.env;

const LIKE_CARD_BASE_URL = 'https://taxes.like4app.com/online';

// --- 2. إعداد Shopify API Client ---
const shopify = shopifyApi({
  apiVersion: LATEST_API_VERSION,
  apiSecretKey: 'dummy-secret', // غير مستخدم مع Admin Token
  adminApiAccessToken: SHOPIFY_ADMIN_TOKEN,
  isCustomStoreApp: true,
  hostName: SHOPIFY_SHOP_DOMAIN,
});
const session = shopify.session.customAppSession(SHOPIFY_SHOP_DOMAIN);
const shopifyClient = new shopify.clients.Graphql({ session });

// --- 3. دوال مساعدة ---
// توليد الهاش
function generateHash(time) {
  const data = `${time}${MERCHANT_EMAIL.toLowerCase()}${MERCHANT_PHONE}${HASH_KEY}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// استدعاء API LikeCard
async function likeCardApiCall(endpoint, data) {
  const formData = new FormData();
  for (const key in data) {
    formData.append(key, data[key]);
  }
  const response = await axios.post(`${LIKE_CARD_BASE_URL}${endpoint}`, formData, {
    headers: formData.getHeaders(),
    timeout: 15000
  });
  return response.data;
}

// تحديث ملاحظات الطلب
async function updateShopifyOrderNote(orderId, note) {
  console.log(`📝 Updating Shopify order ${orderId}`);
  const response = await shopifyClient.request(`
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id, note }
        userErrors { field, message }
      }
    }`,
    { variables: { input: { id: `gid://shopify/Order/${orderId}`, note } } }
  );

  if (response.body.data.orderUpdate.userErrors.length > 0) {
    console.error("Shopify update error:", response.body.data.orderUpdate.userErrors);
    throw new Error(JSON.stringify(response.body.data.orderUpdate.userErrors));
  }
  console.log(`✅ Shopify order ${orderId} updated`);
}

// --- 4. السيرفر ---
const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
  res.status(200).send('Webhook received');

  try {
    const shopifyOrder = req.body;
    console.log("📩 Incoming webhook:", JSON.stringify(shopifyOrder, null, 2));

    const orderId = shopifyOrder.id;
    let orderNotes = shopifyOrder.note || "";

    for (const item of shopifyOrder.line_items) {
      const productId = item.sku;
      if (!productId) continue;

      const referenceId = `SHOPIFY_${orderId}_${item.id}`;
      const currentTime = Math.floor(Date.now() / 1000).toString();

      // 1. إنشاء الطلب في LikeCard
      const createOrderPayload = {
        deviceId: DEVICE_ID,
        email: MERCHANT_EMAIL,  // 👈 تم التعديل هنا
        securityCode: SECURITY_CODE,
        langId: LANG_ID,
        productId: productId,
        referenceId: referenceId,
        time: currentTime,
        hash: generateHash(currentTime),
        quantity: '1'
      };

      console.log(`🛒 Creating LikeCard order for SKU: ${productId}`);
      const createResp = await likeCardApiCall('/create_order', createOrderPayload);
      console.log("📦 LikeCard create response:", createResp);

      // تأخير بسيط
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 2. جلب تفاصيل الطلب من LikeCard
      const detailsPayload = {
        deviceId: DEVICE_ID,
        email: MERCHANT_EMAIL,
        securityCode: SECURITY_CODE,
        langId: LANG_ID,
        referenceId: referenceId
      };

      const detailsResp = await likeCardApiCall('/orders/details', detailsPayload);
      console.log("🔎 LikeCard order details:", detailsResp);

      const serialCode = detailsResp.serials?.[0]?.serialCode || null;
      const serialNumber = detailsResp.serials?.[0]?.serialNumber || null;

      if (serialCode || serialNumber) {
        orderNotes += `
--------------------------------
المنتج: ${item.name}
الكود: ${serialCode || 'N/A'}
الرقم التسلسلي: ${serialNumber || 'N/A'}
--------------------------------
`;
      } else {
        orderNotes += `\n⚠️ فشل استلام كود المنتج: ${item.name}`;
      }
    }

    // 3. تحديث الملاحظات في Shopify
    if (orderNotes !== shopifyOrder.note) {
      await updateShopifyOrderNote(orderId, orderNotes);
    }

    console.log(`--- Finished Shopify Order ${orderId} ---`);
  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
  }
});

// --- 5. تشغيل السيرفر ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
