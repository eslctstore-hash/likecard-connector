const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const CryptoJS = require("crypto-js");
const { shopifyApi, LATEST_API_VERSION } = require("@shopify/shopify-api");
require("@shopify/shopify-api/adapters/node");

const app = express();
app.use(express.json());

// ✅ بياناتك الحقيقية (أو من env variables)
const MERCHANT_EMAIL = process.env.MERCHANT_EMAIL || "e.slct.store@gmail.com";
const MERCHANT_PHONE = process.env.MERCHANT_PHONE || "96879303771";
const HASH_KEY = process.env.HASH_KEY || "8Tyr4EDw!2sN";
const DEVICE_ID =
  process.env.DEVICE_ID ||
  "9b248ea71f0120c0e545294cb17e2bc379a141450c29a142918de8f7fdb1788f";
const SECURITY_CODE =
  process.env.SECURITY_CODE ||
  "4a8db3af2d679007d4ed65a0e77ecd057f9b65f6f28cffd9e2f9a790b89271a2";
const LANG_ID = process.env.LANG_ID || "1";

const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const LIKE_CARD_BASE_URL = "https://taxes.like4app.com/online";

// ✅ توليد time + hash
function generateHash(time) {
  const raw = time + MERCHANT_EMAIL.toLowerCase() + MERCHANT_PHONE + HASH_KEY;
  return CryptoJS.SHA256(raw).toString(CryptoJS.enc.Hex);
}

// --- Shopify client ---
const shopify = shopifyApi({
  apiVersion: LATEST_API_VERSION,
  apiSecretKey: "dummy-secret",
  adminApiAccessToken: SHOPIFY_ADMIN_TOKEN,
  isCustomStoreApp: true,
  hostName: SHOPIFY_SHOP_DOMAIN,
});
const session = shopify.session.customAppSession(SHOPIFY_SHOP_DOMAIN);
const shopifyClient = new shopify.clients.Graphql({ session });

// --- LikeCard API helper ---
async function likeCardApiCall(endpoint, data) {
  const formData = new FormData();
  for (const key in data) {
    formData.append(key, data[key]);
  }

  const response = await axios.post(`${LIKE_CARD_BASE_URL}${endpoint}`, formData, {
    headers: { ...formData.getHeaders() },
    timeout: 15000,
  });

  return response.data;
}

// --- Update Shopify order note ---
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
            note,
          },
        },
      },
    });

    if (response.body.data.orderUpdate.userErrors.length > 0) {
      throw new Error(
        JSON.stringify(response.body.data.orderUpdate.userErrors)
      );
    }
    console.log(`✅ Successfully updated Shopify order ${orderId}.`);
  } catch (error) {
    console.error(`❌ Failed to update Shopify order ${orderId}:`, error);
    throw error;
  }
}

// --- Webhook endpoint ---
app.post("/webhook", async (req, res) => {
  res.status(200).send("Webhook received."); // reply fast

  try {
    const shopifyOrder = req.body;
    const orderId = shopifyOrder.id;
    console.log(`--- Processing Shopify Order ID: ${orderId} ---`);

    let orderNotes = shopifyOrder.note || "";

    for (const item of shopifyOrder.line_items) {
      const productId = item.sku;
      if (!productId) {
        console.warn(`⚠️ Product "${item.name}" has no SKU. Skipping.`);
        continue;
      }

      const referenceId = `SHOPIFY_${orderId}_${item.id}`;
      const time = Math.floor(Date.now() / 1000).toString();

      // Step 1: Create LikeCard order
      console.log(`Creating LikeCard order for product SKU: ${productId}`);
      const createOrderPayload = {
        deviceId: DEVICE_ID,
        email: MERCHANT_EMAIL,
        securityCode: SECURITY_CODE,
        langId: LANG_ID,
        productId: productId,
        referenceId,
        time,
        hash: generateHash(time),
        quantity: "1",
      };

      await likeCardApiCall("/create_order", createOrderPayload);
      console.log(`LikeCard order created: ${referenceId}`);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Step 2: Fetch order details
      console.log(`Fetching details for referenceId: ${referenceId}`);
      const detailsPayload = {
        deviceId: DEVICE_ID,
        email: MERCHANT_EMAIL,
        langId: LANG_ID,
        securityCode: SECURITY_CODE,
        referenceId,
      };

      const orderDetails = await likeCardApiCall(
        "/orders/details",
        detailsPayload
      );

      const serialCode =
        orderDetails.serials && orderDetails.serials[0]
          ? orderDetails.serials[0].serialCode
          : null;

      if (serialCode) {
        console.log(`✅ Code received for ${item.name}`);
        orderNotes += `
--------------------------------
المنتج: ${item.name}
الكود: ${serialCode}
--------------------------------
`;
      } else {
        console.error("❌ No code found:", orderDetails);
        orderNotes += `\n!! فشل استلام كود المنتج: ${item.name} !!`;
      }
    }

    if (orderNotes !== shopifyOrder.note) {
      await updateShopifyOrderNote(orderId, orderNotes);
    }

    console.log(`--- Finished processing Shopify Order ID: ${orderId} ---`);
  } catch (error) {
    console.error("❌ Error in webhook:", error.message);
  }
});

// --- Run server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
