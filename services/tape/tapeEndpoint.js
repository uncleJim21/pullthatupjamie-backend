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

const { incrWindow, getCached, setCached, addAndGet } = require('./tapeStore');
const { tapeError, tapeRateLimited, TapeHttpError } = require('./tapeErrors');
const { buildFreshnessMeta, TIER } = require('./tapeFreshness');
const { hashBody } = require('./tapeShared');
const { PROMPT_VERSION } = require('./tapePrompts');
const semanticCache = require('./semanticCache');
const { audit } = require('./tapeAudit');
const { printLog } = require('../../constants');

let auditSeq = 0;

const NOCACHE_ENABLED = process.env.TAPE_NOCACHE_ENABLED === 'true';
const KIND_TTL_SEC = parseInt(process.env.TAPE_KIND_TTL_SEC || '7200', 10); // 2h
const DAILY_TOKEN_CAP = parseInt(process.env.TAPE_DAILY_OUTPUT_TOKEN_CAP || '5000000', 10);
function utcDay() { return new Date().toISOString().slice(0, 10); }
function secsToUtcMidnight() {
  const n = new Date();
  const nx = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1));
  return Math.max(60, Math.ceil((nx.getTime() - n.getTime()) / 1000));
}

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
 * @param {(body:object)=>boolean} [opts.cacheable] gate caching of a result
 *        (default: always). Used to NOT cache empty results so a transient/empty
 *        retrieval doesn't get pinned for the full TTL.
 */
