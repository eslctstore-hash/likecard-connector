// server.js
require('@shopify/shopify-api/adapters/node');

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');

const app = express();
app.use(express.json());

// ========= 1) ENV =========
const {
  DEVICE_ID,
  MERCHANT_EMAIL,
  MERCHANT_PHONE,
  HASH_KEY,
  SECURITY_CODE,
  LANG_ID = '1',

  SHOPIFY_SHOP_DOMAIN,
  SHOPIFY_ADMIN_TOKEN,

  // اختياري: JSON string مثل {"376":"376","14:200008910#Off white Standard":"200008910"}
  LIKECARD_PRODUCT_MAP
} = process.env;

if (!DEVICE_ID || !MERCHANT_EMAIL || !MERCHANT_PHONE || !HASH_KEY || !SECURITY_CODE) {
  console.error('❌ Missing LikeCard ENV variables. Please set DEVICE_ID, MERCHANT_EMAIL, MERCHANT_PHONE, HASH_KEY, SECURITY_CODE');
}

if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  console.error('❌ Missing Shopify ENV variables. Please set SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN');
}

const LIKECARD_BASE = 'https://taxes.like4app.com/online';

// ========= 2) Shopify Client =========
const shopify = shopifyApi({
  apiVersion: LATEST_API_VERSION,
  isCustomStoreApp: true,
  adminApiAccessToken: SHOPIFY_ADMIN_TOKEN,
  hostName: SHOPIFY_SHOP_DOMAIN,
});
const session = shopify.session.customAppSession(SHOPIFY_SHOP_DOMAIN);
const shopifyClient = new shopify.clients.Graphql({ session });

// ========= 3) Helpers =========
const productMap = (() => {
  try {
    return LIKECARD_PRODUCT_MAP ? JSON.parse(LIKECARD_PRODUCT_MAP) : {};
  } catch (e) {
    console.warn('⚠️ Failed to parse LIKECARD_PRODUCT_MAP. It should be valid JSON.');
    return {};
  }
})();

function generateTime() {
  return Math.floor(Date.now() / 1000).toString();
}

function generateHash(time) {
  const data = `${time}${MERCHANT_EMAIL.toLowerCase()}${MERCHANT_PHONE}${HASH_KEY}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// حاول نجيب productId صالح لLikeCard (من الخريطة أولًا، ثم استخراج رقم من الـ SKU)
function resolveLikecardProductId(item) {
  // 1) من الخريطة
  if (productMap && item.sku && productMap[item.sku] && /^\d+$/.test(String(productMap[item.sku]))) {
    return String(productMap[item.sku]);
  }
  // 2) لو الـ SKU نفسه رقم صافي
  if (item.sku && /^\d+$/.test(item.sku)) {
    return item.sku;
  }
  // 3) استخرج أول رقم طويل من الـ SKU (مثلا 200008910 من "14:200008910#Off white Standard")
  if (item.sku) {
    const match = String(item.sku).match(/(\d{3,})/); // أي رقم طوله 3+ أرقام
    if (match) return match[1];
  }
  // 4) أخيرًا جرّب id المنتج من شوبيفاي إذا كان رقم
  if (item.product_id && /^\d+$/.test(String(item.product_id))) {
    return String(item.product_id);
  }
  return null;
}

// استدعاء LikeCard (يضيف time+hash تلقائيًا إن لم تُمرر)
async function likeCardCall(endpoint, payload = {}, { includeAuth = true } = {}) {
  const form = new FormData();
  const finalData = { ...payload };

  if (includeAuth) {
    // حقول الأمان المطلوبة دائمًا تقريبًا
    const time = generateTime();
    finalData.time = finalData.time || time;
    finalData.hash = finalData.hash || generateHash(finalData.time);
  }

  for (const k of Object.keys(finalData)) {
    form.append(k, finalData[k]);
  }

  const { data } = await axios.post(`${LIKECARD_BASE}${endpoint}`, form, {
    headers: form.getHeaders(),
    timeout: 20000,
  });
  return data;
}

// حفظ الأكواد في Metafield على الطلب (type: json)
async function saveCodesToMetafield(orderId, lineItemId, serials) {
  try {
    const metafieldKey = `serials_${lineItemId}`;
    const res = await shopifyClient.request({
      data: {
        query: `
          mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id key namespace type }
              userErrors { field message code }
            }
          }
        `,
        variables: {
          metafields: [{
            ownerId: `gid://shopify/Order/${orderId}`,
            namespace: "likecard",
            key: metafieldKey,
            type: "json",
            value: JSON.stringify(serials)
          }]
        }
      }
    });

    const errs = res.body?.data?.metafieldsSet?.userErrors || [];
    if (errs.length) {
      console.warn('⚠️ metafieldsSet userErrors:', errs);
    } else {
      console.log(`✅ Saved codes in metafield likecard/${metafieldKey}`);
    }
  } catch (e) {
    console.error('❌ Failed to save metafield:', e?.response?.data || e.message);
  }
}

