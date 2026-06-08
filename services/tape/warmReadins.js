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

const { getWarmTickers } = require('./warmTickers');
const { computeAndCacheKind } = require('./tapeEndpoint');
const { runReadin } = require('./kindOrchestrator');
const { printLog } = require('../../constants');

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

const USD_CAP = num(process.env.TAPE_WARM_USD_CAP, 2);          // $ per warm run
const MAX_TICKERS = parseInt(process.env.TAPE_WARM_MAX_TICKERS || '150', 10);
const PER_TICKER = num(process.env.TAPE_WARM_COST_PER_TICKER, 0.0135); // Read-In all-in (Haiku synth + aux LLM), for the cap projection
const CONCURRENCY = Math.max(1, parseInt(process.env.TAPE_WARM_CONCURRENCY || '3', 10));
const IN_RATE = num(process.env.TAPE_WARM_IN_RATE, 1);   // $/1M input  (Haiku `fast`)
const OUT_RATE = num(process.env.TAPE_WARM_OUT_RATE, 5); // $/1M output

/** The number of tickers a run will warm: min(count cap, floor($ cap / per-ticker)). */
function effectiveLimit() {
  const byCost = PER_TICKER > 0 ? Math.floor(USD_CAP / PER_TICKER) : MAX_TICKERS;
  return Math.max(0, Math.min(MAX_TICKERS, byCost));
}

/**
 * @param {{ openai: object, log?: (m:string)=>void, limit?: number, only?: string[] }} opts
 * @returns {Promise<{warmed:number, empty:number, failed:number, synthUsd:number, inTok:number, outTok:number, elapsedSec:number, attempted:number}>}
 */
async function warmReadins({ openai, log = printLog, limit, only } = {}) {
  if (!openai) throw new Error('warmReadins requires an openai client');
  const all = Array.isArray(only) && only.length ? only.map(String) : getWarmTickers();
  const cap = Number.isFinite(limit) ? Math.max(0, limit) : effectiveLimit();
  const tickers = all.slice(0, cap);
  log(`[TapeWarm] warming ${tickers.length}/${all.length} read-ins (cap $${USD_CAP} / ${MAX_TICKERS} tickers @ ~$${PER_TICKER}/ea; concurrency ${CONCURRENCY})`);

  let warmed = 0; let empty = 0; let failed = 0; let inTok = 0; let outTok = 0;
  const startedAt = Date.now();

  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.map(async (ticker) => {
      const auditId = `warm-readin-${ticker}-${Date.now().toString(36)}`;
      try {
        const { out, synthesizedEmpty } = await computeAndCacheKind({
          kind: 'readin',
          body: { ticker },
          run: (b, ctx) => runReadin(b, { ...ctx, openai }),
          openai,
          refresh: true,
          jwtSub: 'warm',
          auditId,
        });
        const tok = out && out._meta && out._meta.tokens;
        if (tok) { inTok += tok.input || 0; outTok += tok.output || 0; }
        if (synthesizedEmpty) empty += 1; else warmed += 1;
      } catch (err) {
        failed += 1;
        log(`[TapeWarm] ${ticker} failed: ${err.message}`);
      }
    }));
  }

  const synthUsd = (inTok / 1e6) * IN_RATE + (outTok / 1e6) * OUT_RATE;
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  log(`[TapeWarm] done: ${warmed} warmed, ${empty} empty/fallback, ${failed} failed in ${elapsedSec}s; measured synth spend ~$${synthUsd.toFixed(3)} (${inTok} in / ${outTok} out tok; aux LLM not counted)`);
  return { warmed, empty, failed, synthUsd, inTok, outTok, elapsedSec, attempted: tickers.length };
}

module.exports = { warmReadins, effectiveLimit, getWarmTickers };
