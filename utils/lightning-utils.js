const axios = require("axios");
const bolt11 = require("bolt11");
const crypto = require('crypto'); 

function getLNURL() {
    const parts = process.env.LN_ADDRESS.split("@");
    if (parts.length !== 2) {
      throw new Error(`Invalid lnAddress: ${process.env.LN_ADDRESS}`);
    }
    const username = parts[0];
    const domain = parts[1];
    return `https://${domain}/.well-known/lnurlp/${username}`;
}

async function getIsInvoicePaid(preimage, paymentHash) {
  if (!preimage || !paymentHash) {
      console.log('Missing preimage or paymentHash');
      return false;
  }

  try {
      // Ensure preimage doesn't start with ':'
      const cleanPreimage = preimage.startsWith(':') ? preimage.substring(1) : preimage;
      
      // Validate the preimage against the payment hash
      const isValid = validatePreimage(cleanPreimage, paymentHash);
      console.log('Payment validation result:', {
          preimage: cleanPreimage,
          paymentHash,
          isValid
      });

      return isValid;
  } catch (error) {
      console.error('Error validating payment:', error);
      return false;
  }
}

function validatePreimage(preimageHex, paymentHashHex) {
  try {
      // Convert the preimage hex string to a Buffer
      const preimageBuffer = Buffer.from(preimageHex, 'hex');

      // Hash the preimage using SHA256
      const hash = crypto.createHash('sha256');
      hash.update(preimageBuffer);
      const computedHashHex = hash.digest('hex');

      // Add debug logging
      console.log('Validation details:', {
          preimageHex,
          paymentHashHex,
          computedHashHex,
      });

      return computedHashHex === paymentHashHex;
  } catch (error) {
      console.error('Error in validatePreimage:', error);
      return false;
  }
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
  
    const expiration = new Date(Date.now() + (3600 * 1000 * 24)); // 24 hours from now
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