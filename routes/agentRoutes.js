/**
 * Agent Routes - Lightning pay-per-use system for agent API access
 * 
 * Design spec: https://github.com/uncleJim21/pullthatupjamie-backend/issues/63
 * 
 * Pricing model:
 *   - Pre-pay any amount in sats (10 - 500,000) via Lightning invoice
 *   - Sats are converted to USD (microdollars) at the current BTC/USD rate
 *   - Each API call deducts its USD cost from the balance
 *   - Balance is tracked in microdollars (1 microdollar = $0.000001)
 * 
 * Flow:
 *   1. POST /purchase-credits  → returns Lightning invoice for requested sats
 *   2. POST /activate-credits  → validates preimage, creates entitlement with USD balance
 *   3. GET  /balance            → returns remaining USD balance
 * 
 * Auth: Authorization header with "preimage:paymentHash" (for balance endpoint)
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { AgentInvoice } = require('../models/AgentInvoice');
const { Entitlement } = require('../models/Entitlement');
const { generateInvoiceForSats, validatePreimage } = require('../utils/lightning-utils');
const { getBtcUsdRate, isLightningAvailable, satsToUsdMicro, microUsdToUsd } = require('../utils/btcPrice');
const { AGENT_MIN_DEPOSIT_SATS, AGENT_MAX_DEPOSIT_SATS } = require('../constants/agentPricing');

/**
 * Middleware: check that lightning services are available (price is fresh enough)
 * On first request, triggers a synchronous price fetch to warm the cache.
 */
async function requireLightningAvailable(req, res, next) {
  if (!isLightningAvailable()) {
    // Attempt to warm the cache on first access
    try {
      await getBtcUsdRate();
    } catch (err) {
      console.error('[AgentRoutes] Failed to fetch initial BTC/USD rate:', err.message);
    }

    // Re-check after attempted fetch
    if (!isLightningAvailable()) {
      return res.status(503).json({
        error: 'Lightning services temporarily unavailable',
        message: 'BTC/USD price data is too stale. Lightning endpoints are disabled until a fresh price is available.',
        code: 'LIGHTNING_UNAVAILABLE'
      });
    }
  }
  next();
}

router.use(requireLightningAvailable);

/**
 * POST /api/agent/purchase-credits
 * 
 * Request a Lightning invoice to pre-pay for API usage.
 */
router.post('/purchase-credits', async (req, res) => {
  // #swagger.tags = ['Agent Auth']
  // #swagger.summary = 'Purchase API credits via Lightning invoice'
  // #swagger.description = 'Request a Lightning invoice to pre-pay for API usage. Specify an amount in sats (10 - 500,000). The sats are converted to USD at the current BTC/USD median rate and become your API balance. Each subsequent API call deducts its USD cost from your balance.'
  /* #swagger.parameters['body'] = {
    in: 'body',
    required: true,
    schema: {
      amountSats: 5000,
      clientId: 'optional-for-session-linking'
    }
  } */
  /* #swagger.responses[200] = {
    description: 'Lightning invoice generated',
    schema: {
      invoice: 'lnbc50u1p...',
      paymentHash: 'abc123def456...',
      amountSats: 5000,
      amountUsd: 5.00,
      btcUsdRate: 100000,
      expiresAt: '2026-02-13T01:00:00.000Z'
    }
  } */
  /* #swagger.responses[400] = {
    description: 'Invalid amount',
    schema: { error: 'Invalid amount', message: 'amountSats must be an integer between 10 and 500000' }
  } */
  /* #swagger.responses[503] = {
    description: 'Lightning services temporarily unavailable (stale BTC price)',
    schema: { error: 'Lightning services temporarily unavailable', code: 'LIGHTNING_UNAVAILABLE' }
  } */
  try {
    const { amountSats, clientId } = req.body || {};

    if (!Number.isInteger(amountSats) || amountSats < AGENT_MIN_DEPOSIT_SATS || amountSats > AGENT_MAX_DEPOSIT_SATS) {
      return res.status(400).json({
        error: 'Invalid amount',
        message: `amountSats must be an integer between ${AGENT_MIN_DEPOSIT_SATS} and ${AGENT_MAX_DEPOSIT_SATS}`,
        min: AGENT_MIN_DEPOSIT_SATS,
        max: AGENT_MAX_DEPOSIT_SATS
      });
    }

    const { rate: btcUsdRate } = await getBtcUsdRate();
    const amountUsdMicro = satsToUsdMicro(amountSats);
    const amountUsd = microUsdToUsd(amountUsdMicro);

    const invoice = await generateInvoiceForSats(amountSats);

    await AgentInvoice.create({
      paymentHash: invoice.paymentHash,
      invoiceStr: invoice.pr,
      amountSats,
      amountUsdMicro,
      btcUsdRate,
      clientId: clientId || null,
      status: 'pending',
      expiresAt: invoice.expiresAt
    });

    res.json({
      invoice: invoice.pr,
      paymentHash: invoice.paymentHash,
      amountSats,
      amountUsd: parseFloat(amountUsd.toFixed(6)),
      btcUsdRate,
      expiresAt: invoice.expiresAt
    });
  } catch (error) {
    console.error('[AgentRoutes] Error generating invoice:', error);
    res.status(500).json({
      error: 'Failed to generate invoice',
      details: error.message
    });
  }
});

