const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// بيانات Ultramsg الخاصة بك
const INSTANCE_ID = "instance130361";
const TOKEN = "1jye4kcup4uhkmkz";
const API_URL = `https://api.ultramsg.com/${INSTANCE_ID}/messages/chat`;

// دالة عامة لإرسال رسالة واتساب
async function sendWhatsAppMessage(phone, message) {
  try {
    const response = await axios.post(API_URL, {
      to: phone,
      body: message
    }, {
      headers: { "Content-Type": "application/json" },
      params: { token: TOKEN }
    });

    console.log("✅ تم إرسال رسالة:", response.data);
  } catch (err) {
    console.error("❌ خطأ أثناء الإرسال:", err.response?.data || err.message);
  }
}

// 🔹 Webhook جديد من Shopify للواتساب
app.post("/whatsapp-webhook", async (req, res) => {
  const order = req.body;

  const phone = order?.shipping_address?.phone || order?.billing_address?.phone;
  if (!phone) {
    console.log("⚠️ لا يوجد رقم هاتف في الطلب");
    return res.status(200).send("No phone number");
  }

  // تحديد نوع الحالة
  const status = order.financial_status || "pending";  // unpaid, paid, refunded
  const fulfillment = order.fulfillment_status || "unfulfilled"; // shipped, fulfilled, etc.
  const isDigital = order.line_items.some(line => line.product_type === "Digital" || line.title.includes("LikeCard"));

  let message = `📦 تحديث طلبك #${order.name}\n`;

  if (status === "pending") {
    message += `✅ تم إنشاء طلبك بنجاح.\nالإجمالي: ${order.total_price} ${order.currency}`;
  }
  else if (status === "paid") {
    message += `💳 تم استلام الدفع بنجاح.\nالمبلغ: ${order.total_price} ${order.currency}`;
  }
  if (fulfillment === "shipped") {
    message += `\n🚚 تم شحن طلبك.`;
  }
  if (fulfillment === "fulfilled") {
    message += `\n🎉 تم اكتمال طلبك.`;
  }

  // إذا منتج رقمي (LikeCard) → أضف الملاحظة أو السيريال
  if (isDigital) {
    const note = order.note || "سيتم إرسال الرموز الخاصة بك لاحقاً.";
    message += `\n🔑 ${note}`;
  }

  // إرسال الرسالة
  await sendWhatsAppMessage(phone, message);

  res.status(200).send("OK");
});

// تشغيل السيرفر
app.listen(4000, () => {
  console.log("🚀 WhatsApp Service running on port 4000");
});
