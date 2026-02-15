/**
 * Agent Routes - Lightning credit system for agent API access
 * 
 * These endpoints are STUBS (501 Not Implemented) until Issue #63 is completed.
 * Design spec: https://github.com/uncleJim21/pullthatupjamie-backend/issues/63
 * 
 * Flow:
 *   1. POST /purchase-credits  → returns Lightning invoice
 *   2. POST /activate-credits  → validates preimage, creates entitlement
 *   3. GET  /balance            → returns remaining credits
 * 
 * Auth: Authorization header with "preimage:paymentHash" (for activate-credits and balance)
 */

const express = require('express');
const router = express.Router();

/**
 * POST /api/agent/purchase-credits
 * 
 * Request a Lightning invoice to purchase API credits.
 * 
 * Tiers:
 *   - 1,000 sats  → 50 credits
 *   - 5,000 sats  → 300 credits (10% bonus)
 *   - 10,000 sats → 700 credits (20% bonus)
 *   - Min: 1,000 sats / Max: 50,000 sats per invoice
 */
router.post('/purchase-credits', (req, res) => {
  // #swagger.tags = ['Agent Auth']
  // #swagger.summary = 'Purchase API credits via Lightning invoice'
  // #swagger.description = 'Request a Lightning invoice to purchase API credits. Agents pay the invoice and use the preimage as a stateless auth credential. Tiers: 1,000 sats → 50 credits, 5,000 sats → 300 credits (10% bonus), 10,000 sats → 700 credits (20% bonus). Min 1,000 / Max 50,000 sats.'
  /* #swagger.parameters['body'] = {
    in: 'body',
    required: true,
    schema: {
      amount: 1000,
      clientId: 'optional-for-session-linking'
    }
  } */
  /* #swagger.responses[200] = {
    description: 'Lightning invoice generated',
    schema: {
      invoice: 'lnbc10u1p...',
      paymentHash: 'abc123def456...',
      credits: 50
    }
  } */
  /* #swagger.responses[400] = {
    description: 'Invalid amount (must be between 1,000 and 50,000 sats)',
    schema: { error: 'Invalid amount', message: 'Amount must be between 1000 and 50000 sats' }
  } */
  /* #swagger.responses[501] = {
    description: 'Not yet implemented',
    schema: { error: 'Not implemented', message: 'Lightning credit purchase is not yet available. See: https://github.com/uncleJim21/pullthatupjamie-backend/issues/63' }
  } */
  res.status(501).json({
    error: 'Not implemented',
    message: 'Lightning credit purchase is not yet available. See: https://github.com/uncleJim21/pullthatupjamie-backend/issues/63',
    plannedRequest: {
      amount: 'number (sats, 1000-50000)',
      clientId: 'string (optional, for session linking)'
    },
    plannedResponse: {
      invoice: 'BOLT11 invoice string',
      paymentHash: 'hex string',
      credits: 'number of API credits'
    }
  });
});

/**
 * POST /api/agent/activate-credits
 * 
 * Activate purchased credits by providing the Lightning preimage.
 * Validates the preimage against the payment hash and creates an entitlement.
 */
router.post('/activate-credits', (req, res) => {
  // #swagger.tags = ['Agent Auth']
  // #swagger.summary = 'Activate credits with Lightning preimage'
  // #swagger.description = 'After paying the Lightning invoice, submit the preimage and paymentHash to activate your credits. The preimage becomes your stateless auth credential for subsequent API calls.'
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
      credits: 50,
      clientId: 'optional-session-id'
    }
  } */
  /* #swagger.responses[400] = {
    description: 'Invalid preimage or paymentHash',
    schema: { error: 'Invalid preimage', message: 'Preimage does not match the payment hash' }
  } */
  /* #swagger.responses[501] = {
    description: 'Not yet implemented',
    schema: { error: 'Not implemented', message: 'Lightning credit activation is not yet available. See: https://github.com/uncleJim21/pullthatupjamie-backend/issues/63' }
  } */
  res.status(501).json({
    error: 'Not implemented',
    message: 'Lightning credit activation is not yet available. See: https://github.com/uncleJim21/pullthatupjamie-backend/issues/63',
    plannedRequest: {
      preimage: 'hex string (from paid invoice)',
      paymentHash: 'hex string (from purchase-credits response)'
    },
    plannedResponse: {
      paymentHash: 'hex string',
      credits: 'number of activated credits',
      clientId: 'string (if provided during purchase)'
    }
  });
});

/**
 * GET /api/agent/balance
 * 
 * Check remaining credit balance for an agent credential.
 * Requires Authorization header: "preimage:paymentHash"
 */
router.get('/balance', (req, res) => {
  // #swagger.tags = ['Agent Auth']
  // #swagger.summary = 'Check remaining credit balance'
  // #swagger.description = 'Returns the remaining credit balance for the given agent credential. Requires Authorization header with format "preimage:paymentHash". Uses existing checkEntitlementEligibility().'
  /* #swagger.parameters['Authorization'] = {
    in: 'header',
    required: true,
    type: 'string',
    description: 'Agent credential in format preimage:paymentHash'
  } */
  /* #swagger.responses[200] = {
    description: 'Credit balance retrieved',
    schema: {
      remainingUsage: 47,
      maxUsage: 50,
      usedCount: 3,
      clientId: 'optional-session-id'
    }
  } */
  /* #swagger.responses[401] = {
    description: 'Missing or invalid Authorization header',
    schema: { error: 'Unauthorized', message: 'Valid Authorization header required (format: preimage:paymentHash)' }
  } */
  /* #swagger.responses[501] = {
    description: 'Not yet implemented',
    schema: { error: 'Not implemented', message: 'Lightning credit balance check is not yet available. See: https://github.com/uncleJim21/pullthatupjamie-backend/issues/63' }
  } */
  res.status(501).json({
    error: 'Not implemented',
    message: 'Lightning credit balance check is not yet available. See: https://github.com/uncleJim21/pullthatupjamie-backend/issues/63',
    plannedRequest: {
      authorization: 'Header: preimage:paymentHash'
    },
    plannedResponse: {
      remainingUsage: 'number',
      maxUsage: 'number',
      usedCount: 'number',
      clientId: 'string (if provided during purchase)'
    }
  });
});

module.exports = router;