function withCachedEndpoint({ endpoint, hourlyLimit, tier, ttlSec, cacheKey, handler, idsOf, cacheable }) {
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

      // Don't pin empty/uncacheable results — otherwise a zero-candidate
      // retrieval (e.g. an odd phrasing) gets stuck in cache for the full TTL.
      const shouldCache = typeof cacheable === 'function' ? cacheable(body) : true;
      if (key && !noCache && shouldCache) await setCached(key, body, ttl);

      logTape({
        endpoint, jwt_sub: req.tape?.sub,
        cache: refresh ? (revalidated ? 'revalidate' : 'refresh') : 'miss',
        cached_write: shouldCache,
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

/**
 * The kind cache identity: `tape:kind:<kind>:<PROMPT_VERSION>:<hash(body)>`.
 * Single source of truth — both the live request path and the offline warmer
 * derive the key here so a warmed entry is byte-for-byte what a live request
 * reads. Note `hashBody` strips `refresh`/`_nocache`, so warming with
 * `refresh:true` writes the same key the frontend (no refresh) will hit.
 */
function kindCacheKey(kind, body) {
  // Read-In keys on the TICKER ALONE (normalized) — deliberately ignoring `model`
  // and every other body field. The frontend sends model:"quality" but the warmer
  // synthesizes on the cheap model; keying on ticker lets ANY read-in request hit
  // the single warmed entry. We accept the minor quality-vs-fast inaccuracy in
  // favor of cost + cache-hit rate. Other kinds key on their full body (topic /
  // persons / dates genuinely change the result).
  const identity = kind === 'readin'
    ? { ticker: String((body && body.ticker) || '').trim().toUpperCase() }
    : body;
  return `tape:kind:${kind}:${PROMPT_VERSION}:${hashBody(identity)}`;
}

/**
 * Compute one kind result and write it to cache (+ semantic map). Shared by the
 * HTTP handler and the cache warmer so the key formula, freshness `_meta`, token
 * accounting, cache write, and semantic-remember live in exactly one place.
 *
 * Caller is responsible for the rate-limit, cache READ, and (HTTP only) the
 * daily-cap pre-check + 429 rendering — those differ by path (the warmer just
 * stops). Token usage is always added to the shared daily counter here.
 *
 * @returns {{ out:object, key:string, usage:object|null, synthesizedEmpty:boolean }}
 */
async function computeAndCacheKind({ kind, body, run, openai, refresh = false, noCache = false, jwtSub, auditId, queryEmb = null }) {
  const day = utcDay();
  const ttlDay = secsToUtcMidnight();
  const fetchedAt = new Date().toISOString();
  const { result, usage, synthesizedEmpty } = await run(body, { jwtSub, refresh, auditId });
  if (usage && DAILY_TOKEN_CAP > 0) await addAndGet(`tape:syn:tok:${day}`, usage.output_tokens || 0, ttlDay);
  audit('response', auditId, { kind, synthesizedEmpty, confidence: result?._meta?.confidence, result });

  const out = {
    ...result,
    _meta: {
      ...(result._meta || {}),
      fetchedAt,
      // Synthesis token usage (for cost tracking / model A-B in the eval harness).
      tokens: usage ? { input: usage.input_tokens || 0, output: usage.output_tokens || 0 } : null,
      ...buildFreshnessMeta({ tier: TIER.QUALITATIVE, cached: false, cachedAt: fetchedAt, fetchedAt, ttlSec: KIND_TTL_SEC }),
    },
  };

  const key = kindCacheKey(kind, body);
  if (!noCache && !synthesizedEmpty) {
    await setCached(key, out, KIND_TTL_SEC);
    // Remember the query embedding → key so near-identical future queries hit.
    const semText = (semanticCache.ENABLED && openai) ? semanticCache.semanticText(kind, body) : '';
    if (semText) {
      const scope = semanticCache.scopeOf(kind, body, PROMPT_VERSION);
      const emb = queryEmb || await semanticCache.embed(semText, openai);
      semanticCache.remember(scope, emb, key);
    }
  }
  return { out, key, usage, synthesizedEmpty };
}

/**
 * Wrap a kind-level endpoint (dossier/brief/split/narrative/readin): rate-limit
 * → kind cache (full parsed Result, 2h) → daily-token-cap → run() → cache write
 * → freshness _meta → log. `run(body, { jwtSub })` returns
 * `{ result, usage, synthesizedEmpty }`; throws TapeHttpError on hard failure.
 * Empty results are not cached (a retry may succeed).
 */
function withKindEndpoint({ kind, hourlyLimit, run, openai }) {
  return async (req, res) => {
    const startedAt = Date.now();
    // eslint-disable-next-line no-plusplus
    const auditId = `${kind}-${Date.now().toString(36)}-${(auditSeq++).toString(36)}`;
    try {
      if (!(await checkRateLimit(req, res, kind, hourlyLimit))) return;
      const body = req.body || {};
      audit('request', auditId, { kind, jwt_sub: req.tape?.sub, body });
      const refresh = body.refresh === true;
      const noCache = NOCACHE_ENABLED && body._nocache === true;
      // Tie the kind cache to PROMPT_VERSION so prompt/pipeline fixes evict stale
      // (e.g. pre-fix empty-citation) entries instead of serving them for the TTL.
      const key = kindCacheKey(kind, body);
      // Semantic cache: "essentially the same" query (within the same kind +
      // asOfDate + model scope) reuses a cached result. Free-text kinds only.
      const scope = semanticCache.scopeOf(kind, body, PROMPT_VERSION);
      const semText = (semanticCache.ENABLED && openai) ? semanticCache.semanticText(kind, body) : '';
      let queryEmb = null;

      const serveCached = (prior, match, sim) => {
        const out = {
          ...prior.value,
          _meta: {
            ...(prior.value._meta || {}),
            cacheMatch: match,
            ...(sim != null ? { cacheSimilarity: parseFloat(sim.toFixed(3)) } : {}),
            ...buildFreshnessMeta({ tier: TIER.QUALITATIVE, cached: true, cachedAt: prior.cachedAt, fetchedAt: prior.value._meta?.fetchedAt, ttlSec: KIND_TTL_SEC }),
          },
        };
        logTape({ endpoint: kind, jwt_sub: req.tape?.sub, cache: match === 'semantic' ? 'semantic-hit' : 'hit', sim: sim != null ? parseFloat(sim.toFixed(3)) : undefined, status: 200, elapsed_ms: Date.now() - startedAt });
        audit('cache_hit', auditId, { kind, match, sim });
        return res.status(200).json(out);
      };

      if (!noCache && !refresh) {
        const prior = await getCached(key);
        if (prior) return serveCached(prior, 'exact');
        // Semantic fallback: a near-identical prior query in the same scope.
        if (semText) {
          queryEmb = await semanticCache.embed(semText, openai);
          const sem = semanticCache.lookup(scope, queryEmb);
          if (sem) {
            const semPrior = await getCached(sem.key);
            if (semPrior) return serveCached(semPrior, 'semantic', sem.sim);
            semanticCache.forget(scope, sem.key); // mapping outlived the cached value
          }
        }
      }

      // Global daily output-token cap (shared with /synthesize).
      const day = utcDay();
      const ttlDay = secsToUtcMidnight();
      if (DAILY_TOKEN_CAP > 0) {
        const tot = await addAndGet(`tape:syn:tok:${day}`, 0, ttlDay);
        if (tot >= DAILY_TOKEN_CAP) {
          logTape({ endpoint: kind, jwt_sub: req.tape?.sub, status: 429, error: 'daily-cap', elapsed_ms: Date.now() - startedAt });
          return tapeRateLimited(res, { detail: 'Daily synthesis token cap reached; resets at UTC midnight.', retryAfterSec: ttlDay });
        }
      }

      const { out, usage } = await computeAndCacheKind({
        kind, body, run, openai, refresh, noCache, jwtSub: req.tape?.sub, auditId, queryEmb,
      });
      logTape({ endpoint: kind, jwt_sub: req.tape?.sub, cache: refresh ? 'refresh' : 'miss', confidence: out._meta?.confidence, tokens: usage || null, status: 200, elapsed_ms: Date.now() - startedAt });
      return res.status(200).json(out);
    } catch (err) {
      if (err instanceof TapeHttpError) {
        logTape({ endpoint: kind, jwt_sub: req.tape?.sub, status: err.status, error: err.slug, elapsed_ms: Date.now() - startedAt });
        return tapeError(res, err.status, err.slug, err.title, err.detail, err.extra);
      }
      printLog(`[tape:${kind}] error: ${err.message}`);
      logTape({ endpoint: kind, jwt_sub: req.tape?.sub, status: 502, error: 'upstream', detail: err.message, elapsed_ms: Date.now() - startedAt });
      return tapeError(res, 502, 'upstream-failure', 'Upstream failure', err.message);
    }
  };
}

module.exports = { withCachedEndpoint, withKindEndpoint, computeAndCacheKind, kindCacheKey, checkRateLimit, logTape, hourBucket };
