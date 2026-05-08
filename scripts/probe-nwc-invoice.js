require('dotenv').config();
const { generateInvoiceForSats } = require('../utils/lightning-utils');

(async () => {
  const start = Date.now();
  try {
    console.log('NWC_CONNECTION_URI present:', !!process.env.NWC_CONNECTION_URI);
    const inv = await generateInvoiceForSats(10);
    console.log('SUCCESS in', Date.now() - start, 'ms');
    console.log('paymentHash:', inv.paymentHash);
    console.log('expiresAt:', inv.expiresAt.toISOString());
    console.log('pr length:', inv.pr.length);
    console.log('pr prefix:', inv.pr.substring(0, 40) + '...');
  } catch (e) {
    console.log('FAILED in', Date.now() - start, 'ms');
    console.log('error:', e.message);
    console.log('stack:', e.stack);
  } finally {
    process.exit(0);
  }
})();
