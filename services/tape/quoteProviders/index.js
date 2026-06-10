/**
 * Quote provider registry + fallback chain.
 *
 * Selection via TAPE_QUOTE_PROVIDER:
 *   'yahoo'   (default) -> Yahoo primary; Finnhub fallback if configured
 *   'finnhub'           -> Finnhub primary (if configured); Yahoo fallback
 *   'auto'              -> same as 'yahoo'
 *
 * A provider that throws is skipped and the next is tried. Only when *every*
 * provider reports "no result" (404) do we surface 404; otherwise the last
 * transport error (e.g. 429) propagates so the caller can serve a stale price.
 *
 * Adding another provider later = drop a module exporting
 * { name, isConfigured(), fetchQuote(slug) } and register it here.
 */

const yahoo = require('./yahoo');
const finnhub = require('./finnhub');
const { printLog } = require('../../../constants');

function orderedProviders() {
  const pref = (process.env.TAPE_QUOTE_PROVIDER || 'yahoo').toLowerCase();
  const chain = [];
  if (pref === 'finnhub') {
    if (finnhub.isConfigured()) chain.push(finnhub);
    chain.push(yahoo);
  } else {
    chain.push(yahoo);
    if (finnhub.isConfigured()) chain.push(finnhub);
  }
  return chain;
}

/**
 * Try each active provider in order. Returns { quote, source }.
 * Throws an Error with `.code` (404 only if all providers agree there's no
 * result; otherwise the last transport error).
 */
async function fetchQuoteWithFallback(slug) {
  const chain = orderedProviders();
  let lastErr = null;
  let notFound = 0;
  for (const p of chain) {
    try {
      const quote = await p.fetchQuote(slug);
      return { quote, source: p.name };
    } catch (err) {
      if (err.code === 404) notFound += 1;
      else printLog(`[quoteProviders] ${p.name} failed for ${slug}: ${err.message} (code=${err.code || '?'})`);
      lastErr = err;
    }
  }
  if (notFound === chain.length) { const e = new Error('no result'); e.code = 404; throw e; }
  throw lastErr || new Error('all quote providers failed');
}

module.exports = { fetchQuoteWithFallback, orderedProviders };
