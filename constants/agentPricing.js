/**
 * Agent API Pricing
 * 
 * USD cost per API call, stored in microdollars (integers).
 * 1 microdollar = $0.000001
 * 
 * Example: search-quotes costs $0.002 = 2,000 microdollars
 * 
 * These are starter values — tune based on actual cost-to-serve.
 */

const AGENT_PRICING_MICRO_USD = {
  'search-quotes':        4000,    // $0.002 per search (embedding + Pinecone)
  'search-quotes-3d':     10000,   // $0.01 per 3D search (embedding + UMAP)
  'make-clip':            50000,   // $0.05 per clip (video processing)
  'jamie-assist':         20000,   // $0.02 per assist (LLM call)
  'ai-analyze':           20000,   // $0.02 per analysis (LLM call)
  'submit-on-demand-run': 450000,  // $0.45 per on-demand run (heavy processing)
  'discover-podcasts':    5000     // $0.005 per discovery (LLM extraction + Podcast Index search)
};

// Deposit limits (in sats)
const AGENT_MIN_DEPOSIT_SATS = 10;        // 10 sats minimum
const AGENT_MAX_DEPOSIT_SATS = 500000;    // 500,000 sats maximum

// Default amount for inline 402 challenges on protected endpoints
const DEFAULT_CREDIT_PURCHASE_SATS = parseInt(process.env.DEFAULT_CREDIT_PURCHASE_SATS) || 500;

/**
 * Get the microdollar cost for a given entitlement type.
 * Returns null if the entitlement type has no agent pricing (not billable).
 * 
 * @param {string} entitlementType
 * @returns {number|null} cost in microdollars, or null if not priced
 */
function getAgentCostMicroUsd(entitlementType) {
  return AGENT_PRICING_MICRO_USD[entitlementType] ?? null;
}

module.exports = {
  AGENT_PRICING_MICRO_USD,
  AGENT_MIN_DEPOSIT_SATS,
  AGENT_MAX_DEPOSIT_SATS,
  DEFAULT_CREDIT_PURCHASE_SATS,
  getAgentCostMicroUsd
};
