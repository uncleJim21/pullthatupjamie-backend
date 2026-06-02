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
const { withCachedEndpoint, checkRateLimit, logTape } = require('../services/tape/tapeEndpoint');
const { TIER, qualTtlSec } = require('../services/tape/tapeFreshness');
const { hashBody, candidateIds } = require('../services/tape/tapeShared');
const { TapeHttpError } = require('../services/tape/tapeErrors');
const { getTickerQuote } = require('../services/tape/tickerQuote');
const { personQuotes } = require('../services/tape/personQuotes');
const { topicQuotes } = require('../services/tape/topicQuotes');
const { createSynthesizeHandler } = require('../services/tape/synthesize');

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

  return router;
}

module.exports = createTapeRoutes;
