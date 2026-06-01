/**
 * DRY request scaffolding for /api/tape/* handlers.
 *
 * Provides:
 *   - checkRateLimit(req, res, endpoint, hourlyLimit) — per-(sub, endpoint, hour)
 *   - logTape(entry)                                  — single-line structured log (§8)
 *   - withCachedEndpoint({...})                        — full cached-JSON handler:
 *         rate-limit -> cache read -> handler -> cache write -> freshness _meta -> log
 *
 * Rate-limit and logging are also exported standalone so `synthesize`
 * (custom streaming + cost guards) can reuse them without the cache wrapper.
 */

const { incrWindow, getCached, setCached } = require('./tapeStore');
const { tapeError, tapeRateLimited, TapeHttpError } = require('./tapeErrors');
const { buildFreshnessMeta } = require('./tapeFreshness');
const { printLog } = require('../../constants');

const NOCACHE_ENABLED = process.env.TAPE_NOCACHE_ENABLED === 'true';

/** Current UTC hour bucket, e.g. "2026-06-01T14". */
function hourBucket(now = new Date()) {
  return now.toISOString().slice(0, 13);
}

/**
 * Enforce the per-JWT hourly limit for `endpoint`. Returns true when allowed;
 * when exceeded it has already sent a 429 and returns false.
 */
async function checkRateLimit(req, res, endpoint, hourlyLimit) {
  if (!Number.isFinite(hourlyLimit) || hourlyLimit <= 0) return true;
  const sub = (req.tape && req.tape.sub) || 'anon';
  const key = `tape:rl:${sub}:${endpoint}:${hourBucket()}`;
  const count = await incrWindow(key, 3600);
  if (count > hourlyLimit) {
    const resetDate = new Date(Date.now() + (3600 - (Date.now() / 1000 % 3600)) * 1000);
    tapeRateLimited(res, {
      detail: `Rate limit of ${hourlyLimit}/hour for ${endpoint} exceeded.`,
      used: count - 1,
      max: hourlyLimit,
      resetDate,
      retryAfterSec: 3600 - Math.floor((Date.now() / 1000) % 3600),
    });
    return false;
  }
  return true;
}

/** Emit a single-line structured log per request (§8). */
function logTape(entry) {
  try {
    printLog(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
  } catch (_) { /* logging must never throw */ }
}

/**
 * Wrap a cached JSON endpoint.
 *
 * @param {object} opts
 * @param {string}   opts.endpoint                 name (log + rate-limit key)
 * @param {number}   opts.hourlyLimit              per-sub hourly cap
 * @param {string}   opts.tier                     freshness TIER.* value
 * @param {(req)=>number} opts.ttlSec              cache TTL for this response
 * @param {(req)=>string|null} opts.cacheKey       null => skip caching
 * @param {(req)=>Promise<{body:object,fetchedAt?:string,underlying?:object}>} opts.handler
 * @param {(body:object)=>string[]} [opts.idsOf]   identity set for revalidation detection
 */
function withCachedEndpoint({ endpoint, hourlyLimit, tier, ttlSec, cacheKey, handler, idsOf }) {
  return async (req, res) => {
    const startedAt = Date.now();
    try {
      if (!(await checkRateLimit(req, res, endpoint, hourlyLimit))) return;

      const key = cacheKey ? cacheKey(req) : null;
      const noCache = NOCACHE_ENABLED && req.body && req.body._nocache === true;
      const refresh = req.body && req.body.refresh === true;
      const ttl = Math.max(1, Math.floor(ttlSec(req)));

      // --- cache read (skip on refresh / _nocache) ---
      let prior = null;
      if (key && !noCache) {
        prior = await getCached(key);
        if (prior && !refresh) {
          const body = {
            ...prior.value,
            _meta: {
              ...(prior.value._meta || {}),
              ...buildFreshnessMeta({
                tier, cached: true, cachedAt: prior.cachedAt,
                fetchedAt: prior.value._meta?.fetchedAt, ttlSec: ttl,
              }),
            },
          };
          logTape({ endpoint, jwt_sub: req.tape?.sub, cache: 'hit', status: 200, elapsed_ms: Date.now() - startedAt });
          return res.status(200).json(body);
        }
      }

      // --- compute fresh ---
      const result = await handler(req);
      const payload = result.body || {};
      const fetchedAt = result.fetchedAt || new Date().toISOString();

      // Revalidation: refreshed payload identical to the prior cached one →
      // reuse the original cachedAt and flag it, so identical downstream
      // synthesize keys keep hitting cache (zero LLM tokens).
      let revalidated = false;
      let cachedAt = new Date().toISOString();
      if (refresh && prior && typeof idsOf === 'function') {
        const a = JSON.stringify(idsOf(prior.value) || []);
        const b = JSON.stringify(idsOf(payload) || []);
        if (a === b) { revalidated = true; cachedAt = prior.cachedAt; }
      }

      const meta = buildFreshnessMeta({
        tier, cached: false, revalidated, cachedAt, fetchedAt, ttlSec: ttl,
      });
      const body = { ...payload, _meta: { ...(payload._meta || {}), ...meta } };

      if (key && !noCache) await setCached(key, body, ttl);

      logTape({
        endpoint, jwt_sub: req.tape?.sub,
        cache: refresh ? (revalidated ? 'revalidate' : 'refresh') : 'miss',
        upstream_calls: result.underlying || undefined,
        status: 200, elapsed_ms: Date.now() - startedAt,
      });
      return res.status(200).json(body);
    } catch (err) {
      if (err instanceof TapeHttpError) {
        logTape({ endpoint, jwt_sub: req.tape?.sub, status: err.status, error: err.slug, elapsed_ms: Date.now() - startedAt });
        return tapeError(res, err.status, err.slug, err.title, err.detail, err.extra);
      }
      logTape({ endpoint, jwt_sub: req.tape?.sub, status: 502, error: 'upstream', detail: err.message, elapsed_ms: Date.now() - startedAt });
      return tapeError(res, 502, 'upstream-failure', 'Upstream failure', err.message);
    }
  };
}

module.exports = { withCachedEndpoint, checkRateLimit, logTape, hourBucket };
