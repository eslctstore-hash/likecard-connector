const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');

// --- 1. إعدادات متغيرات البيئة (التي وضعتها في Render) ---
const {
    MERCHANT_EMAIL, MERCHANT_PHONE, HASH_KEY, SECURITY_CODE, DEVICE_ID, LANG_ID,
    SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN
} = process.env;

const LIKE_CARD_BASE_URL = 'https://taxes.like4app.com/online';

// --- 2. إعداد Shopify API Client ---
const shopify = shopifyApi({
    apiVersion: LATEST_API_VERSION,
    apiSecretKey: 'dummy-secret', // ليس مطلوباً للـ Admin Token Access
    adminApiAccessToken: SHOPIFY_ADMIN_TOKEN,
    isCustomStoreApp: true,
    hostName: SHOPIFY_SHOP_DOMAIN,
});
const session = shopify.session.customAppSession(SHOPIFY_SHOP_DOMAIN);
const shopifyClient = new shopify.clients.Graphql({ session });

// --- 3. الدوال المساعدة ---

// دالة إنشاء الـ Hash
function generateHash(time) {
    const data = `${time}${MERCHANT_EMAIL.toLowerCase()}${MERCHANT_PHONE}${HASH_KEY}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

// دالة موحدة لاستدعاءات LikeCard API
async function likeCardApiCall(endpoint, data) {
    const formData = new FormData();
    for (const key in data) {
        formData.append(key, data[key]);
    }
    const response = await axios.post(`${LIKE_CARD_BASE_URL}${endpoint}`, formData, {
        headers: { ...formData.getHeaders() },
        timeout: 15000 // 15 ثانية
    });
    return response.data;
}

// دالة تحديث ملاحظات الطلب في Shopify
async function updateShopifyOrderNote(orderId, note) {
    console.log(`Updating Shopify order ${orderId} with note.`);
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
                    input: {
                        id: `gid://shopify/Order/${orderId}`,
                        note: note
                    }
                }
            }
        });

        if (response.body.data.orderUpdate.userErrors.length > 0) {
            throw new Error(JSON.stringify(response.body.data.orderUpdate.userErrors));
        }
        console.log(`Successfully updated Shopify order ${orderId}.`);
    } catch (error) {
        console.error(`Failed to update Shopify order ${orderId}:`, error);
        throw error;
    }
}

// --- 4. نقطة النهاية الرئيسية للـ Webhook ---
const app = express();
app.use(express.json());

// تم تحديث الرابط هنا ليتوافق مع إعداداتك في شوبيفاي
app.post('/webhook', async (req, res) => {
    res.status(200).send('Webhook received.'); // إرسال استجابة سريعة أولاً

    // --- بدء المعالجة في الخلفية ---
    try {
        const shopifyOrder = req.body;
        const orderId = shopifyOrder.id;
        console.log(`--- Processing Shopify Order ID: ${orderId} ---`);

        const customerEmail = shopifyOrder.customer.email;
        let orderNotes = shopifyOrder.note || ""; // الحصول على الملاحظات الحالية

        for (const item of shopifyOrder.line_items) {
            const productId = item.sku;
            if (!productId) {
                console.warn(`Product "${item.name}" has no SKU. Skipping.`);
                continue;
            }

            const referenceId = `SHOPIFY_${orderId}_${item.id}`;
            const currentTime = Math.floor(Date.now() / 1000).toString();

            // الخطوة 1: إنشاء الطلب في LikeCard
            console.log(`Creating LikeCard order for product SKU: ${productId}`);
            const createOrderPayload = {
                deviceId: DEVICE_ID, email: customerEmail, securityCode: SECURITY_CODE,
                langId: LANG_ID, productId: productId, referenceId: referenceId,
                time: currentTime, hash: generateHash(currentTime), quantity: '1'
            };

            await likeCardApiCall('/create_order', createOrderPayload);
            console.log(`LikeCard order created with referenceId: ${referenceId}`);

            // --- الخطوة 2: المحاولة المتكررة للحصول على الكود ---
            let serialCode = null;
            let serialNumber = null;
            let orderDetails = null;

            for (let attempt = 0; attempt < 6; attempt++) {
                console.log(`Fetching details (try ${attempt + 1}/6) for referenceId: ${referenceId}`);
                const detailsPayload = {
                    deviceId: DEVICE_ID, email: MERCHANT_EMAIL, langId: LANG_ID,
                    securityCode: SECURITY_CODE, referenceId: referenceId,
                };

                orderDetails = await likeCardApiCall('/orders/details', detailsPayload);

                if (orderDetails.serials && orderDetails.serials[0]) {
                    serialCode = orderDetails.serials[0].serialCode;
                    serialNumber = orderDetails.serials[0].serialNumber;
                }

                if (serialCode || serialNumber) {
                    break; // تم الحصول على الكود و نوقف المحاولات
                }

                if (attempt < 5) {
                    console.log("Co
