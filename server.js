// --- داخل الـ webhook --- 
app.post('/webhook', async (req, res) => {
    res.status(200).send('Webhook received.'); // إرسال استجابة سريعة أولاً

    try {
        const shopifyOrder = req.body;
        const orderId = shopifyOrder.id;
        console.log(`--- Processing Shopify Order ID: ${orderId} ---`);

        const customerEmail = shopifyOrder.customer.email;
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
                deviceId: DEVICE_ID, email: customerEmail, securityCode: SECURITY_CODE,
                langId: LANG_ID, productId: productId, referenceId: referenceId,
                time: currentTime, hash: generateHash(currentTime), quantity: '1'
            };

            await likeCardApiCall('/create_order', createOrderPayload);
            console.log(`LikeCard order created with referenceId: ${referenceId}`);

            // --- الخطوة 2: المحاولات المتكررة للحصول على الكود ---
            let serialCode = null;
            let serialNumber = null;
            let orderDetails = null;

            for (let attempt = 0; attempt < 6; attempt++) {
                console.log(`Fetching details (try ${attempt + 1}/6) for referenceId: ${referenceId}`);
                const detailsPayload = {
                    deviceId: DEVICE_ID, email: MERCHANT_EMAIL, langId: LANG_ID,
                    securityCode: SECURITY_CODE, referenceId: referenceId,
                };

                orderDetails = await likeCardApiCall('/orders/details', detailsPayload);

                if (orderDetails.serials && orderDetails.serials[0]) {
                    serialCode = orderDetails.serials[0].serialCode;
                    serialNumber = orderDetails.serials[0].serialNumber;
                }

                if (serialCode || serialNumber) {
                    break; // تم الحصول على الكود، لا داعي لإعادة المحاولة
                }

                if (attempt < 5) {
                    console.log("Code not ready yet, waiting 10 seconds before retry...");
                    await new Promise(resolve => setTimeout(resolve, 10000)); // 10 ثواني
                }
            }

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
                console.error("Could not find serial code in LikeCard response after 6 tries:", orderDetails);
                orderNotes += `\n!! فشل استلام كود المنتج: ${item.name} !!`;
            }
        }

        // الخطوة 3: تحديث الملاحظات في Shopify
        if (orderNotes !== shopifyOrder.note) {
            await updateShopifyOrderNote(orderId, orderNotes);
        }

        console.log(`--- Finished processing Shopify Order ID: ${orderId} ---`);
    } catch (error) {
        console.error('An error occurred during webhook processing:', error.message);
    }
});
