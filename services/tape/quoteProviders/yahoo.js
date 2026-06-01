/**
 * Yahoo Finance quote provider.
 *
 * Implements the provider interface:
 *   name           -> 'yahoo'
 *   isConfigured() -> boolean (always true; no key needed)
 *   fetchQuote(slug) -> normalized quote | throws Error with `.code`
 *
 * Normalized quote shape (provider-agnostic):
 *   { symbol, name, price, currency, dayChangePct, spark[], marketState }
 *
 * dayChangePct is computed from the last two valid daily closes — NOT
 * meta.chartPreviousClose, which is the close *before* the requested range.
 */

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchQuote(slug) {
  if (typeof fetch !== 'function') throw new Error('global fetch unavailable (Node 18+ required)');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(slug)}?range=1mo&interval=1d`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let json;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (resp.status === 429) { const e = new Error('yahoo rate limited'); e.code = 429; throw e; }
    if (!resp.ok) { const e = new Error(`yahoo ${resp.status}`); e.code = resp.status; throw e; }
    json = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  const result = json?.chart?.result?.[0];
  if (!result) { const e = new Error('no result'); e.code = 404; throw e; }
  const meta = result.meta || {};
  const closes = (result.indicators?.quote?.[0]?.close || []).filter((v) => v != null && Number.isFinite(v));
  const price = Number.isFinite(meta.regularMarketPrice)
    ? meta.regularMarketPrice
    : (closes.length ? closes[closes.length - 1] : null);

  let dayChangePct = null;
  if (closes.length >= 2 && closes[closes.length - 2]) {
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    dayChangePct = parseFloat((((last - prev) / prev) * 100).toFixed(2));
  }

  return {
    symbol: meta.symbol || slug,
    name: meta.shortName || meta.longName || meta.symbol || slug,
    price,
    currency: meta.currency || 'USD',
    dayChangePct,
    spark: closes.slice(-10),
    marketState: meta.marketState || null,
  };
}

module.exports = { name: 'yahoo', isConfigured: () => true, fetchQuote };
