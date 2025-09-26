app.post('/webhook', async (req, res) => {
  try {
    const order = req.body;

    // سجل الـ topic لو موجود
    console.log("📩 Shopify Topic:", req.headers['x-shopify-topic'] || '(manual/Postman test)');

    // سجل الاسم و الـ id حتى لو ما موجودين
    console.log("🧾 Order name/id:", order?.name || '(no name)', order?.id || '(no id)');

    // استخراج المنتجات من الطلب
    const items = (order.line_items || []).map(i => ({
      title: i.title,
      sku: i.sku,
      id: i.product_id || i.id
    }));
    console.log("🧺 Line items:", items);

    // تجهيز بيانات LikeCard
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const hash = crypto
      .createHash('sha256')
      .update(
        timestamp +
        process.env.LIKECARD_EMAIL.toLowerCase() +
        process.env.LIKECARD_PHONE +
        process.env.LIKECARD_HASH_KEY
      )
      .digest('hex');

    // form-data
    const form = new FormData();
    form.append('deviceId', process.env.LIKECARD_DEVICE_ID);
    form.append('email', process.env.LIKECARD_EMAIL);
    form.append('securityCode', process.env.LIKECARD_SECURITY_CODE);
    form.append('langId', '1');
    form.append('productId', items[0]?.id || '');
    form.append('referenceId', `order_${order?.id || Date.now()}`);
    form.append('time', timestamp);
    form.append('hash', hash);
    form.append('quantity', '1');

    const response = await axios.post(
      'https://taxes.like4app.com/online/create_order',
      form,
      { headers: form.getHeaders() }
    );

    console.log("📦 LikeCard Response:", response.data);
    res.status(200).json({ success: true, likecard: response.data });

  } catch (err) {
    console.error("❌ LikeCard Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
