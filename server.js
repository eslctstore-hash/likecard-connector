const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');

require('dotenv').config();

const {
  MERCHANT_EMAIL,
  MERCHANT_PHONE,
  HASH_KEY,
  SECURITY_CODE,
  DEVICE_ID,
  LANG_ID,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_SHOP_DOMAIN
} = process.env;

const LIKECARD_BASE_URL = 'https://taxes.like4app.com/online';

const app = express();
app.use(express.json());

// ===== Helper: Generate Hash =====
function generateHash(time) {
  const data = `${time}${MERCHANT_EMAIL.toLowerCase()}${MERCHANT_PHONE}${HASH_KEY}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ===== Helper: Call LikeCard API =====
async function likeCardApi(endpoint, data) {
  const form = new FormData();
  for (const key in data) form.append(key, data[key]);

  const res = await axios.post(`${LIKECARD_BASE_URL}${endpoint}`, form, {
    headers: form.getHeaders(),
    timeout: 15000,
  });
  return res.data;
}

// ===== Helper: Update Shopify Order (note field) =====
async function updateShopifyOrderNote(orderId, note) {
  try {
    const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/orders/${orderId}.json`;
    await axios.put(
      url,
      { order: { id: orderId, note } },
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } }
    );
    console.log(`✅ Updated Shopify order ${orderId} with note`);
  } catch (err) {
    console.error('❌ Failed to update Shopify order:', err.response?.data || err.message);
  }
}

// ===== Webhook: Shopify Orders =====
app.post('/webhook', async (req, res) => {
  res.status(200).send('Webhook received');
  const order = req.body;

  try {
    const orderId = order.id;
    let orderNotes = order.note || "";

    console.log(`--- Processing Shopify Order ${orderId} ---`);

    for (const item of order.line_items) {
      const productId = item.sku;
      if (!productId) {
        console.warn(`⚠️ Item "${item.name}" has no SKU. Skipping.`);
        continue;
      }

      const referenceId = `SHOPIFY_${orderId}_${item.id}`;
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const hash = generateHash(timestamp);

      // Step 1: Create LikeCard Order
      const createPayload = {
        deviceId: DEVICE_ID,
        email: MERCHANT_EMAIL,
        securityCode: SECURITY_CODE,
        langId: LANG_ID,
        productId: productId,
        referenceId,
        time: timestamp,
        hash,
        quantity: '1'
      };

      console.log(`🛒 Creating LikeCard order for SKU: ${productId}`);
      const createResp = await likeCardApi('/create_order', createPayload);
      console.log('📦 LikeCard create response:', createResp);

      // Delay before fetching details
      await new Promise(r => setTimeout(r, 3000));

      // Step 2: Fetch Order Details
      const detailsPayload = {
        deviceId: DEVICE_ID,
        email: MERCHANT_EMAIL,
        securityCode: SECURITY_CODE,
        langId: LANG_ID,
        referenceId
      };

      const detailsResp = await likeCardApi('/orders/details', detailsPayload);
      console.log('🔎 LikeCard order details:', detailsResp);

      const serial = detailsResp?.serials?.[0]?.serialCode || null;

      if (serial) {
        orderNotes += `
------------------------------
المنتج: ${item.name}
الكود: ${serial}
------------------------------
`;
      } else {
        orderNotes += `\n⚠️ لم يتم استلام كود المنتج: ${item.name}`;
      }
    }

    // Step 3: Update Shopify Order Note
    await updateShopifyOrderNote(order.id, orderNotes);

    console.log(`--- Finished Shopify Order ${order.id} ---`);
  } catch (err) {
    console.error('❌ Error in webhook processing:', err.message);
  }
});

// ===== Health Check =====
app.get('/', (req, res) => {
  res.send('✅ LikeCard Connector is running');
});

// ===== Start Server =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
