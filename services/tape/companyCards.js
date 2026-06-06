/**
 * Company-card loader — per-ticker reference facts that ground Read-in synthesis,
 * disambiguate retrieval (the CEG = Constellation Energy vs Software problem), and
 * seed search with real products / executive names.
 *
 * Backbone fields (name, industry, marketCap, weburl) come from Finnhub profile2
 * (reliable); description / products / execs are LLM-drafted (best-effort — well-
 * known for large caps, may be stale for the long tail). Built by
 * scripts/build-company-cards.js → config/tape-company-cards.yaml.
 *
 * Loaded once, lazily reloaded on file mtime change (same pattern as tapeTaste).
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { printLog } = require('../../constants');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'tape-company-cards.yaml');

let cached = null;
let cachedMtimeMs = -1;

function load() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(CONFIG_PATH).mtimeMs; } catch (_) { /* missing file → empty */ }
  if (cached && mtimeMs === cachedMtimeMs) return cached;
  try {
    const parsed = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
    // Normalize keys to uppercase tickers.
    const byTicker = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v === 'object') byTicker[String(k).toUpperCase()] = v;
    }
    cached = byTicker;
    cachedMtimeMs = mtimeMs;
    printLog(`[companyCards] loaded ${Object.keys(cached).length} cards`);
  } catch (err) {
    if (!cached) { cached = {}; printLog(`[companyCards] no cards loaded: ${err.message}`); }
  }
  return cached;
}

/** Card for a ticker, or null. */
function getCard(ticker) {
  if (!ticker) return null;
  return load()[String(ticker).trim().toUpperCase()] || null;
}

/**
 * Compact grounding block for the synthesis prompt — authoritative facts the
 * writer should lean on instead of inferring from sparse clips. Returns '' when
 * no card. Kept short (the clips are the evidence; this is just identity).
 */
function cardContext(ticker) {
  const c = getCard(ticker);
  if (!c) return '';
  const bits = [];
  if (c.name) bits.push(`${c.name}${c.industry ? ` (${c.industry})` : ''}`);
  if (c.description) bits.push(c.description);
  if (Array.isArray(c.products) && c.products.length) bits.push(`Key products/segments: ${c.products.join(', ')}.`);
  if (Array.isArray(c.execs) && c.execs.length) bits.push(`Key people: ${c.execs.join(', ')}.`);
  return bits.join(' ');
}

/**
 * Extra retrieval anchors from the card — products + execs + industry — as lower-
 * cased match phrases. Used to (a) seed search and (b) disambiguate the ticker
 * filter (a clip mentioning the company name token but NONE of these is more
 * likely the wrong same-named entity).
 */
function cardAnchors(ticker) {
  const c = getCard(ticker);
  if (!c) return { products: [], execs: [], industry: null };
  const lc = (a) => (Array.isArray(a) ? a.map((s) => String(s).toLowerCase()).filter(Boolean) : []);
  return { products: lc(c.products), execs: lc(c.execs), industry: c.industry ? String(c.industry).toLowerCase() : null };
}

/**
 * Ultra-condensed identity for the reranker — just enough to recognize and DROP
 * a wrong-same-named entity (CEG = Constellation Energy, not Software). Kept tiny
 * to protect the reranker's token budget. Returns '' when no card.
 */
function cardRerankHint(ticker) {
  const c = getCard(ticker);
  if (!c) return '';
  const desc = c.description ? String(c.description).slice(0, 140) : '';
  const execs = Array.isArray(c.execs) && c.execs.length ? ` Execs: ${c.execs.slice(0, 2).join(', ')}.` : '';
  return `${c.name || ticker}${c.industry ? ` — ${c.industry}.` : '.'} ${desc}${execs}`.trim();
}

/**
 * Same-industry peers for a ticker, biggest first (more likely to have corpus
 * coverage) — powers the Read-in industry fallback ("no coverage of X, here's
 * related <industry> / competitors"). Returns [{ ticker, name, marketCap }].
 */
function peersByIndustry(ticker, limit = 5) {
  const cards = load();
  const key = String(ticker || '').toUpperCase();
  const me = cards[key];
  if (!me || !me.industry) return [];
  return Object.entries(cards)
    .filter(([tk, c]) => tk !== key && c && c.industry === me.industry && c.name)
    .map(([tk, c]) => ({ ticker: tk, name: c.name, marketCap: c.marketCap || 0 }))
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, limit);
}

module.exports = { getCard, cardContext, cardAnchors, cardRerankHint, peersByIndustry, load, CONFIG_PATH };
