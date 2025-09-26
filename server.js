// الخطوة 1: إنشاء الطلب في LikeCard
const createOrderPayload = {
    deviceId: DEVICE_ID,
    email: customerEmail,              // هنا بريد العميل عادي
    securityCode: SECURITY_CODE,
    langId: LANG_ID,
    productId: productId,
    referenceId: referenceId,
    time: currentTime,
    hash: generateHash(currentTime),
    quantity: '1'
};

await likeCardApiCall('/create_order', createOrderPayload);
console.log(`LikeCard order created with referenceId: ${referenceId}`);

// تأخير 3 ثواني
await new Promise(resolve => setTimeout(resolve, 3000));

// الخطوة 2: جلب تفاصيل الطلب
console.log(`Fetching details for referenceId: ${referenceId}`);
const detailsPayload = {
    deviceId: DEVICE_ID,
    email: MERCHANT_EMAIL,             // ⚠️ هنا لازم يكون بريد التاجر
    langId: LANG_ID,
    securityCode: SECURITY_CODE,
    referenceId: referenceId,
};

const orderDetails = await likeCardApiCall('/orders/details', detailsPayload);

// حاول تلتقط من أكثر من مكان
let serialCode = null;
let serialNumber = null;
if (orderDetails.serials?.[0]) {
    serialCode = orderDetails.serials[0].serialCode;
    serialNumber = orderDetails.serials[0].serialNumber;
} else if (orderDetails.data?.serials?.[0]) {
    serialCode = orderDetails.data.serials[0].serialCode;
    serialNumber = orderDetails.data.serials[0].serialNumber;
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
    console.error("Could not find serial code in LikeCard response:", orderDetails);
    orderNotes += `\n!! فشل استلام كود المنتج: ${item.name} !!`;
}