// تحديث الملاحظات (اختياري كسرد نصي مختصر)
async function appendNote(orderId, textToAppend) {
  try {
    const res = await shopifyClient.request({
      data: {
        query: `
          mutation orderUpdate($input: OrderInput!) {
            orderUpdate(input: $input) {
              order { id note }
              userErrors { field message }
            }
          }
        `,
        variables: {
          input: {
            id: `gid://shopify/Order/${orderId}`,
            note: textToAppend
          }
        }
      }
    });

    const errz = res.body?.data?.orderUpdate?.userErrors || [];
    if (errz.length) {
      console.warn('⚠️ orderUpdate userErrors:', errz);
    } else {
      console.log(`✅ Note updated for order ${orderId}`);
    }
  } catch (e) {
    console.error('❌ Failed to update order note:', e?.response?.data || e.message);
  }
}

// جلب تفاصيل الطلب من LikeCard مع Polling (مرات متعددة)
async function fetchOrderDetailsWithPolling(referenceId, tries = 6, delayMs = 2000) {
  for (let i = 1; i <= tries; i++) {
    const payload = {
      deviceId: DEVICE_ID,
      email: MERCHANT_EMAIL,        // مهم: نفس بريد التاجر
      securityCode: SECURITY_CODE,
      langId: LANG_ID,
      referenceId
      // time/hash تُضاف تلقائيًا داخل likeCardCall
    };

    const details = await likeCardCall('/orders/details', payload, { includeAuth: true });

    // شكل الاستجابة يمكن يختلف، فنتعامل مع أكثر من احتمال
    const hasSerialsArray = Array.isArray(details?.serials) && details.serials.length > 0;
    const altSerials = Array.isArray(details?.cards) && details.cards.length > 0 ? details.cards : null;

    if (details?.response === 1 && (hasSerialsArray || altSerials)) {
      return { ok: true, data: details };
    }

    const msg = (details && (details.message || details.error || details.msg)) || '';
    console.log(`⏳ [${i}/${tries}] LikeCard details:`, msg || details);

    // لو قال "No Data About This Order" أو ما فيه بيانات، نعيد المحاولة
    if (i < tries) await new Promise(r => setTimeout(r, delayMs));
  }

  return { ok: false, data: null };
}

// ========= 4) Routes =========
app.get('/', (_req, res) => {
  res.send('✅ LikeCard connector is running. POST to /webhook');
});

// رجّع الأكواد المخزنة في Metafields للطلب
app.get('/order/:id/codes', async (req, res) => {
  try {
    const orderGid = `gid://shopify/Order/${req.params.id}`;
    const result = await shopifyClient.request({
      data: {
        query: `
          query getOrder($id: ID!) {
            order(id: $id) {
              id
              metafields(first: 50, namespace: "likecard") {
                edges { node { key type value } }
              }
            }
          }
        `,
        variables: { id: orderGid }
      }
    });

    const edges = result.body?.data?.order?.metafields?.edges || [];
    res.json({
      orderId: req.params.id,
      likecardMetafields: edges.map(e => e.node)
    });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || e.message });
  }
});

