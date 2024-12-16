const axios = require("axios");
const bolt11 = require("bolt11");

function getLNURL() {
    const parts = process.env.LN_ADDRESS.split("@");
    if (parts.length !== 2) {
      throw new Error(`Invalid lnAddress: ${process.env.LN_ADDRESS}`);
    }
    const username = parts[0];
    const domain = parts[1];
    return `https://${domain}/.well-known/lnurlp/${username}`;
}

async function getIsInvoicePaid(paymentHash) {
    const isPaid = false
    const invoice = "";
    return { isPaid, invoice };//{ isPaid, invoice };
}

async function getPaymentHash(invoice) {
    const decodedInvoice = await bolt11.decode(invoice);
    const paymentHashTag = decodedInvoice.tags.find(
      (tag) => tag.tagName === "payment_hash"
    ).data;
    return paymentHashTag;
}
  
async function generateInvoice(service) {
    console.log("generateInvoice started..")
    const msats = process.env.SERVICE_PRICE_MILLISATS;
    console.log("getServicePrice msats:",msats)
    const lnurlResponse = await axios.get(getLNURL(), {
      headers: {
        Accept: "application/json",
      },
    });
  
    const lnAddress = lnurlResponse.data;
  
    if (msats > lnAddress.maxSendable || msats < lnAddress.minSendable) {
      throw new Error(
        `${msats} msats not in sendable range of ${lnAddress.minSendable} - ${lnAddress.maxSendable}`
      );
    }
  
    const expiration = new Date(Date.now() + 3600 * 1000); // One hour from now
    const url = `${lnAddress.callback}?amount=${msats}&expiry=${Math.floor(
      expiration.getTime() / 1000
    )}`;
  
    const invoiceResponse = await axios.get(url);
    const invoiceData = invoiceResponse.data;
  
    const paymentHash = await getPaymentHash(invoiceData.pr);  
    const invoice = { ...invoiceData, paymentHash };
  
  
    return invoice;
}

module.exports = {
    getLNURL,
    getIsInvoicePaid,
    generateInvoice,
}