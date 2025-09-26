const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');

// --- 1. إعدادات متغيرات البيئة (التي وضعتها في Render) ---
const {
    MERCHANT_EMAIL, MERCHANT_PHONE, HASH_KEY, SECURITY_CODE, DEVICE_ID, LANG_ID,
    SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN,
    SERIAL_SECRET_KEY, SERIAL_SECRET_IV
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

// --- دالة لفك تشفير serialCode ---
function decryptSerial(encryptedTxt, secretKey, secretIv) {
    const encryptMethod = 'aes-256-cbc';
    const key = crypto.createHash('sha256').update(secretKey).digest();
    const iv = crypto.createHash('sha256').update(secretIv).digest().slice(0, 16);

    const decipher = crypto.createDecipheriv(encryptMethod, key, iv);
    let decoded = decipher.update(Buffer.from(encryptedTxt, 'base64'));
    decoded = Buffer.concat([decoded, decipher.final()]);
    return decoded.toString();
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
            const createOrderPayload = {
                deviceId: DEVICE_ID,
                email: MERCHANT_EMAIL,
                securityCode: SECURITY_CODE,
                langId: LANG_ID,
                productId: productId,
                referenceId: referenceId,
                time: currentTime,
                hash: generateHash(currentTime),
                quantity: '1'
            };

            console.log("CreateOrder Payload being sent to LikeCard:", createOrderPayload);
            const createResponse = await likeCardApiCall('/create_order', createOrderPayload);
            console.log("LikeCard create_order response:", createResponse);
            console.log(`LikeCard order created with referenceId: ${referenceId}`);

            // --- الخطوة 2: المحاولة المتكررة للحصول على تفاصيل الطلب ---
            let serialCode = null;
            let serialNumber = null;
            let productName = null;
            let orderDetails = null;

            for (let attempt = 0; attempt < 6; attempt++) {
                const detailsPayload = {
                    deviceId: DEVICE_ID,
                    email: MERCHANT_EMAIL,
                    langId: LANG_ID,
                    securityCode: SECURITY_CODE,
                    referenceId: referenceId,
                };

                console.log(`Fetching details (try ${attempt + 1}/6) with payload:`, detailsPayload);
                orderDetails = await likeCardApiCall('/orders/details', detailsPayload);
                console.log("LikeCard orders/details response:", orderDetails);

                if (orderDetails.response === 1 && orderDetails.serials && orderDetails.serials[0]) {
                    productName = orderDetails.serials[0].productName;
                    serialNumber = orderDetails.serials[0].serialNumber;

                    try {
                        serialCode = decryptSerial(
                            orderDetails.serials[0].serialCode,
                            SERIAL_SECRET_KEY,
                            SERIAL_SECRET_IV
                        );
                    } catch (err) {
                        console.error("Error decrypting serialCode:", err.message);
                    }
                }

                if (serialCode) {
                    break; // تم الحصول على الكود و نوقف المحاولات
                }

                if (attempt < 5) {
                    console.log("Code not ready yet, waiting 10 seconds before retry...");
                    await new Promise(resolve => setTimeout(resolve, 10000)); // 10 ثواني
                }
            }

            // بعد انتهاء المحاولات
            if (serialCode) {
                console.log(`Code received for product ${item.name}: SUCCESS`);
                const newNote = `
--------------------------------
المنتج: ${item.name} (${productName || 'N/A'})
الكود: ${serialCode || 'N/A'}
الرقم التسلسلي: ${serialNumber || 'N/A'}
--------------------------------
`;
                orderNotes += newNote;
            } else {
                console.error("Could not retrieve or decrypt serial code after 6 tries:", orderDetails);
                orderNotes += `\n!! فشل استلام كود المنتج: ${item.name} !!`;
            }
        }

        // الخطوة 3: تحديث طلب Shopify بالملاحظات الجديدة التي تحتوي على الأكواد
        if (orderNotes !== shopifyOrder.note) {
            await updateShopifyOrderNote(orderId, orderNotes);
        }

        console.log(`--- Finished processing Shopify Order ID: ${orderId} ---`);
    } catch (error) {
        console.error('An error occurred during webhook processing:', error.message);
    }
});

// --- 5. تشغيل السيرفر ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

