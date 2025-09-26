// Start of the complete server.js file
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');

// --- 1. Environment Variable Setup (from Render) ---
const {
    MERCHANT_EMAIL, MERCHANT_PHONE, HASH_KEY, SECURITY_CODE, DEVICE_ID, LANG_ID,
    SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN
} = process.env;

const LIKE_CARD_BASE_URL = 'https://taxes.like4app.com/online';

// --- 2. Shopify API Client Setup ---
const shopify = shopifyApi({
    apiVersion: LATEST_API_VERSION,
    apiSecretKey: 'dummy-secret',
    adminApiAccessToken: SHOPIFY_ADMIN_TOKEN,
    isCustomStoreApp: true,
    hostName: SHOPIFY_SHOP_DOMAIN,
});
const session = shopify.session.customAppSession(SHOPIFY_SHOP_DOMAIN);
const shopifyClient = new shopify.clients.Graphql({ session });

// --- 3. Helper Functions ---

function generateHash(time) {
    const data = `${time}${MERCHANT_EMAIL.toLowerCase()}${MERCHANT_PHONE}${HASH_KEY}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function likeCardApiCall(endpoint, data) {
    const formData = new FormData();
    for (const key in data) {
        formData.append(key, data[key]);
    }
    const response = await axios.post(`${LIKE_CARD_BASE_URL}${endpoint}`, formData, {
        headers: { ...formData.getHeaders() },
        timeout: 15000
    });
    return response.data;
}

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

// --- 4. Main Webhook Endpoint ---
const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
    res.status(200).send('Webhook received.');

    try {
        const shopifyOrder = req.body;
        const orderId = shopifyOrder.id;
        console.log(`--- Processing Shopify Order ID: ${orderId} ---`);

        let orderNotes = shopifyOrder.note || "";

        for (const item of shopifyOrder.line_items) {
            const productId = item.sku;
            if (!productId) {
                console.warn(`Product "${item.name}" has no SKU. Skipping.`);
                continue;
            }

            const referenceId = `SHOPIFY_${orderId}_${item.id}`;
            const currentTime = Math.floor(Date.now() / 1000).toString();
            
            // Step 1: Create the order using MERCHANT_EMAIL for authentication
            console.log(`Creating LikeCard order for product SKU: ${productId}`);
            const createOrderPayload = {
                deviceId: DEVICE_ID,
                email: MERCHANT_EMAIL, // Use Merchant Email for auth
                securityCode: SECURITY_CODE,
                langId: LANG_ID,
                productId: productId,
                referenceId: referenceId,
                time: currentTime,
                hash: generateHash(currentTime),
                quantity: '1'
            };

            const createOrderResponse = await likeCardApiCall('/create_order', createOrderPayload);
            console.log(`LikeCard order creation responded with:`, createOrderResponse);

            // Step 2: Extract the LikeCard Order ID from the response
            const likeCardOrderId = createOrderResponse.orderId;

            if (!likeCardOrderId) {
                console.error("Could not find 'orderId' in the create order response.", createOrderResponse);
                orderNotes += `\n!! فشل في استلام معرف الطلب من LikeCard للمنتج: ${item.name} !!`;
                continue; 
            }

            console.log(`Fetching details for LikeCard Order ID: ${likeCardOrderId}`);
            
            // Step 3: Fetch details using the NEW LikeCard Order ID
            const detailsPayload = {
                deviceId: DEVICE_ID,
                email: MERCHANT_EMAIL, 
                langId: LANG_ID,
                securityCode: SECURITY_CODE,
                orderId: likeCardOrderId,
            };
            
            const orderDetails = await likeCardApiCall('/orders/details', detailsPayload);

            const serialCode = orderDetails.serials && orderDetails.serials[0] ? orderDetails.serials[0].serialCode : null;
            const serialNumber = orderDetails.serials && orderDetails.serials[0] ? orderDetails.serials[0].serialNumber : null;

            if (serialCode || serialNumber) {
                console.log(`Code received for product ${item.name}: SUCCESS`);
                const newNote = `
--------------------------------
المنتج: ${item.name}
الكود: ${serialCode || 'N/A'}
الرقم التسلسلي: ${serialNumber || 'N/A'}
--------------------------------
`;
                orderNotes += newNote;
            } else {
                console.error("Could not find serial code in LikeCard response:", orderDetails);
                orderNotes += `\n!! فشل استلام كود المنتج: ${item.name} !!`;
            }
        }

        // Step 4: Update Shopify order with all notes
        if (orderNotes !== shopifyOrder.note) {
            await updateShopifyOrderNote(orderId, orderNotes);
        }

        console.log(`--- Finished processing Shopify Order ID: ${orderId} ---`);

    } catch (error) {
        console.error('An error occurred during webhook processing:', error.message);
    }
});

// --- 5. Start the Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
// End of the complete server.js file
