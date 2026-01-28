/**
 * Entitlement Type Constants
 * 
 * These MUST match the last path segment of the endpoint they protect.
 * This ensures frontend can easily map entitlement checks to API calls.
 * 
 * Endpoint → Entitlement Type:
 *   /api/search-quotes              → search-quotes
 *   /api/search-quotes-3d           → search-quotes-3d
 *   /api/make-clip                  → make-clip
 *   /api/jamie-assist/:hash         → jamie-assist
 *   /api/research/analyze           → analyze
 *   /api/on-demand/submitOnDemandRun → submitOnDemandRun
 */

const ENTITLEMENT_TYPES = {
  SEARCH_QUOTES: 'search-quotes',
  SEARCH_QUOTES_3D: 'search-quotes-3d',
  MAKE_CLIP: 'make-clip',
  JAMIE_ASSIST: 'jamie-assist',
  ANALYZE: 'analyze',
  SUBMIT_ON_DEMAND_RUN: 'submitOnDemandRun'
};

// Array of all types for iteration
const ALL_ENTITLEMENT_TYPES = Object.values(ENTITLEMENT_TYPES);

module.exports = {
  ENTITLEMENT_TYPES,
  ALL_ENTITLEMENT_TYPES
};