/**
 * POST /api/agent/activate-credits
 * 
 * Activate purchased credits by providing the Lightning preimage.
 */
router.post('/activate-credits', async (req, res) => {
  // #swagger.tags = ['Agent Auth']
  // #swagger.summary = 'Activate credits with Lightning preimage'
  // #swagger.description = 'After paying the Lightning invoice, submit the preimage and paymentHash to activate your USD balance. The preimage becomes your stateless auth credential for subsequent API calls (format: Authorization: preimage:paymentHash).'
  /* #swagger.parameters['body'] = {
    in: 'body',
    required: true,
    schema: {
      preimage: 'abc123...',
      paymentHash: 'def456...'
    }
  } */
  /* #swagger.responses[200] = {
    description: 'Credits activated successfully',
    schema: {
      paymentHash: 'def456...',
      balanceUsd: 5.00,
      balanceUsdMicro: 5000000,
      clientId: 'optional-session-id'
    }
  } */
  /* #swagger.responses[400] = {
    description: 'Invalid preimage, paymentHash, or invoice not found',
    schema: { error: 'Activation failed', message: 'Description of the issue' }
  } */
  try {
    const { preimage, paymentHash } = req.body || {};

    if (!preimage || !paymentHash) {
      return res.status(400).json({
        error: 'Missing fields',
        message: 'Both preimage and paymentHash are required'
      });
    }

    const hexPattern = /^[0-9a-fA-F]{64}$/;
    if (!hexPattern.test(preimage) || !hexPattern.test(paymentHash)) {
      return res.status(400).json({
        error: 'Invalid format',
        message: 'preimage and paymentHash must be 64-character hex strings'
      });
    }

    // Crypto verification: SHA256(preimage) must equal paymentHash
    if (!validatePreimage(preimage, paymentHash)) {
      return res.status(400).json({
        error: 'Invalid preimage',
        message: 'Preimage does not match the payment hash'
      });
    }

    // Look up the invoice
    const invoice = await AgentInvoice.findOne({ paymentHash });
    if (!invoice) {
      return res.status(400).json({
        error: 'Invoice not found',
        message: 'No invoice found for this payment hash'
      });
    }

    if (invoice.status === 'paid') {
      // Already activated — return current balance
      const entitlement = await Entitlement.findOne({
        identifier: paymentHash,
        identifierType: 'prepaid'
      });

      const balanceUsdMicro = entitlement
        ? Math.max(0, entitlement.maxUsage - entitlement.usedCount)
        : 0;

      return res.json({
        paymentHash,
        balanceUsd: parseFloat(microUsdToUsd(balanceUsdMicro).toFixed(6)),
        balanceUsdMicro,
        clientId: invoice.clientId,
        message: 'Credits already activated'
      });
    }

    if (invoice.status === 'expired' || new Date() > invoice.expiresAt) {
      return res.status(400).json({
        error: 'Invoice expired',
        message: 'This invoice has expired. Please generate a new one.'
      });
    }

    // Mark invoice as paid
    invoice.status = 'paid';
    invoice.paidAt = new Date();
    await invoice.save();

    // Create or update entitlement with USD microdollar balance
    // If agent tops up again with same paymentHash (shouldn't happen but be safe),
    // upsert and add to existing balance
    const now = new Date();
    const farFuture = new Date(now);
    farFuture.setDate(farFuture.getDate() + 36500); // ~100 years

    const entitlement = await Entitlement.findOneAndUpdate(
      {
        identifier: paymentHash,
        identifierType: 'prepaid',
        entitlementType: 'apiAccess'
      },
      {
        $setOnInsert: {
          identifier: paymentHash,
          identifierType: 'prepaid',
          entitlementType: 'apiAccess',
          usedCount: 0,
          periodStart: now,
          periodLengthDays: 36500,
          nextResetDate: farFuture,
          lastUsed: now,
          status: 'active',
          metadata: {
            clientId: invoice.clientId,
            fundingSource: 'lightning',
            amountSats: invoice.amountSats,
            btcUsdRateAtPurchase: invoice.btcUsdRate
          }
        },
        $inc: { maxUsage: invoice.amountUsdMicro }
      },
      { new: true, upsert: true }
    );

    const balanceUsdMicro = Math.max(0, entitlement.maxUsage - entitlement.usedCount);

    res.json({
      paymentHash,
      balanceUsd: parseFloat(microUsdToUsd(balanceUsdMicro).toFixed(6)),
      balanceUsdMicro,
      clientId: invoice.clientId
    });
  } catch (error) {
    console.error('[AgentRoutes] Error activating credits:', error);
    res.status(500).json({
      error: 'Failed to activate credits',
      details: error.message
    });
  }
});

