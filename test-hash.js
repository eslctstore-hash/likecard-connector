require("dotenv").config();
const crypto = require("crypto");

const time = Math.floor(Date.now() / 1000); // التوقيت بالثواني
const email = process.env.MERCHANT_EMAIL.toLowerCase();
const phone = process.env.MERCHANT_PHONE; // جرّب أكثر من صيغة
const key = process.env.HASH_KEY;

const hash = crypto.createHash("sha256")
  .update(time + email + phone + key)
  .digest("hex");

console.log("⏰ Time:", time);
console.log("📧 Email:", email);
console.log("📱 Phone:", phone);
console.log("🔑 Key:", key);
console.log("🧮 Hash:", hash);
