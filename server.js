// Start of the final and complete server.js file
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const CryptoJS = require("crypto-js");
const { shopifyApi, LATEST_API_VERSION } = require("@shopify/shopify-api");
require("@shopify/shopify-api/adapters/node");

// --- 1. Environment Variable Setup (from Render) ---
const {
    MERCHANT_EMAIL, MERCHANT_PHONE, HASH_KEY, SECURITY_CODE, DEVICE_ID, LANG_ID,
    SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN
} = process.env;

const LIKE_CARD_BASE_URL = "https://taxes.like4app.com/online";

// --- 2. Shopify API Client Setup ---
const shopify = shopifyApi({
    apiVersion: LATEST_API_VERSION,
    apiSecretKey: "dummy-secret",
    adminApiAccessToken: SHOPIFY_ADMIN_TOKEN,
    isCustomStoreApp: true,
    hostName: SHOPIFY_SHOP_DOMAIN,
});
const session = shopify.session.customAppSession(SHOPIFY_SHOP_DOMAIN);
const shopifyClient = new shopify.clients.Graphql({ session });

// --- 3. Helper Functions ---

function generateHash(time) {
    const raw = time + MERCHANT_EMAIL.toLowerCase() + MERCHANT_PHONE + HASH_KEY;
    return CryptoJS.SHA256(raw).toString(CryptoJS.enc.Hex);
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

// UPDATED: This function now saves a note AND a metafield
async function updateShopifyOrder(orderId, note, metafields) {
    console.log(`Updating Shopify order ${orderId} with note and metafields.`);
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
                        note: note,
                        metafields: metafields
                    }
                }
            }
        });

        if (response.body.data.orderUpdate.userErrors.length > 0) {
            throw new Error(JSON.stringify(response.body.data.orderUpdate.userErrors));
        }
        console.log(`✅ Successfully updated Shopify order ${orderId}.`);
    } catch (error) {
        console.error(`❌ Failed to update Shopify order ${orderId}:`, error);
        throw error;
    }
}

// --- 4. Main Webhook Endpoint ---
const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
    res.status(200).send("Webhook received.");

    try {
        const shopifyOrder = req.body;
        const orderId = shopifyOrder.id;
        console.log(`--- Processing Shopify Order ID: ${orderId} ---`);

        let orderNotes = shopifyOrder.note || "";
        const codesForMetafield = [];

        for (const item of shopifyOrder.line_items) {
            const productId = item.sku;
            if (!productId) { continue; }

            const referenceId = `SHOPIFY_${orderId}_${item.id}`;
            const time = Math.floor(Date.now() / 1000).toString();

            console.log(`Creating LikeCard order for product SKU: ${productId}`);
            const createOrderPayload = { deviceId: DEVICE_ID, email: MERCHANT_EMAIL, phone: MERCHANT_PHONE, securityCode: SECURITY_CODE, langId: LANG_ID, productId, referenceId, time, hash: generateHash(time), quantity: "1" };
            const createOrderResponse = await likeCardApiCall("/create_order", createOrderPayload);
            
            // NOTE: The Create Order response now contains the serials directly!
            // We don't need the second API call.
            console.log(`LikeCard order creation responded with:`, createOrderResponse);

            const serialCode = createOrderResponse.serials && createOrderResponse.serials[0] ? createOrderResponse.serials[0].serialCode : null;

            if (serialCode) {
                console.log(`✅ Code received for ${item.name}`);
                const productTitle = item.name;
                
                // Add to the note for admin
                orderNotes += `\n--------------------------------\nالمنتج: ${productTitle}\nالكود: ${serialCode}\n--------------------------------\n`;
                
                // Add to an array for the customer-facing metafield
                codesForMetafield.push({ title: productTitle, code: serialCode });

            } else {
                console.error("❌ No code found in create order response:", createOrderResponse);
                orderNotes += `\n!! فشل استلام كود المنتج: ${item.name} !!`;
            }
        }

        if (codesForMetafield.length > 0) {
            const metafields = [{
                namespace: "digital_product",
                key: "codes",
                type: "json",
                value: JSON.stringify(codesForMetafield)
            }];
            await updateShopifyOrder(orderId, orderNotes, metafields);
        }

        console.log(`--- Finished processing Shopify Order ID: ${orderId} ---`);
    } catch (error) {
        console.error("❌ Error in webhook:", error.message);
    }
});

// --- 5. Run server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
