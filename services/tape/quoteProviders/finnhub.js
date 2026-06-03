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
 *   it 403s. When it does, we DON'T degrade to a single point (which renders a
 *   blank sparkline on the client) — we synthesize a >= 2-point series from the
 *   /quote payload (prev close -> open -> current) so the shape matches Yahoo.
 */

const API = 'https://finnhub.io/api/v1';

// Company names don't change — cache resolved names by symbol for the process
// lifetime so we hit /stock/profile2 at most once per symbol, not once per cold
// quote-cache miss. Only positive hits are cached, so a transient profile2
// failure doesn't permanently pin name === symbol.
const nameCache = new Map();

const { isUsMarketOpen } = require('../tapeFreshness');

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

/**
 * Build a >= 2-point spark from the /quote payload alone (no extra request).
 * Finnhub's free-tier /quote returns pc (previous close), o (today's open) and
 * c (current). That's a chronologically ordered mini-series that reflects the
 * day's direction — enough for the sparkline to render and stay consistent with
 * dayChangePct. Guarantees length >= 2 whenever a price exists.
 */
function syntheticSpark(quote, price) {
  const raw = [quote && quote.pc, quote && quote.o, price].filter((v) => Number.isFinite(v));
  // Collapse consecutive duplicates so a flat day doesn't produce repeats,
  // but never drop below the two endpoints we need to draw a line.
  const series = raw.filter((v, i) => i === 0 || v !== raw[i - 1]);
  if (series.length >= 2) return series;
  if (Number.isFinite(price)) {
    if (Number.isFinite(quote && quote.pc) && quote.pc !== price) return [quote.pc, price];
    return [price, price]; // flat 2-point line — still renders, unlike a single point
  }
  return [];
}

async function fetchSpark(symbol, key, quote, price) {
  // Primary: daily candles for the last ~3 weeks → up to ~9 historical closes
  // with the live price appended as the final element (matches Yahoo, whose
  // last spark point is the live regularMarketPrice). Paid-plan endpoint.
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 21 * 86400;
    const data = await getJson(`${API}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${key}`);
    if (data && data.s === 'ok' && Array.isArray(data.c) && data.c.length) {
      const closes = data.c.filter((v) => v != null && Number.isFinite(v));
      const series = Number.isFinite(price) ? [...closes.slice(-9), price] : closes.slice(-10);
      if (series.length >= 2) return series;
    }
  } catch (_) { /* free-tier 403 / throttle — fall through to synthetic */ }
  // Fallback (free tier / candle unavailable): synthesize from the /quote
  // payload so spark always has >= 2 points and the sparkline never blanks.
  return syntheticSpark(quote, price);
}

async function fetchName(symbol, key) {
  if (nameCache.has(symbol)) return nameCache.get(symbol);
  try {
    const p = await getJson(`${API}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`);
    const name = p && p.name ? p.name : null;
    if (name) nameCache.set(symbol, name); // cache positive hits only
    return name;
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
    fetchSpark(symbol, key, q, price),
    fetchName(symbol, key),
  ]);

  return {
    symbol,
    name: name || symbol,
    price,
    currency: 'USD', // /quote does not return currency; assume USD
    dayChangePct,
    spark,
    // Finnhub /quote has no market-state field; fill best-effort from US market
    // hours so the type matches Yahoo's enum ('REGULAR' | 'CLOSED') instead of
    // null. Pre/post-market aren't distinguishable here, so we map to CLOSED.
    marketState: isUsMarketOpen() ? 'REGULAR' : 'CLOSED',
  };
}

module.exports = { name: 'finnhub', isConfigured, fetchQuote };
