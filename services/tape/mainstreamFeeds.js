/**
 * Resolve the allowlisted ("mainstream") shows to their feedIds, so retrieval
 * can be CONSTRAINED to them at the Pinecone level.
 *
 * Why: for crowded topics (bitcoin, AI), the densest-talking shows are often the
 * crypto/niche ones — which are on the DENY list. They dominate vector relevance
 * and crowd mainstream shows out of the retrieved top-N *before* the post-filter
 * runs, so a `mainstream:true` query can come back near-empty even though the
 * mainstream coverage is plentiful (just lower-ranked). Passing the allowlist
 * feedIds into searchQuotes filters at the source, so the retrieval budget is
 * spent only on shows that survive.
 *
 * Result is cached process-wide (1h) — the feed roster changes slowly.
 */

const JamieVectorMetadata = require('../../models/JamieVectorMetadata');
const taste = require('./tapeTaste');
const { printLog } = require('../../constants');

const TTL_MS = parseInt(process.env.TAPE_MAINSTREAM_FEEDS_TTL_MS || '3600000', 10);
let cache = null;
let cachedAt = 0;
let lastRun = { totalFeeds: 0, matched: 0, sampleTitles: [], error: null }; // debug

function getResolverStats() { return lastRun; }

/**
 * @returns {Promise<string[]>} feedIds of allowlisted (and not denied) shows.
 * Empty array on failure → callers should treat empty as "don't constrain".
 */
async function getMainstreamFeedIds() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  try {
    // Show name lives in metadataRaw.creator (the same field isMainstream matches
    // in the post-filter) — NOT feedTitle, which is null on these docs.
    const feeds = await JamieVectorMetadata.aggregate([
      { $match: { type: 'episode', 'metadataRaw.creator': { $exists: true, $ne: null } } },
      { $group: { _id: '$feedId', title: { $first: '$metadataRaw.creator' } } },
    ]);
    const matched = feeds.filter((f) => f._id != null && taste.isMainstream(f.title));
    const ids = matched.map((f) => String(f._id));
    cache = [...new Set(ids)];
    cachedAt = Date.now();
    lastRun = { totalFeeds: feeds.length, matched: matched.length, sampleTitles: feeds.slice(0, 6).map((f) => f.title), error: null };
    printLog(`[mainstreamFeeds] resolved ${cache.length} allowlisted feedIds from ${feeds.length} feeds`);
    return cache;
  } catch (err) {
    lastRun = { totalFeeds: 0, matched: 0, sampleTitles: [], error: err.message };
    printLog(`[mainstreamFeeds] resolve failed (${err.message}); leaving retrieval unconstrained`);
    return cache || [];
  }
}

module.exports = { getMainstreamFeedIds, getResolverStats };
