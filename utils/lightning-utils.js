const axios = require("axios");
const bolt11 = require("bolt11");
const crypto = require('crypto'); 
// DEPRECATED: SQLite invoice tracking is disabled due to security vulnerabilities
// The imported functions are now no-op stubs - see invoice-db.js for MongoDB migration path
const { isPaymentHashValid, recordPayment, storeInvoice } = require('./invoice-db');
const { DEBUG_MODE } = require("../constants");


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
    // First verify this payment hash exists in our database
    const isValid = await isPaymentHashValid(paymentHash);
    if (!isValid) {
      console.log('Payment hash not found in database or expired');
      return false;
    }

    // Clean preimage and validate
    const cleanPreimage = preimage.startsWith(':') ? preimage.substring(1) : preimage;
    const isValidPreimage = validatePreimage(cleanPreimage, paymentHash);
    
    if (isValidPreimage) {
      // Record the successful payment
      await recordPayment(paymentHash, cleanPreimage);
    }

    return isValidPreimage;
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

async function generateInvoiceAlbyAPI(service='PTUJ Quick Search') {
  console.log("generateInvoiceAlbyAPI started..");
  const msats = process.env.SERVICE_PRICE_MILLISATS;
  console.log("getServicePrice msats:", msats);

  try {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const description = `Invoice for ${service} at ${timestamp}`;
    
    // Convert msats to sats for Alby API
    const amount = Math.floor(msats / 1000);

    const response = await axios.post('https://api.getalby.com/invoices', {
      description: description,
      amount: amount
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.ALBY_WALLET_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const invoiceData = response.data;
    
    if (!invoiceData.payment_request) {
      console.error("Failed invoice response:", invoiceData);
      throw new Error(`No payment request in invoice response: ${JSON.stringify(invoiceData)}`);
    }

    // Format the response to match the original function's return value
    // Get expiry from bolt11 invoice
    const decodedInvoice = bolt11.decode(invoiceData.payment_request);
    const expirySeconds = decodedInvoice.tags.find(tag => tag.tagName === 'expire_time')?.data || 3600;
    const expiryTimestamp = (decodedInvoice.timestamp + expirySeconds);
    
    // Store the invoice in the database
    await storeInvoice(invoiceData.payment_hash, invoiceData.payment_request, expiryTimestamp);

    return {
      pr: invoiceData.payment_request,
      paymentHash: invoiceData.payment_hash,
      // Including additional fields that match the Alby response
      // but weren't in the original response
      routes: [],
      status: "OK"
    };

  } catch (error) {
    if (error.response) {
      console.error("Error response from server:", {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    } else if (error.request) {
      console.error("No response received:", error.request);
    } else {
      console.error("Error setting up request:", error.message);
    }
    console.error("Error config:", error.config);
    throw error;
  }
}
  
async function generateInvoice(service='PTUJ Quick Search') {
  console.log("generateInvoice started..");
  const msats = process.env.SERVICE_PRICE_MILLISATS;
  console.log("getServicePrice msats:", msats);

  try {
    const lnurlResponse = await axios.get(getLNURL(), {
      headers: {
        Accept: "application/json",
      },
    });

    const lnAddress = lnurlResponse.data;
    console.log("LNURL response:", JSON.stringify(lnAddress, null, 2));

    if (!lnAddress || !lnAddress.callback) {
      throw new Error(`Invalid LNURL response: ${JSON.stringify(lnAddress)}`);
    }

    if (msats > lnAddress.maxSendable || msats < lnAddress.minSendable) {
      throw new Error(
        `${msats} msats not in sendable range of ${lnAddress.minSendable} - ${lnAddress.maxSendable}`
      );
    }

    const expiryMs = DEBUG_MODE ? (1000 * 60) : (3600 * 1000 * 24);//shorter time to allow for testing corner cases in debug
    const expiration = new Date(Date.now() + (expiryMs));

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const description = encodeURIComponent(`Invoice for ${service} at ${timestamp}`);
    
    const url = `${lnAddress.callback}?amount=${msats}&comment=${description}&expiry=${Math.floor(
      expiration.getTime() / 1000
    )}`;

    console.log("Requesting invoice from:", url);
    const invoiceResponse = await axios.get(url);
    console.log("Invoice response:", JSON.stringify(invoiceResponse.data, null, 2));

    const invoiceData = invoiceResponse.data;
    if (!invoiceData.pr) {
      console.error("Failed invoice response:", invoiceData);
      throw new Error(`No payment request in invoice response: ${JSON.stringify(invoiceData)}`);
    }

    const paymentHash = await getPaymentHash(invoiceData.pr);
    
    // Get expiry from bolt11 invoice
    const decodedInvoice = bolt11.decode(invoiceData.pr);
    const expirySeconds = decodedInvoice.tags.find(tag => tag.tagName === 'expire_time')?.data || 3600;
    const expiryTimestamp = (decodedInvoice.timestamp + expirySeconds);
    
    // Store the invoice in the database
    await storeInvoice(paymentHash, invoiceData.pr, expiryTimestamp);

    return { ...invoiceData, paymentHash };

  } catch (error) {
    if (error.response) {
      console.error("Error response from server:", {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    } else if (error.request) {
      console.error("No response received:", error.request);
    } else {
      console.error("Error setting up request:", error.message);
    }
    console.error("Error config:", error.config);
    throw error;
  }
}

module.exports = {
    getLNURL,
    getIsInvoicePaid,
    generateInvoice,
    generateInvoiceAlbyAPI
}