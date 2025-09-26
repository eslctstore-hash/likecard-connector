// Replace your entire app.post function with this one
app.post('/webhook', async (req, res) => {
    res.status(200).send('Webhook received.'); // Respond immediately

    try {
        const shopifyOrder = req.body;
        const orderId = shopifyOrder.id;
        console.log(`--- Processing Shopify Order ID: ${orderId} ---`);

        let orderNotes = shopifyOrder.note || "";

        for (const item of shopifyOrder.line_items) {
            const productId = item.sku;
            if (!productId) {
                console.warn(`Product "${item.name}" has no SKU. Skipping.`);
                continue;
            }

            const referenceId = `SHOPIFY_${orderId}_${item.id}`;
            const currentTime = Math.floor(Date.now() / 1000).toString();
            
            // Step 1: Create the order and CAPTURE the response
            console.log(`Creating LikeCard order for product SKU: ${productId}`);
            const createOrderPayload = {
                deviceId: DEVICE_ID, email: shopifyOrder.customer.email, securityCode: SECURITY_CODE,
                langId: LANG_ID, productId: productId, referenceId: referenceId,
                time: currentTime, hash: generateHash(currentTime), quantity: '1'
            };

            const createOrderResponse = await likeCardApiCall('/create_order', createOrderPayload);
            console.log(`LikeCard order creation responded with:`, createOrderResponse);

            // Step 2: Extract the LikeCard Order ID from the response
            // IMPORTANT: We are guessing the field is named 'orderId'. It might be 'id', 'order_id', etc.
            // The log above will tell us the correct name if this fails.
            const likeCardOrderId = createOrderResponse.orderId;

            if (!likeCardOrderId) {
                console.error("Could not find 'orderId' in the create order response.");
                orderNotes += `\n!! فشل في استلام معرف الطلب من LikeCard للمنتج: ${item.name} !!`;
                continue; // Move to the next item in the order
            }

            console.log(`Fetching details for LikeCard Order ID: ${likeCardOrderId}`);
            
            // Step 3: Fetch details using the NEW LikeCard Order ID
            const detailsPayload = {
                deviceId: DEVICE_ID,
                email: MERCHANT_EMAIL, 
                langId: LANG_ID,
                securityCode: SECURITY_CODE,
                orderId: likeCardOrderId, // Use the ID from LikeCard
            };
            
            const orderDetails = await likeCardApiCall('/orders/details', detailsPayload);

            const serialCode = orderDetails.serials && orderDetails.serials[0] ? orderDetails.serials[0].serialCode : null;
            const serialNumber = orderDetails.serials && orderDetails.serials[0] ? orderDetails.serials[0].serialNumber : null;

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
                console.error("Could not find serial code in LikeCard response:", orderDetails);
                orderNotes += `\n!! فشل استلام كود المنتج: ${item.name} !!`;
            }
        }

        // Step 4: Update Shopify order with all notes
        if (orderNotes !== shopifyOrder.note) {
            await updateShopifyOrderNote(orderId, orderNotes);
        }

        console.log(`--- Finished processing Shopify Order ID: ${orderId} ---`);

    } catch (error) {
        console.error('An error occurred during webhook processing:', error.message);
    }
});
