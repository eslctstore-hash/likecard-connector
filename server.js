// --- 4. Main Webhook Endpoint ---
const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
    res.status(200).send("Webhook received.");

    try {
        const shopifyOrder = req.body;
        const orderId = shopifyOrder.id;
        console.log(`--- Processing Shopify Order ID: ${orderId} ---`);

        let orderNotes = shopifyOrder.note || "";
        let codesForDisplay = ""; // This will be a simple string now

        for (const item of shopifyOrder.line_items) {
            const productId = item.sku;
            if (!productId) { continue; }

            const referenceId = `SHOPIFY_${orderId}_${item.id}`;
            const time = Math.floor(Date.now() / 1000).toString();

            console.log(`Creating LikeCard order for product SKU: ${productId}`);
            const createOrderPayload = { deviceId: DEVICE_ID, email: MERCHANT_EMAIL, phone: MERCHANT_PHONE, securityCode: SECURITY_CODE, langId: LANG_ID, productId, referenceId, time, hash: generateHash(time), quantity: "1" };
            const createOrderResponse = await likeCardApiCall("/create_order", createOrderResponse);

            console.log(`LikeCard order creation responded with:`, createOrderResponse);
            
            const serialCode = createOrderResponse.serials && createOrderResponse.serials[0] ? createOrderResponse.serials[0].serialCode : null;

            if (serialCode) {
                console.log(`✅ Code received for ${item.name}`);
                const productTitle = item.name;
                
                // Add to the admin note
                orderNotes += `\n--------------------------------\nالمنتج: ${productTitle}\nالكود: ${serialCode}\n--------------------------------\n`;
                
                // Add to the customer-facing string
                codesForDisplay += `المنتج: ${productTitle}\nالكود: ${serialCode}\n\n`;
            } else {
                console.error("❌ No code found in create order response:", createOrderResponse);
                orderNotes += `\n!! فشل استلام كود المنتج: ${item.name} !!`;
            }
        }
        
        // Only update if we have codes to show
        if (codesForDisplay) {
            const metafields = [{
                namespace: "digital_product",
                key: "codes",
                type: "multi_line_text_field", // Using a simple text type
                value: codesForDisplay // Saving the pre-formatted string
            }];
            await updateShopifyOrder(orderId, orderNotes, metafields);
        }

        console.log(`--- Finished processing Shopify Order ID: ${orderId} ---`);
    } catch (error) {
        console.error("❌ Error in webhook:", error.message);
    }
});
