// server.js
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const FormData = require("form-data");
const crypto = require("crypto");

const app = express();
app.use(bodyParser.json());

async function createLikeCardOrder(productId, referenceId, quantity = 1) {
  try {
    const time = Math.floor(Date.now() / 1000);

    // القيم من البيئة
    const email = process.env.MERCHANT_EMAIL.toLowerCase();
    const phone = process.env.MERCHANT_PHONE;
    const key = process.env.HASH_KEY;

    // ✅ hash الصحيح
    const raw = time + email + phone + key;
    const hash = crypto.createHash("sha256").update(raw).digest("hex");

    const formData = new FormData();
    formData.append("deviceId", process.env.DEVICE_ID);
    formData.append("email", email);
    formData.append("securityCode", process.env.SECURITY_CODE);
    formData.append("langId", process.env.LANG_ID || "1");
    formData.append("productId", productId);
    formData.append("referenceId", referenceId);
    formData.append("time", time.toString());
    formData.append("hash", hash);
    formData.append("quantity", quantity.toString());
    formData.append("optionalFields", "");

    console.log("🔑 Payload to LikeCard:", {
      deviceId: process.env.DEVICE_ID,
      email,
      phone,
      securityCode: process.env.SECURITY_CODE,
      langId: process.env.LANG_ID || "1",
      productId,
      referenceId,
      time,
      hash,
      quantity
    });

    const res = await fetch("https://taxes.like4app.com/online/create_order", {
      method: "POST",
      body: formData
    });

    const json = await res.json();
    console.log("📦 LikeCard create response:", json);
    return json;
  } catch (err) {
    console.error("❌ Error creating LikeCard order:", err.message);
    return { response: 0, message: "Exception: " + err.message };
  }
}

app.post("/webhook", async (req, res) => {
  const order = req.body;
  console.log("📩 Incoming webhook:", order.id);

  try {
    const lineItem = order.line_items[0];
    const productId = lineItem.sku;
    const referenceId = order.id.toString();
    const quantity = lineItem.quantity || 1;

    console.log("🛒 Creating LikeCard order for SKU:", productId);

    const likeCardResponse = await createLikeCardOrder(
      productId,
      referenceId,
      quantity
    );

    if (likeCardResponse.response === 1) {
      console.log("✅ LikeCard order created successfully");
    } else {
      console.error("❌ LikeCard order failed:", likeCardResponse);
    }

    res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
    res.status(500).send("Error processing webhook");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bridge running on port ${PORT}`);
});
