/**
 * Tape skin backend — self-contained /api/tape/* module.
 *
 * Mounts: auth + Yahoo/Finnhub quote proxy + person-quotes + topic-quotes +
 * synthesize. Reuses the existing service layer (searchQuotes, corpusService,
 * the agent provider abstraction) — see services/tape/* for the recipes and
 * ./plans/i-am-making-a-gentle-treehouse.md for the design.
 *
 * Usage (server.js):
 *   const createTapeRoutes = require('./routes/tapeRoutes');
 *   app.use('/api/tape', createTapeRoutes({ openai }));
 */

const express = require('express');

const { signTapeToken, requireTapeAuth, passwordMatches } = require('../services/tape/tapeAuth');
const { tapeError } = require('../services/tape/tapeErrors');
const { withCachedEndpoint, withKindEndpoint, checkRateLimit, logTape } = require('../services/tape/tapeEndpoint');
const { runDossier, runBrief, runSplit, runNarrative, runReadin } = require('../services/tape/kindOrchestrator');
const { TIER, qualTtlSec } = require('../services/tape/tapeFreshness');
const { hashBody, candidateIds } = require('../services/tape/tapeShared');
const { TapeHttpError } = require('../services/tape/tapeErrors');
const { getTickerQuote } = require('../services/tape/tickerQuote');
const { personQuotes } = require('../services/tape/personQuotes');
const { topicQuotes } = require('../services/tape/topicQuotes');
const { createSynthesizeHandler } = require('../services/tape/synthesize');
const { warmReadins, getWarmTickers, effectiveLimit } = require('../services/tape/warmReadins');
const crypto = require('crypto');

