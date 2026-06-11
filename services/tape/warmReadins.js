/**
 * Daily Read-In cache warmer (in-process).
 *
 * Walks getWarmTickers() in most-likely-picked order and pre-computes each Read-In
 * via the SAME computeAndCacheKind() the live request path uses, so a warmed entry
 * is byte-identical to what a user request would write — the frontend reads its own
 * cache hit. Warms with refresh:true so it recomputes against new episodes each run.
 *
 * IMPORTANT — runs IN the server process. With no Redis the cache is a per-process
 * Map, so a warmer in a separate process would fill a throwaway cache and exit. The
 * cron therefore calls warmReadins() in-process (not a spawned child). Under
 * autoscale each container warms its OWN cache (so we deliberately do NOT take a
 * distributed lock here — every container must warm itself; cost scales with
 * container count).
 *
 * Budget is bounded by both a $ ceiling and a ticker count; the effective limit is
 * the smaller of the two. Cost is projected from a per-ticker estimate (predictable
 * cap) and the actual synth token spend is measured and logged after the run.
 */

const { getWarmTickers, getPersonaUnionTickers } = require('./warmTickers');
const { computeAndCacheKind, kindCacheKey } = require('./tapeEndpoint');
const { getCached } = require('./tapeStore');
const { runReadin } = require('./kindOrchestrator');
const { printLog } = require('../../constants');

// Lazily build a shared OpenAI client so callers without one (persona-save warm,
// CLI) can use the warmer; the server passes its own client through.
let _openai;
function defaultOpenai() {
  if (!_openai) { const OpenAI = require('openai'); _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); }
  return _openai;
}

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

const USD_CAP = num(process.env.TAPE_WARM_USD_CAP, 2);          // $ per warm run
const MAX_TICKERS = parseInt(process.env.TAPE_WARM_MAX_TICKERS || '150', 10);
const PER_TICKER = num(process.env.TAPE_WARM_COST_PER_TICKER, 0.0135); // Read-In all-in (Haiku synth + aux LLM), for the cap projection
const CONCURRENCY = Math.max(1, parseInt(process.env.TAPE_WARM_CONCURRENCY || '3', 10));
const IN_RATE = num(process.env.TAPE_WARM_IN_RATE, 1);   // $/1M input  (Haiku `fast`)
const OUT_RATE = num(process.env.TAPE_WARM_OUT_RATE, 5); // $/1M output

// The read-in cache key is ticker-only (see kindCacheKey), so the warmer doesn't
// need to match the frontend's `model` — it warms with the cheap default model
// (TAPE_READIN_MODEL, `fast`) by sending only the ticker, and every live read-in
// request for that ticker (any model) hits this one entry. Cost over fidelity.
function readinBody(ticker) {
  return { ticker };
}

/** The number of tickers a run will warm: min(count cap, floor($ cap / per-ticker)). */
function effectiveLimit() {
  const byCost = PER_TICKER > 0 ? Math.floor(USD_CAP / PER_TICKER) : MAX_TICKERS;
  return Math.max(0, Math.min(MAX_TICKERS, byCost));
}

/**
 * @param {object} opts
 * @param {object}  [opts.openai]  OpenAI client (defaults to a lazily-built shared one)
 * @param {number}  [opts.limit]   ticker cap (default = effectiveLimit())
 * @param {string[]}[opts.only]    warm exactly these tickers (skips union/generic)
 * @param {boolean} [opts.refresh=true] re-synth even if already cached. false = skip
 *                  tickers already warm (used by on-save so repeated saves are cheap)
 * @param {boolean} [opts.includePersonaUnion=true] prepend all persona-users' tickers
 *                  (ignored when `only` is given)
 * @param {string}  [opts.reason]  label for the log line
 */
async function warmReadins({ openai, log = printLog, limit, only, refresh = true, includePersonaUnion = true, reason = 'warm' } = {}) {
  const oa = openai || defaultOpenai();
  let all;
  if (Array.isArray(only) && only.length) {
    all = only.map(String);
  } else {
    const union = includePersonaUnion ? await getPersonaUnionTickers() : [];
    all = [...new Set([...union, ...getWarmTickers()])]; // persona interests first, then generic
  }
  const cap = Number.isFinite(limit) ? Math.max(0, limit) : effectiveLimit();
  const tickers = all.slice(0, cap);
  log(`[TapeWarm:${reason}] warming up to ${tickers.length}/${all.length} read-ins (cap $${USD_CAP} / ${MAX_TICKERS} @ ~$${PER_TICKER}/ea; concurrency ${CONCURRENCY}; refresh=${refresh})`);

  let warmed = 0; let empty = 0; let failed = 0; let skipped = 0; let inTok = 0; let outTok = 0;
  const startedAt = Date.now();

  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.map(async (ticker) => {
      const body = readinBody(ticker);
      try {
        // On-save path (refresh=false): skip tickers whose shared entry already exists.
        if (!refresh && await getCached(kindCacheKey('readin', body))) { skipped += 1; return; }
        const auditId = `warm-readin-${ticker}-${Date.now().toString(36)}`;
        const { out, synthesizedEmpty } = await computeAndCacheKind({
          kind: 'readin',
          body,
          run: (b, ctx) => runReadin(b, { ...ctx, openai: oa }),
          openai: oa,
          refresh: true,
          jwtSub: 'warm',
          auditId,
        });
        const tok = out && out._meta && out._meta.tokens;
        if (tok) { inTok += tok.input || 0; outTok += tok.output || 0; }
        if (synthesizedEmpty) empty += 1; else warmed += 1;
      } catch (err) {
        failed += 1;
        log(`[TapeWarm:${reason}] ${ticker} failed: ${err.message}`);
      }
    }));
  }

  const synthUsd = (inTok / 1e6) * IN_RATE + (outTok / 1e6) * OUT_RATE;
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  log(`[TapeWarm:${reason}] done: ${warmed} warmed, ${skipped} already-warm, ${empty} empty/fallback, ${failed} failed in ${elapsedSec}s; measured synth spend ~$${synthUsd.toFixed(3)} (${inTok} in / ${outTok} out tok; aux LLM not counted)`);
  return { warmed, skipped, empty, failed, synthUsd, inTok, outTok, elapsedSec, attempted: tickers.length };
}

module.exports = { warmReadins, effectiveLimit, getWarmTickers };
