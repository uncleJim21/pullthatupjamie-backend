/**
 * Ticker quote service (spec §5) — provider-blind.
 *
 * Owns caching, market-hours TTL, and the stale-fallback contract; delegates
 * the actual fetch+parse to the pluggable quote-provider chain (Yahoo default,
 * Finnhub fallback when FINNHUB_API_KEY is set — see ./quoteProviders).
 *
 * Stale-fallback (§10): if every provider throttles/fails, return the last
 * cached value flagged `stale` rather than failing the request.
 */

const { getCached, setCached } = require('./tapeStore');
const { fetchQuoteWithFallback } = require('./quoteProviders');
const { TIER, quantTtlSec, quantMaxAgeSec, isUsMarketOpen, buildFreshnessMeta } = require('./tapeFreshness');
const { TapeHttpError } = require('./tapeErrors');
const { printLog } = require('../../constants');

const cacheKey = (slug) => `tape:q:${slug}`;

function buildBody(quote, source, { cached, cachedAt, fetchedAt, ttl, stale, staleReason }) {
  return {
    ...quote,
    _meta: {
      source,
      ...buildFreshnessMeta({
        tier: TIER.QUANTITATIVE, cached, cachedAt, fetchedAt, ttlSec: ttl, stale, staleReason,
      }),
    },
  };
}

/**
 * Get a fully-formed ticker quote response (including `_meta`).
 * @param {string} slug
 * @returns {Promise<object>}
 */
async function getTickerQuote(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new TapeHttpError(400, 'bad-request', 'Bad request', 'slug is required');
  }
  const key = cacheKey(slug);
  const ttl = quantTtlSec({ marketOpen: isUsMarketOpen() });

  // Fresh cache hit?
  const prior = await getCached(key);
  if (prior) {
    const ageSec = (Date.now() - new Date(prior.cachedAt).getTime()) / 1000;
    if (ageSec < ttl) {
      return buildBody(prior.value, prior.value._meta?.source || 'cache', {
        cached: true, cachedAt: prior.cachedAt, fetchedAt: prior.value._meta?.fetchedAt, ttl,
      });
    }
  }

  // Fetch fresh via the provider chain.
  try {
    const { quote, source } = await fetchQuoteWithFallback(slug);
    const fetchedAt = new Date().toISOString();
    const body = buildBody(quote, source, { cached: false, cachedAt: fetchedAt, fetchedAt, ttl });
    await setCached(key, body, ttl);
    return body;
  } catch (err) {
    if (err.code === 404) {
      throw new TapeHttpError(404, 'ticker-not-found', 'Unknown ticker', `No provider returned a result for "${slug}"`);
    }
    // Throttled / down: serve last cached value flagged stale (§10).
    if (prior) {
      const ageSec = (Date.now() - new Date(prior.cachedAt).getTime()) / 1000;
      const exceedsCeiling = ageSec > quantMaxAgeSec();
      printLog(`[tickerQuote] ${slug} all providers failed (${err.message}); serving stale (age=${Math.round(ageSec)}s, exceedsCeiling=${exceedsCeiling})`);
      return buildBody(prior.value, prior.value._meta?.source || 'cache', {
        cached: true, cachedAt: prior.cachedAt, fetchedAt: prior.value._meta?.fetchedAt, ttl,
        stale: true, staleReason: exceedsCeiling ? 'exceeds-quant-freshness' : 'upstream-unavailable',
      });
    }
    if (err.code === 429) {
      throw new TapeHttpError(429, 'rate-limited', 'Upstream rate limited',
        'Quote providers are rate limiting; retry shortly.', { creditInfo: { code: 'UPSTREAM_RATE_LIMITED' } });
    }
    throw new TapeHttpError(502, 'upstream-failure', 'Upstream failure', `Quote fetch failed: ${err.message}`);
  }
}

module.exports = { getTickerQuote };
