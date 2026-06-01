/**
 * Finnhub quote provider — drop-in alternative / fallback to Yahoo.
 *
 * Activates only when FINNHUB_API_KEY is set. Emits the SAME normalized quote
 * shape as the Yahoo provider so the rest of the Tape stack is provider-blind:
 *   { symbol, name, price, currency, dayChangePct, spark[], marketState }
 *
 * Notes / caveats:
 * - Symbol formats differ from Yahoo. Equity tickers (AAPL, APP) match across
 *   both; indices/futures (^TNX, CL=F, DX-Y.NYB) use Yahoo-specific slugs and
 *   would need a mapping table to resolve on Finnhub. `FINNHUB_SYMBOL_MAP`
 *   (JSON env) lets you translate per slug, e.g. {"^TNX":"...","CL=F":"..."}.
 * - The candle (sparkline) endpoint requires a paid Finnhub plan; on free tier
 *   it 403s. We degrade gracefully to a single-point spark rather than failing.
 */

const API = 'https://finnhub.io/api/v1';

function apiKey() { return process.env.FINNHUB_API_KEY || ''; }
function isConfigured() { return !!apiKey(); }

function symbolMap() {
  try { return JSON.parse(process.env.FINNHUB_SYMBOL_MAP || '{}'); } catch (_) { return {}; }
}

async function getJson(url) {
  if (typeof fetch !== 'function') throw new Error('global fetch unavailable (Node 18+ required)');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (resp.status === 429) { const e = new Error('finnhub rate limited'); e.code = 429; throw e; }
    if (!resp.ok) { const e = new Error(`finnhub ${resp.status}`); e.code = resp.status; throw e; }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSpark(symbol, key, fallbackPrice) {
  // Daily candles for the last ~2 weeks → up to 10 closes. Paid-plan endpoint;
  // degrade to a single point on any failure.
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 21 * 86400;
    const data = await getJson(`${API}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${key}`);
    if (data && data.s === 'ok' && Array.isArray(data.c) && data.c.length) {
      return data.c.filter((v) => v != null && Number.isFinite(v)).slice(-10);
    }
  } catch (_) { /* free-tier 403 / throttle — fall through */ }
  return Number.isFinite(fallbackPrice) ? [fallbackPrice] : [];
}

async function fetchName(symbol, key) {
  try {
    const p = await getJson(`${API}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`);
    return p && p.name ? p.name : null;
  } catch (_) { return null; }
}

async function fetchQuote(slug) {
  const key = apiKey();
  if (!key) { const e = new Error('finnhub not configured'); e.code = 401; throw e; }
  const symbol = symbolMap()[slug] || slug;

  const q = await getJson(`${API}/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`);
  // Finnhub returns all-zeros for unknown symbols.
  if (!q || (q.c === 0 && q.pc === 0 && q.h === 0 && q.l === 0)) {
    const e = new Error('no result'); e.code = 404; throw e;
  }

  const price = Number.isFinite(q.c) ? q.c : null;
  const dayChangePct = Number.isFinite(q.dp) ? parseFloat(q.dp.toFixed(2)) : null;
  const [spark, name] = await Promise.all([
    fetchSpark(symbol, key, price),
    fetchName(symbol, key),
  ]);

  return {
    symbol,
    name: name || symbol,
    price,
    currency: 'USD', // /quote does not return currency; assume USD
    dayChangePct,
    spark,
    marketState: null,
  };
}

module.exports = { name: 'finnhub', isConfigured, fetchQuote };
