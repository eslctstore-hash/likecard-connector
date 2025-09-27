// server.js
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const CryptoJS = require("crypto-js");
const { shopifyApi, LATEST_API_VERSION } = require("@shopify/shopify-api");
require("@shopify/shopify-api/adapters/node");

// --- 1. Environment Variables (from Render) ---
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
const gqlClient = new shopify.clients.Graphql({ session });

// --- 3. Helper Functions ---
function generateHash(time) {
  const raw = time + MERCHANT_EMAIL.toLowerCase() + MERCHANT_PHONE + HASH_KEY;
  return CryptoJS.SHA256(raw).toString(CryptoJS.enc.Hex);
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

// تحديث الملاحظات (اختياري)
async function updateShopifyOrderNote(orderId, note) {
  await gqlClient.query({
    data: {
      query: `mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id note }
          userErrors { field message }
        }
      }`,
      variables: {
        input: { id: `gid://shopify/Order/${orderId}`, note: note },
      },
    },
  });
}

// ✅ دالة لتخزين السيريال في الـ Metafield الخاص بـ Line Item
async function attachSerialToLineItem(lineItemId, serialCode) {
  try {
    const response = await gqlClient.query({
      data: {
        query: `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              namespace
              key
              value
              type
            }
            userErrors {
              field
              message
            }
          }
        }`,
        variables: {
          metafields: [
            {
              ownerId: `gid://shopify/LineItem/${lineItemId}`,
              namespace: "custom",
              key: "serials",
              value: serialCode,
              type: "single_line_text_field",
            },
          ],
        },
      },
    });

    if (response.body.data.metafieldsSet.userErrors.length > 0) {
      console.error("❌ Metafield error:", response.body.data.metafieldsSet.userErrors);
    } else {
      console.log(`✅ Serial stored in LineItem ${lineItemId}: ${serialCode}`);
    }
  } catch (err) {
    console.error("❌ Error saving metafield:", err.message);
  }
}

// --- 4. Webhook ---
const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  res.status(200).send("Webhook received.");

  try {
    const shopifyOrder = req.body;
    const orderId = shopifyOrder.id;
    console.log(`--- Processing Shopify Order: ${orderId} ---`);

    let orderNotes = shopifyOrder.note || "";

    for (const item of shopifyOrder.line_items) {
      const productId = item.sku;
      if (!productId) continue;

      const referenceId = `SHOPIFY_${orderId}_${item.id}`;
      const time = Math.floor(Date.now() / 1000).toString();

      const payload = {
        deviceId: DEVICE_ID,
        email: MERCHANT_EMAIL,
        phone: MERCHANT_PHONE,
        securityCode: SECURITY_CODE,
        langId: LANG_ID,
        productId,
        referenceId,
        time,
        hash: generateHash(time),
        quantity: "1",
      };

      // إنشاء طلب LikeCard
      const createRes = await likeCardApiCall("/create_order", payload);
      const likeCardOrderId = createRes.orderId;
      if (!likeCardOrderId) continue;

      // جلب تفاصيل الطلب
      const detailsPayload = {
        deviceId: DEVICE_ID,
        email: MERCHANT_EMAIL,
        langId: LANG_ID,
        securityCode: SECURITY_CODE,
        orderId: likeCardOrderId,
      };
      const detailsRes = await likeCardApiCall("/orders/details", detailsPayload);

      const serialCode =
        detailsRes.serials && detailsRes.serials[0] ? detailsRes.serials[0].serialCode : null;

      if (serialCode) {
        orderNotes += `\nمنتج: ${item.name}\nالكود: ${serialCode}\n`;

        // ✅ نخزن السيريال في Metafield لعنصر الطلب
        await attachSerialToLineItem(item.id, serialCode);
      } else {
        orderNotes += `\n!! فشل استلام كود المنتج: ${item.name} !!`;
      }
    }

    // تحديث الملاحظات أيضًا (اختياري)
    if (orderNotes !== shopifyOrder.note) {
      await updateShopifyOrderNote(orderId, orderNotes);
    }

    console.log(`--- Finished Order: ${orderId} ---`);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
});

// --- 5. Run Server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