/** Timing-safe check of SHARED_HMAC_SECRET in Authorization: Bearer or x-warm-secret. */
function warmAuthorized(req) {
  const secret = process.env.SHARED_HMAC_SECRET || '';
  if (!secret) return false; // route disabled until the secret is configured
  const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || String(req.headers['x-warm-secret'] || '');
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createTapeRoutes({ openai } = {}) {
  const router = express.Router();

  // --- POST /auth (unauthenticated; mints the demo JWT) ---
  router.post('/auth', (req, res) => {
    const { password } = req.body || {};
    if (!passwordMatches(password)) {
      return tapeError(res, 401, 'auth-failed', 'Wrong password');
    }
    try {
      const { token, expiresAt, scope } = signTapeToken();
      logTape({ endpoint: 'auth', status: 200 });
      return res.status(200).json({ token, expiresAt, scope });
    } catch (err) {
      return tapeError(res, 500, 'auth-misconfigured', 'Auth not configured', err.message);
    }
  });

  // --- POST /warm (shared-secret; manually arm the in-process Read-In cache warm) ---
  // Runs in the SAME process so it populates the live in-memory cache (no Redis →
  // a restart or a separate process can't do this). Gated by SHARED_HMAC_SECRET,
  // NOT the demo JWT — so it's mounted above requireTapeAuth. Body (all optional):
  //   { dryRun: true }   → authenticate + return the planned ticker list, NO synthesis (free)
  //   { only: ["NVDA"] } → warm just these tickers
  //   { limit: 5 }       → warm the top N of the generic order
  //   { wait: true }     → await the run and return the summary (use only with a small subset)
  // Default (no wait): kicks the full warm off in the background, returns 202.
  let warmInFlight = false;
  router.post('/warm', async (req, res) => {
    if (!warmAuthorized(req)) {
      return tapeError(res, 401, 'unauthorized', 'Unauthorized', 'Missing or invalid warm secret');
    }
    const body = req.body || {};
    const only = Array.isArray(body.only) && body.only.length ? body.only.map(String) : undefined;
    const limit = Number.isFinite(body.limit) ? body.limit : undefined;

    // dryRun: prove receive + auth without spending a single token.
    if (body.dryRun === true) {
      const planned = only || getWarmTickers().slice(0, Number.isFinite(limit) ? limit : effectiveLimit());
      logTape({ endpoint: 'warm', mode: 'dry-run', count: planned.length, status: 200 });
      return res.status(200).json({ ok: true, dryRun: true, count: planned.length, tickers: planned });
    }

    if (warmInFlight) {
      return tapeError(res, 409, 'warm-in-progress', 'Warm in progress', 'A cache warm is already running on this instance.');
    }
    const doWarm = async () => {
      warmInFlight = true;
      try { return await warmReadins({ openai, only, limit, log: (m) => console.log(m) }); }
      finally { warmInFlight = false; }
    };

    if (body.wait === true) {
      try {
        const result = await doWarm();
        return res.status(200).json({ ok: true, ...result });
      } catch (err) {
        return tapeError(res, 502, 'warm-failed', 'Warm failed', err.message);
      }
    }
    // Fire-and-forget: a full warm takes ~30 min, far longer than an HTTP timeout.
    doWarm().catch((err) => console.error('[TapeWarm] arm error:', err.message));
    logTape({ endpoint: 'warm', mode: 'async', status: 202 });
    return res.status(202).json({ ok: true, started: true, message: 'Warm started in background; watch [TapeWarm] logs.' });
  });

  // All routes below require a valid, current Tape JWT.
  router.use(requireTapeAuth);

  // --- GET /quote/:slug (Yahoo/Finnhub proxy) ---
  router.get('/quote/:slug', async (req, res) => {
    const startedAt = Date.now();
    try {
      if (!(await checkRateLimit(req, res, 'quote', 600))) return;
      const body = await getTickerQuote(req.params.slug);
      logTape({ endpoint: 'quote', jwt_sub: req.tape?.sub, slug: req.params.slug, cache: body._meta?.cached ? 'hit' : 'miss', stale: body._meta?.stale || false, status: 200, elapsed_ms: Date.now() - startedAt });
      return res.status(200).json(body);
    } catch (err) {
      if (err instanceof TapeHttpError) {
        logTape({ endpoint: 'quote', jwt_sub: req.tape?.sub, slug: req.params.slug, status: err.status, error: err.slug, elapsed_ms: Date.now() - startedAt });
        return tapeError(res, err.status, err.slug, err.title, err.detail, err.extra);
      }
      logTape({ endpoint: 'quote', jwt_sub: req.tape?.sub, status: 502, error: 'upstream', detail: err.message });
      return tapeError(res, 502, 'upstream-failure', 'Upstream failure', err.message);
    }
  });

  // Retrieval cache version — bump to evict stale entries when retrieval logic
  // changes (e.g. theme expansion, ticker filtering). v2 busts pre-expansion
  // empties like the poisoned "gold prognosis" result.
  const RV = 'v2';
  const hasCandidates = (body) => Array.isArray(body.candidates) && body.candidates.length > 0;

  // --- POST /person-quotes ---
  router.post('/person-quotes', withCachedEndpoint({
    endpoint: 'person-quotes',
    hourlyLimit: 120,
    tier: TIER.QUALITATIVE,
    ttlSec: () => qualTtlSec(),
    cacheKey: (req) => `tape:pq:${RV}:${hashBody(req.body)}`,
    idsOf: candidateIds,
    cacheable: hasCandidates,
    handler: async (req) => {
      const { body, underlying } = await personQuotes(req.body, { openai });
      return { body, fetchedAt: new Date().toISOString(), underlying };
    },
  }));

  // --- POST /topic-quotes ---
  router.post('/topic-quotes', withCachedEndpoint({
    endpoint: 'topic-quotes',
    hourlyLimit: 120,
    tier: TIER.QUALITATIVE,
    ttlSec: () => qualTtlSec(),
    cacheKey: (req) => `tape:tq:${RV}:${hashBody(req.body)}`,
    idsOf: candidateIds,
    cacheable: hasCandidates,
    handler: async (req) => {
      const { body, underlying } = await topicQuotes(req.body, { openai });
      return { body, fetchedAt: new Date().toISOString(), underlying };
    },
  }));

  // --- POST /synthesize (custom: streaming + cost guards) ---
  router.post('/synthesize', createSynthesizeHandler());

  // --- Kind-level endpoints (consolidated: retrieve→synthesize→parse→hydrate) ---
  // The client-facing surface going forward; the primitives above are internal.
  router.post('/dossier', withKindEndpoint({ kind: 'dossier', hourlyLimit: 30, openai, run: (body, ctx) => runDossier(body, { ...ctx, openai }) }));
  router.post('/brief', withKindEndpoint({ kind: 'brief', hourlyLimit: 30, openai, run: (body, ctx) => runBrief(body, { ...ctx, openai }) }));
  router.post('/split', withKindEndpoint({ kind: 'split', hourlyLimit: 30, openai, run: (body, ctx) => runSplit(body, { ...ctx, openai }) }));
  router.post('/narrative', withKindEndpoint({ kind: 'narrative', hourlyLimit: 30, openai, run: (body, ctx) => runNarrative(body, { ...ctx, openai }) }));
  router.post('/readin', withKindEndpoint({ kind: 'readin', hourlyLimit: 30, openai, run: (body, ctx) => runReadin(body, { ...ctx, openai }) }));

  return router;
}

module.exports = createTapeRoutes;
