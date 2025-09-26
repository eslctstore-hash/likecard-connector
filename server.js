const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');

// --- 1. إعدادات متغيرات البيئة ---
const {
  MERCHANT_EMAIL, MERCHANT_PHONE, HASH_KEY, SECURITY_CODE, DEVICE_ID, LANG_ID,
  SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN
} = process.env;

const LIKE_CARD_BASE_URL = 'https://taxes.like4app.com/online';

// --- 2. إعداد Shopify API Client ---
const shopify = shopifyApi({
  apiVersion: LATEST_API_VERSION,
  apiSecretKey: 'dummy-secret', // ليس مطلوب مع Admin Token
  adminApiAccessToken: SHOPIFY_ADMIN_TOKEN,
  isCustomStoreApp: true,
  hostName: SHOPIFY_SHOP_DOMAIN,
});
const session = shopify.session.customAppSession(SHOPIFY_SHOP_DOMAIN);
const shopifyClient = new shopify.clients.Graphql({ session });

// --- 3. الدوال المساعدة ---

// إنشاء الهاش
function generateHash(time) {
  const data = `${time}${MERCHANT_EMAIL.toLowerCase()}${MERCHANT_PHONE}${HASH_KEY}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// استدعاء LikeCard API
async function likeCardApiCall(endpoint, data) {
  const formData = new FormData();
  for (const key in data) formData.append(key, data[key]);

  const response = await axios.post(`${LIKE_CARD_BASE_URL}${endpoint}`, formData, {
    headers: { ...formData.getHeaders() },
    timeout: 20000, // 20 ثانية
  });
  return response.data;
}

// تحديث ملاحظات الطلب في Shopify
async function updateShopifyOrderNote(orderId, note) {
  console.log(`📝 Updating Shopify order ${orderId} with note...`);
  try {
    const response = await shopifyClient.query({
      data: {
        query: `mutation orderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { id, note }
            userErrors { field, message }
          }
        }`,
        variables: {
          input: { id: `gid://shopify/Order/${orderId}`, note: note }
        }
      }
    });

    if (response.body.data.orderUpdate.userErrors.length > 0) {
      throw new Error(JSON.stringify(response.body.data.orderUpdate.userErrors));
    }
    console.log(`✅ Shopify order ${orderId} updated successfully.`);
  } catch (error) {
    console.error(`❌ Failed to update Shopify order ${orderId}:`, error);
    throw error;
  }
}

// جلب تفاصيل الطلب من LikeCard مع retry/health-check
async function fetchOrderDetailsWithRetry(referenceId) {
  const detailsPayload = {
    deviceId: DEVICE_ID,
    email: MERCHANT_EMAIL,
    phone: MERCHANT_PHONE,
    langId: LANG_ID,
    securityCode: SECURITY_CODE,
    referenceId: referenceId,
  };

  let orderDetails;
  let success = false;

  // 6 محاولات × 10 ثواني
  for (let i = 0; i < 6; i++) {
    orderDetails = await likeCardApiCall('/orders/details', detailsPayload);
    if (orderDetails.serials && orderDetails.serials.length > 0) {
      success = true;
      break;
    }
    console.log(`⏳ Attempt ${i + 1}/6 failed, retrying in 10s...`);
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  // Health check mode (كل 60 ثانية)
  if (!success) {
    console.log("⚠️ Timeout, entering health-check mode...");
    while (!success) {
      orderDetails = await likeCardApiCall('/orders/details', detailsPayload);
      if (orderDetails.serials && orderDetails.serials.length > 0) {
        success = true;
        break;
      }
      console.log("🔄 Still no data, waiting 60s...");
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
  }

  return orderDetails;
}

// --- 4. Webhook من Shopify ---
const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
  res.status(200).send('Webhook received.'); // رد سريع لـ Shopify

  try {
    const shopifyOrder = req.body;
    const orderId = shopifyOrder.id;
    console.log(`--- 🛒 Processing Shopify Order ID: ${orderId} ---`);

    const customerEmail = shopifyOrder.customer.email;
    let orderNotes = shopifyOrder.note || "";

    for (const item of shopifyOrder.line_items) {
      const productId = item.sku;
      if (!productId) {
        console.warn(`⚠️ Product "${item.name}" has no SKU, skipping.`);
        continue;
      }

      const referenceId = `SHOPIFY_${orderId}_${item.id}`;
      const currentTime = Math.floor(Date.now() / 1000).toString();

      // 1) Create Order
      console.log(`➡️ Creating LikeCard order for SKU: ${productId}`);
      const createOrderPayload = {
        deviceId: DEVICE_ID,
        email: customerEmail,
        phone: MERCHANT_PHONE,
        securityCode: SECURITY_CODE,
        langId: LANG_ID,
        productId: productId,
        referenceId: referenceId,
        time: currentTime,
        hash: generateHash(currentTime),
        quantity: '1'
      };

      const createResponse = await likeCardApiCall('/create_order', createOrderPayload);
      console.log("📦 LikeCard create_order response:", createResponse);

      if (createResponse.response !== 1) {
        console.error("❌ Failed to create LikeCard order:", createResponse);
        orderNotes += `\n!! فشل إنشاء الطلب: ${item.name} (${createResponse.message}) !!`;
        continue;
      }

      // 2) Fetch Details with retry
      console.log(`🔎 Fetching details for referenceId: ${referenceId}`);
      const orderDetails = await fetchOrderDetailsWithRetry(referenceId);

      const serialCode = orderDetails.serials?.[0]?.serialCode || null;
      const serialNumber = orderDetails.serials?.[0]?.serialNumber || null;

      if (serialCode || serialNumber) {
        const newNote = `
--------------------------------
المنتج: ${item.name}
الكود: ${serialCode || 'N/A'}
الرقم التسلسلي: ${serialNumber || 'N/A'}
--------------------------------
`;
        orderNotes += newNote;
        console.log(`✅ Code received for ${item.name}`);
      } else {
        console.error("⚠️ No serials found in LikeCard response:", orderDetails);
        orderNotes += `\n!! لم يتم استلام كود المنتج: ${item.name} !!`;
      }
    }

    // 3) Update Shopify order notes
    if (orderNotes !== shopifyOrder.note) {
      await updateShopifyOrderNote(orderId, orderNotes);
    }

    console.log(`--- ✅ Finished Shopify Order ID: ${orderId} ---`);
  } catch (error) {
    console.error("🔥 Error in webhook processing:", error.message);
  }
});

// --- 5. تشغيل السيرفر ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
