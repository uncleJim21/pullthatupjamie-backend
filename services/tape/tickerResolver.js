/**
 * Ticker → name/alias resolver for Tape retrieval.
 *
 * People say or transcribe a company many ways: the ticker (CRWV), the formal
 * name (CoreWeave Inc), a spaced/camel split (Core Weave), or a nickname /
 * former name (Atlantic Crypto). This resolver produces the full set of
 * lowercase match strings for a ticker so retrieval filters (and, later, theme
 * expansion) can catch any of them.
 *
 * Sources, merged:
 *   1. Curated alias map below (nicknames / pronunciations not derivable from
 *      the formal name — the only thing that needs hand-maintenance).
 *   2. The live quote-proxy `name` (Yahoo/Finnhub) — best-effort, async.
 *   3. Auto-derived variants from whatever name we have (full, significant
 *      tokens, camelCase-split spaced form).
 *
 * Add a ticker to CURATED only when its nicknames can't be derived from the
 * name (e.g. "atlantic crypto" for CRWV). Everything else falls out for free.
 */

const { getTickerQuote } = require('./tickerQuote');
const { printLog } = require('../../constants');

// Hand-maintained nicknames / former names / common pronunciations.
// `name` is the canonical display name; `aliases` are extra match phrases.
const CURATED = {
  CRWV: { name: 'CoreWeave', aliases: ['core weave', 'atlantic crypto'] },
  ORCL: { name: 'Oracle', aliases: ['oracle cloud', 'oci'] },
  NVDA: { name: 'NVIDIA', aliases: ['invidia'] },
  GOOGL: { name: 'Alphabet', aliases: ['google'] },
  GOOG: { name: 'Alphabet', aliases: ['google'] },
  META: { name: 'Meta Platforms', aliases: ['facebook', 'instagram'] },
  TSLA: { name: 'Tesla', aliases: [] },
  BRKB: { name: 'Berkshire Hathaway', aliases: ['berkshire'] },
  'BRK.B': { name: 'Berkshire Hathaway', aliases: ['berkshire'] },
  AMD: { name: 'Advanced Micro Devices', aliases: ['a m d'] },
  PLTR: { name: 'Palantir', aliases: [] },
  HOOD: { name: 'Robinhood', aliases: [] },
  COIN: { name: 'Coinbase', aliases: [] },
  // Adtech / common short-word tickers that need curation precisely because the
  // ticker collides with an English word (APP, U) — bare-substring search is
  // useless for these, so the resolved name is what makes retrieval work.
  APP: { name: 'AppLovin', aliases: ['app lovin'] },
  TTD: { name: 'The Trade Desk', aliases: ['trade desk'] },
  U: { name: 'Unity Software', aliases: ['unity technologies'] },
  RBLX: { name: 'Roblox', aliases: [] },
};

const NAME_STOPWORDS = new Set([
  'inc', 'corp', 'corporation', 'co', 'company', 'group', 'holdings', 'ltd',
  'plc', 'the', 'sa', 'nv', 'ag', 'class', 'platforms', 'incorporated', 'and',
  // Generic industry/company-type words — distinctive enough to appear in many
  // off-topic clips, so they must NOT become match aliases (e.g. "Travere
  // Therapeutics" → "therapeutics" was matching 23andMe / COVID clips as TVTX).
  'therapeutics', 'therapeutic', 'pharmaceuticals', 'pharmaceutical', 'pharma',
  'biosciences', 'bioscience', 'biopharmaceutical', 'biopharmaceuticals', 'biotech',
  'sciences', 'science', 'technologies', 'technology', 'systems', 'solutions',
  'industries', 'international', 'communications', 'laboratories', 'energy',
  'financial', 'enterprises', 'resources', 'networks', 'semiconductor',
  'semiconductors', 'devices', 'partners', 'capital', 'global', 'micro',
]);

/** "CoreWeave" -> "core weave"; "NVIDIA" -> "nvidia" (no-op when no camel hump). */
function camelSplit(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

function significantTokens(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t));
}

/**
 * Build the alias set from a ticker + an optional name (curated or quote-proxy).
 * Pure (no I/O). Returns { name, aliases } where aliases is a deduped lowercase
 * array including the ticker, the full name, its spaced/token variants, and any
 * curated nicknames.
 */
function buildAliases(ticker, quoteName) {
  const tk = String(ticker || '').trim();
  const curated = CURATED[tk.toUpperCase()];
  const name = (curated && curated.name) || quoteName || tk;

  const set = new Set();
  const add = (s) => { const v = String(s || '').trim().toLowerCase(); if (v) set.add(v); };

  add(tk);                       // the ticker itself, e.g. "crwv"
  add(name);                     // full name, e.g. "coreweave"
  add(camelSplit(name));         // spaced camel form, e.g. "core weave"
  significantTokens(name).forEach(add);
  if (curated) curated.aliases.forEach(add);
  if (quoteName && quoteName !== name) {
    add(quoteName);
    add(camelSplit(quoteName));
    significantTokens(quoteName).forEach(add);
  }

  return { name, aliases: [...set] };
}

/**
 * Resolve a ticker to { ticker, name, aliases } using curated data + a
 * best-effort live name lookup via the quote proxy. Never throws.
 */
async function resolveTicker(ticker) {
  let quoteName = null;
  try {
    const q = await getTickerQuote(ticker);
    quoteName = q && q.name && q.name !== ticker ? q.name : null;
  } catch (_) { /* offline / unknown — fall back to curated/derived */ }
  const { name, aliases } = buildAliases(ticker, quoteName);
  printLog(`[tickerResolver] ${ticker} -> "${name}" aliases=[${aliases.join(', ')}]`);
  return { ticker: String(ticker || '').trim(), name, aliases };
}

module.exports = { resolveTicker, buildAliases, CURATED };