/**
 * GET /api/agent/balance
 * 
 * Check remaining USD balance for an agent credential.
 * Requires Authorization header: "preimage:paymentHash"
 */
router.get('/balance', async (req, res) => {
  // #swagger.tags = ['Agent Auth']
  // #swagger.summary = 'Check remaining balance'
  // #swagger.description = 'Returns the remaining USD balance for the given agent credential. Requires Authorization header with format preimage:paymentHash.'
  /* #swagger.parameters['Authorization'] = {
    in: 'header',
    required: true,
    type: 'string',
    description: 'Agent credential in format preimage:paymentHash'
  } */
  /* #swagger.responses[200] = {
    description: 'Balance retrieved',
    schema: {
      balanceUsd: 4.80,
      balanceUsdMicro: 4800000,
      totalDepositedUsd: 5.00,
      totalDepositedUsdMicro: 5000000,
      usedUsd: 0.20,
      usedUsdMicro: 200000,
      btcUsdRate: 100000,
      clientId: 'optional-session-id'
    }
  } */
  /* #swagger.responses[401] = {
    description: 'Missing or invalid Authorization header',
    schema: { error: 'Unauthorized', message: 'Valid Authorization header required (format: preimage:paymentHash)' }
  } */
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.includes(':') || authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authorization header required in format: preimage:paymentHash'
      });
    }

    const [preimage, paymentHash] = authHeader.split(':');
    const hexPattern = /^[0-9a-fA-F]{64}$/;

    if (!hexPattern.test(preimage) || !hexPattern.test(paymentHash)) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid credential format. Expected 64-char hex preimage:paymentHash'
      });
    }

    // Verify preimage cryptographically
    const computedHash = crypto.createHash('sha256')
      .update(Buffer.from(preimage, 'hex'))
      .digest('hex');

    if (computedHash !== paymentHash.toLowerCase()) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Preimage does not match payment hash'
      });
    }

    const entitlement = await Entitlement.findOne({
      identifier: paymentHash,
      identifierType: 'prepaid',
      status: 'active'
    });

    if (!entitlement) {
      return res.status(404).json({
        error: 'No balance found',
        message: 'No active credit balance for this credential. Purchase credits at POST /api/agent/purchase-credits'
      });
    }

    const balanceUsdMicro = Math.max(0, entitlement.maxUsage - entitlement.usedCount);
    const { rate: btcUsdRate } = await getBtcUsdRate();

    res.json({
      balanceUsd: parseFloat(microUsdToUsd(balanceUsdMicro).toFixed(6)),
      balanceUsdMicro,
      totalDepositedUsd: parseFloat(microUsdToUsd(entitlement.maxUsage).toFixed(6)),
      totalDepositedUsdMicro: entitlement.maxUsage,
      usedUsd: parseFloat(microUsdToUsd(entitlement.usedCount).toFixed(6)),
      usedUsdMicro: entitlement.usedCount,
      btcUsdRate,
      clientId: entitlement.metadata?.get('clientId') || null
    });
  } catch (error) {
    console.error('[AgentRoutes] Error checking balance:', error);
    res.status(500).json({
      error: 'Failed to check balance',
      details: error.message
    });
  }
});

module.exports = router;