// Webhook من Shopify (orders/paid مثلاً)
app.post('/webhook', async (req, res) => {
  // رد سريع لشوبيفاي
  res.status(200).send('OK');

  try {
    const order = req.body;
    const orderId = order?.id;
    if (!orderId) {
      console.warn('⚠️ Missing order.id in webhook payload');
      return;
    }

    console.log(`--- Processing Shopify Order ID: ${orderId} ---`);
    const baseNoteLines = [];

    for (const item of (order.line_items || [])) {
      const likecardProductId = resolveLikecardProductId(item);
      if (!likecardProductId) {
        console.warn(`⚠️ Cannot resolve LikeCard productId for line "${item.name}" (sku: ${item.sku}) — skipping.`);
        baseNoteLines.push(`لم يُحدّد رقم منتج LikeCard للبند: ${item.name}`);
        continue;
      }

      const quantity = String(item.quantity || 1);
      const referenceId = `SHOPIFY_${orderId}_${item.id}`;

      // 1) Create Order at LikeCard — استخدم دائمًا بريد التاجر + time/hash
      const createPayload = {
        deviceId: DEVICE_ID,
        email: MERCHANT_EMAIL,        // مهم: بريد التاجر وليس العميل
        securityCode: SECURITY_CODE,
        langId: LANG_ID,
        productId: likecardProductId,
        referenceId,
        quantity
        // time/hash تُضاف تلقائيًا
      };

      console.log(`🛒 Creating LikeCard order: productId=${likecardProductId}, qty=${quantity}, ref=${referenceId}`);
      const createRes = await likeCardCall('/create_order', createPayload, { includeAuth: true });
      console.log('➡️ LikeCard create_order response:', createRes);

      if (createRes?.response !== 1) {
        const msg = createRes?.message || createRes?.error || 'Create order failed';
        console.error('❌ LikeCard create_order failed:', msg);
        baseNoteLines.push(`فشل إنشاء طلب LikeCard للبند: ${item.name} — ${msg}`);
        continue;
      }

      // 2) Poll details
      const detailsRes = await fetchOrderDetailsWithPolling(referenceId, 8, 2000);
      if (!detailsRes.ok) {
        console.error('❌ Could not fetch LikeCard details for ref:', referenceId);
        baseNoteLines.push(`لم تصل أكواد ${item.name} بعد (سيتم الاستعلام لاحقًا).`);
        continue;
      }

      const details = detailsRes.data;
      // جرّب أكثر من مسمى لمصفوفة الأكواد
      const serials =
        (Array.isArray(details?.serials) && details.serials) ||
        (Array.isArray(details?.cards) && details.cards) ||
        [];

      // حفظها في Metafield بصيغة JSON
      await saveCodesToMetafield(orderId, item.id, serials);

      // اختياري: سطر مختصر في note للتتبع
      baseNoteLines.push(`استلام أكواد ${item.name}: ${serials.length} كود`);
    }

    // لو ودك تخلي ملخص صغير في note (اختياري)
    if (baseNoteLines.length) {
      const summary = `LikeCard Summary:\n${baseNoteLines.map(l => `• ${l}`).join('\n')}`;
      await appendNote(orderId, summary);
    }

    console.log(`--- Finished processing Shopify Order ID: ${orderId} ---`);
  } catch (e) {
    console.error('❌ Webhook processing error:', e?.response?.data || e.message);
  }
});

// ========= 5) Test route =========
// اختبار إنشاء/جلب يدويًا من خلال متصفح/بوستمان
app.get('/test-likecard/:productId', async (req, res) => {
  try {
    const productId = req.params.productId;
    const referenceId = `TEST_${Date.now()}`;
    const qty = '1';

    const createPayload = {
      deviceId: DEVICE_ID,
      email: MERCHANT_EMAIL,
      securityCode: SECURITY_CODE,
      langId: LANG_ID,
      productId,
      referenceId,
      quantity: qty
    };
    const createRes = await likeCardCall('/create_order', createPayload, { includeAuth: true });

    let detailsRes = await fetchOrderDetailsWithPolling(referenceId, 8, 2000);
    res.json({ createRes, detailsRes });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || e.message });
  }
});

// ========= 6) Start =========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🪝 Webhook: POST /webhook');
  console.log('🧪 Test: GET /test-likecard/<likecardProductId>');
  console.log('🔎 Get Codes: GET /order/<shopifyOrderId>/codes');
});

