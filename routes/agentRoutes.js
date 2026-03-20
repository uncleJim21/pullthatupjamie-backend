/**
 * Agent Routes - L402 Lightning pay-per-use system for agent API access
 * 
 * Design spec: https://github.com/uncleJim21/pullthatupjamie-backend/issues/63
 * 
 * L402 Protocol:
 *   - Protected endpoints return HTTP 402 with WWW-Authenticate header containing
 *     a macaroon and Lightning invoice when no valid credential is present.
 *   - After paying the invoice, agents present Authorization: L402 <macaroon>:<preimage>
 *   - Credits are auto-activated on first use (no separate activate step).
 *   - Subsequent requests reuse the same credential; balance is deducted per call.
 * 
 * Pricing model:
 *   - Pre-pay any amount in sats (10 - 500,000) via Lightning invoice
 *   - Sats are converted to USD (microdollars) at the current BTC/USD rate
 *   - Each API call deducts its USD cost from the balance
 *   - Balance is tracked in microdollars (1 microdollar = $0.000001)
 * 
 * Flow:
 *   1. Agent hits any protected endpoint → 402 with default invoice
 *      (optional: append ?amountSats=N for a custom credit amount)
 *   2. Agent pays invoice, retries with Authorization: L402 <macaroon>:<preimage>
 *   3. Server auto-activates credits and serves the request
 *   4. GET /balance returns remaining USD balance
 */

const express = require('express');
const router = express.Router();

const { Entitlement } = require('../models/Entitlement');
const { validatePreimage } = require('../utils/lightning-utils');
const { getBtcUsdRate, isLightningAvailable, microUsdToUsd } = require('../utils/btcPrice');
const { verifyMacaroon, parseL402Header } = require('../utils/macaroon-utils');

/**
 * Middleware: check that lightning services are available (price is fresh enough)
 * On first request, triggers a synchronous price fetch to warm the cache.
 */
async function requireLightningAvailable(req, res, next) {
  if (!isLightningAvailable()) {
    try {
      await getBtcUsdRate();
    } catch (err) {
      console.error('[AgentRoutes] Failed to fetch initial BTC/USD rate:', err.message);
    }

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
 * GET /api/agent/balance
 * 
 * Check remaining USD balance for an L402 agent credential.
 * Requires Authorization header: "L402 <macaroon>:<preimage>"
 */
router.get('/balance', async (req, res) => {
  // #swagger.tags = ['Agent Auth']
  // #swagger.summary = 'Check remaining balance'
  // #swagger.description = 'Returns the remaining USD balance for the given L402 credential. Requires Authorization header with format: L402 <macaroon>:<preimage>'
  /* #swagger.parameters['Authorization'] = {
    in: 'header',
    required: true,
    type: 'string',
    description: 'L402 credential in format: L402 <base64_macaroon>:<hex_preimage>'
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
    schema: { error: 'Unauthorized', message: 'Valid L402 Authorization header required' }
  } */
  try {
    const authHeader = req.headers.authorization;
    const l402 = parseL402Header(authHeader);

    if (!l402) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authorization header required in format: L402 <base64_macaroon>:<hex_preimage>'
      });
    }

    const { macaroonBase64, preimage } = l402;

    const macResult = verifyMacaroon(macaroonBase64);
    if (!macResult.valid) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: `Invalid macaroon: ${macResult.error}`
      });
    }

    const { paymentHash } = macResult;

    if (!validatePreimage(preimage, paymentHash)) {
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
        message: 'No active credit balance for this credential. Hit any paid endpoint to receive a 402 challenge with a Lightning invoice.'
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
