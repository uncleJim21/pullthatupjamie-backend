/**
 * Entitlement Type Constants
 * 
 * All entitlement types use kebab-case for consistency.
 * 
 * Endpoint → Entitlement Type:
 *   /api/search-quotes              → search-quotes
 *   /api/search-quotes-3d           → search-quotes-3d
 *   /api/make-clip                  → make-clip
 *   /api/jamie-assist/:hash         → jamie-assist
 *   /api/research/analyze           → ai-analyze
 *   /api/on-demand/submitOnDemandRun → submit-on-demand-run
 *   /api/user/twitter/tweet          → twitter-post
 *   /api/user/social/posts (twitter) → twitter-post
 *   /api/discover-podcasts            → discover-podcasts
 *   /api/rss/searchFeeds              → discover-podcasts
 *   /api/rss/getFeed                  → discover-podcasts
 *   /api/corpus/chapters              → chapter-search
 */

const ENTITLEMENT_TYPES = {
  SEARCH_QUOTES: 'search-quotes',
  SEARCH_QUOTES_3D: 'search-quotes-3d',
  MAKE_CLIP: 'make-clip',
  JAMIE_ASSIST: 'jamie-assist',
  AI_ANALYZE: 'ai-analyze',
  SUBMIT_ON_DEMAND_RUN: 'submit-on-demand-run',
  TWITTER_POST: 'twitter-post',
  DISCOVER_PODCASTS: 'discover-podcasts',
  CHAPTER_SEARCH: 'chapter-search'
};

// Array of all types for iteration
const ALL_ENTITLEMENT_TYPES = Object.values(ENTITLEMENT_TYPES);

module.exports = {
  ENTITLEMENT_TYPES,
  ALL_ENTITLEMENT_TYPES
};
