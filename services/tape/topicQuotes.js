/**
 * topic-quotes recipe (spec §3) — "best quotes ABOUT this topic".
 *
 * Powers Brief, Split (camp side), and Read-in's quote layer. Fans out
 * search-quotes across theme phrasings, dedups, applies the mainstream
 * allowlist, and optionally groups by creator or bull/bear camp.
 */

const { searchQuotes } = require('../searchQuotesService');
const taste = require('./tapeTaste');
const { TapeHttpError } = require('./tapeErrors');
const { candidateFromResult, validateDate } = require('./tapeShared');
const { resolveTicker } = require('./tickerResolver');
const { printLog } = require('../../constants');

const DEFAULTS = {
  mainstream: true,
  minSpan: 10,
  candidatesLimit: 25,
  perThemeLimit: 12,
};

const TICKER_FILTER_ENABLED = process.env.TAPE_TICKER_FILTER !== 'false';

function isTickerShaped(q) {
  return typeof q === 'string' && /^[A-Z]{1,5}$/.test(q.trim());
}

/**
 * For ticker-shaped queries (e.g. "CRWV"), drop candidates that don't actually
 * mention the ticker or any resolved name/alias of the company — guards against
 * vector-noise (Crimson Wine "CWGL", leveraged ETFs, similar-letter tickers).
 * Uses the ticker resolver so nicknames / spaced forms ("Core Weave") match too.
 * Never reduces a non-empty set to zero (keeps the original if nothing matches).
 */
async function filterTickerNoise(ticker, candidates) {
  if (!candidates.length) return candidates;
  const { aliases } = await resolveTicker(ticker);
  const matches = (c) => {
    const t = (c.text || '').toLowerCase();
    return aliases.some((a) => t.includes(a));
  };
  const kept = candidates.filter(matches);
  if (!kept.length) {
    printLog(`[topicQuotes] ticker "${ticker}" filter matched 0/${candidates.length}; keeping unfiltered set`);
    return candidates;
  }
  if (kept.length < candidates.length) {
    printLog(`[topicQuotes] ticker "${ticker}" filter kept ${kept.length}/${candidates.length} (aliases=[${aliases.join(', ')}])`);
  }
  return kept;
}

/**
 * @param {object} input
 * @param {object} deps  { openai }
 * @returns {Promise<{body:object, underlying:object}>}
 */
async function topicQuotes(input = {}, { openai } = {}) {
  const f = { ...DEFAULTS, ...(input.filters || {}) };
  const minDate = validateDate(f.minDate, 'minDate');
  const maxDate = validateDate(f.maxDate, 'maxDate');
  const feedIds = Array.isArray(f.feedIds) ? f.feedIds.filter(Boolean) : [];

  const themes = Array.isArray(input.themes) && input.themes.length
    ? input.themes.filter((t) => typeof t === 'string' && t.trim())
    : (typeof input.query === 'string' && input.query.trim() ? [input.query.trim()] : []);
  if (!themes.length) {
    throw new TapeHttpError(400, 'bad-request', 'Bad request', 'query or themes is required');
  }

  const groupBy = input.groupBy === 'creator' || input.groupBy === 'bull-bear' ? input.groupBy : null;

  const underlying = { searchQuotes: 0, helperTokens: 0 };
  const recordHelperLlmUsage = (_m, i = 0, o = 0) => { underlying.helperTokens += (i || 0) + (o || 0); };

  // Fan out across themes.
  const tasks = themes.map((theme) =>
    searchQuotes(
      { query: theme, feedIds, minDate, maxDate, limit: f.perThemeLimit },
      { openai, recordHelperLlmUsage },
    ).then((r) => r.results || []),
  );
  const settled = await Promise.all(tasks);
  underlying.searchQuotes = tasks.length;

  // Dedup, minSpan filter, mainstream allowlist.
  const byId = new Map();
  for (const results of settled) {
    for (const r of results) {
      const cand = candidateFromResult(r);
      if (!cand || !cand.pineconeId || byId.has(cand.pineconeId)) continue;
      if (Number.isFinite(f.minSpan) && cand.spanSec != null && cand.spanSec < f.minSpan) continue;
      if (f.mainstream && !taste.isMainstream(cand.creator)) continue;
      byId.set(cand.pineconeId, cand);
    }
  }
  let candidates = [...byId.values()].sort((a, b) => (b.spanSec || 0) - (a.spanSec || 0));

  // Ticker-shaped query → drop company-mismatch noise before capping (§4).
  if (TICKER_FILTER_ENABLED && isTickerShaped(input.query)) {
    candidates = await filterTickerNoise(input.query, candidates);
  }
  candidates = candidates.slice(0, f.candidatesLimit);

  // Optional bull/bear tagging on each candidate.
  if (groupBy === 'bull-bear') {
    candidates = candidates.map((c) => ({ ...c, side: taste.classifyBullBear(c.text) }));
  }

  const body = {
    query: input.query || themes[0],
    candidates,
    _meta: { underlying },
  };

  // Grouping.
  if (groupBy === 'creator') {
    const groups = new Map();
    for (const c of candidates) {
      const key = c.creator || 'Unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    body.groups = [...groups.entries()].map(([key, cands]) => ({ key, candidates: cands }));
  } else if (groupBy === 'bull-bear') {
    const groups = { bull: [], bear: [], neutral: [] };
    for (const c of candidates) groups[c.side].push(c);
    body.groups = Object.entries(groups).map(([key, cands]) => ({ key, candidates: cands }));
  }

  return { body, underlying };
}

module.exports = { topicQuotes, DEFAULTS };
