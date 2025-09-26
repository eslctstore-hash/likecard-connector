// server.js
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");
const { shopifyApi, LATEST_API_VERSION } = require("@shopify/shopify-api");
require("@shopify/shopify-api/adapters/node");

// --- 1. متغيرات البيئة ---
const {
  MERCHANT_EMAIL,
  MERCHANT_PHONE,
  HASH_KEY,
  SECURITY_CODE,
  DEVICE_ID,
  LANG_ID,
  SHOPIFY_SHOP_DOMAIN,
  SHOPIFY_ADMIN_TOKEN,
} = process.env;

const LIKE_CARD_BASE_URL = "https://taxes.like4app.com/online";

// --- 2. Shopify API Client ---
const shopify = shopifyApi({
  apiVersion: LATEST_API_VERSION,
  apiSecretKey: "dummy-secret",
  adminApiAccessToken: SHOPIFY_ADMIN_TOKEN,
  isCustomStoreApp: true,
  hostName: SHOPIFY_SHOP_DOMAIN,
});
const session = shopify.session.customAppSession(SHOPIFY_SHOP_DOMAIN);
const shopifyClient = new shopify.clients.Graphql({ session });

// --- 3. دوال مساعدة ---
function generateHash(time) {
  const data = `${time}${MERCHANT_EMAIL.toLowerCase()}${MERCHANT_PHONE}${HASH_KEY}`;
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function likeCardApiCall(endpoint, data) {
  const formData = new FormData();
  for (const key in data) formData.append(key, data[key]);
  const response = await axios.post(`${LIKE_CARD_BASE_URL}${endpoint}`, formData, {
    headers: { ...formData.getHeaders() },
    timeout: 15000,
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
          input: { id: `gid://shopify/Order/${orderId}`, note },
        },
      },
    });
    if (response.body.data.orderUpdate.userErrors.length > 0) {
      throw new Error(JSON.stringify(response.body.data.orderUpdate.userErrors));
    }
    console.log(`Successfully updated Shopify order ${orderId}.`);
  } catch (err) {
    console.error(`Failed to update order:`, err);
  }
}

// --- 4. Webhook ---
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("✅ LikeCard connector is running. Use POST /webhook for Shopify.");
});

app.post("/webhook", async (req, res) => {
  res.status(200).send("Webhook received.");
  try {
    const shopifyOrder = req.body;
    const orderId = shopifyOrder.id;
    let orderNotes = shopifyOrder.note || "";
    const customerEmail = shopifyOrder.customer?.email || MERCHANT_EMAIL;

    for (const item of shopifyOrder.line_items) {
      const productId = item.sku;
      if (!productId) continue;

      const referenceId = `SHOPIFY_${orderId}_${item.id}`;
      const currentTime = Math.floor(Date.now() / 1000).toString();

      const createOrderPayload = {
        deviceId: DEVICE_ID,
        email: customerEmail,
        securityCode: SECURITY_CODE,
        langId: LANG_ID,
        productId,
        referenceId,
        time: currentTime,
        hash: generateHash(currentTime),
        quantity: "1",
      };

      await likeCardApiCall("/create_order", createOrderPayload);
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const detailsPayload = {
        deviceId: DEVICE_ID,
        email: MERCHANT_EMAIL,
        langId: LANG_ID,
        securityCode: SECURITY_CODE,
        referenceId,
      };

      const orderDetails = await likeCardApiCall("/orders/details", detailsPayload);

      const serialCode = orderDetails.serials?.[0]?.serialCode;
      const serialNumber = orderDetails.serials?.[0]?.serialNumber;

      if (serialCode || serialNumber) {
        orderNotes += `
-----------------------------
${item.name}
الكود: ${serialCode || "N/A"}
الرقم التسلسلي: ${serialNumber || "N/A"}
-----------------------------`;
      } else {
        orderNotes += `\n!! فشل استلام كود المنتج: ${item.name} !!`;
      }
    }

    if (orderNotes !== shopifyOrder.note) {
      await updateShopifyOrderNote(orderId, orderNotes);
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// --- 5. Run Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
