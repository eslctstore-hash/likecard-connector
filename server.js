// server.js
import express from "express";
import crypto from "crypto";
import axios from "axios";
import FormData from "form-data";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";
import "@shopify/shopify-api/adapters/node.js";

// --- 1. إعدادات متغيرات البيئة (Env Vars) ---
const {
  MERCHANT_EMAIL,
  MERCHANT_PHONE,
  HASH_KEY,
  SECURITY_CODE,
  DEVICE_ID,
  LANG_ID,
  SHOPIFY_SHOP_DOMAIN,
  SHOPIFY_ADMIN_TOKEN
} = process.env;

const LIKE_CARD_BASE_URL = "https://taxes.like4app.com/online";

// --- 2. إعداد Shopify API Client ---
const shopify = shopifyApi({
  apiVersion: LATEST_API_VERSION,
  apiSecretKey: "dummy-secret", // Admin API token يغنيك عن هذا
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
  return crypto.createHash("sha256").update(data).digest("hex");
}

// دالة موحدة لاستدعاءات LikeCard API
async function likeCardApiCall(endpoint, data) {
  const formData = new FormData();
  for (const key in data) {
    formData.append(key, data[key]);
  }
  const response = await axios.post(`${LIKE_CARD_BASE_URL}${endpoint}`, formData, {
    headers: { ...formData.getHeaders() },
    timeout: 15000, // 15 ثانية
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
            note: note,
          },
        },
      },
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

// --- 4. السيرفر + Webhook ---
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("✅ LikeCard connector is running. Use POST /webhook for Shopify.");
});

app.post("/webhook", async (req, res) => {
  res.status(200).send("Webhook received."); // رد سريع

  try {
    const shopifyOrder = req.body;
    const orderId = shopifyOrder.id;
    console.log(`--- Processing Shopify Order ID: ${orderId} ---`);

    const customerEmail = shopifyOrder.customer?.email || MERCHANT_EMAIL;
    let orderNotes = shopifyOrder.note || "";

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
        deviceId: DEVICE_ID,
        email: customerEmail,
        securityCode: SECURITY_CODE,
        langId: LANG_ID,
        productId: productId,
        referenceId: referenceId,
        time: currentTime,
        hash: generateHash(currentTime),
        quantity: "1",
      };

      await likeCardApiCall("/create_order", createOrderPayload);
      console.log(`LikeCard order created with referenceId: ${referenceId}`);

      // تأخير بسيط لإتاحة وقت للمعالجة في LikeCard
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // الخطوة 2: جلب تفاصيل الطلب للحصول على الأكواد
      console.log(`Fetching details for referenceId: ${referenceId}`);
      const detailsPayload = {
        deviceId: DEVICE_ID,
        email: MERCHANT_EMAIL, // هنا لازم بريد التاجر
        langId: LANG_ID,
        securityCode: SECURITY_CODE,
        referenceId: referenceId,
      };

      const orderDetails = await likeCardApiCall("/orders/details", detailsPayload);

      const serialCode =
        orderDetails.serials && orderDetails.serials[0]
          ? orderDetails.serials[0].serialCode
          : null;
      const serialNumber =
        orderDetails.serials && orderDetails.serials[0]
          ? orderDetails.serials[0].serialNumber
          : null;

      if (serialCode || serialNumber) {
        console.log(`Code received for product ${item.name}: SUCCESS`);
        const newNote = `
--------------------------------
المنتج: ${item.name}
الكود: ${serialCode || "N/A"}
الرقم التسلسلي: ${serialNumber || "N/A"}
--------------------------------
`;
        orderNotes += newNote;
      } else {
        console.error("Could not find serial code in LikeCard response:", orderDetails);
        orderNotes += `\n!! فشل استلام كود المنتج: ${item.name} !!`;
      }
    }

    // الخطوة 3: تحديث ملاحظات الطلب في Shopify
    if (orderNotes !== shopifyOrder.note) {
      await updateShopifyOrderNote(orderId, orderNotes);
    }

    console.log(`--- Finished processing Shopify Order ID: ${orderId} ---`);
  } catch (error) {
    console.error("An error occurred during webhook processing:", error.message);
  }
});

// --- 5. تشغيل السيرفر ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
