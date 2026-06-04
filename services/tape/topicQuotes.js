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
const { expandThemes } = require('./themeExpander');
const { resolveHalfLife, rankByRecency, recencyMeta, defaultRelevance } = require('./recency');
const { hydrateCandidateDates } = require('./dateHydration');
const { printLog } = require('../../constants');

// Drop vector candidates below this absolute similarity so an uncovered topic
// returns an empty pool (honest confidence:'empty') instead of adjacent noise.
// Lexical/literal hits (null similarity) bypass. 0 = off; set after calibration.
const RELEVANCE_FLOOR = parseFloat(process.env.TAPE_RELEVANCE_FLOOR || '0');
// Soft boost for clips that literally mention a topic noun ("gold") — ranks them
// above merely-adjacent ones, without hard-filtering proxies (GLD, miners).
const LITERAL_BONUS = parseFloat(process.env.TAPE_LITERAL_BONUS || '0.12');
// Min literal-matching candidates for a non-ticker topic to be "covered"; below
// this the pool is emptied (honest confidence:'empty') rather than serving noise.
const LITERAL_MIN = parseInt(process.env.TAPE_LITERAL_MIN || '3', 10);
const TOPIC_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'vs', 'this',
  // topic framing words (not the subject)
  'prognosis', 'outlook', 'forecast', 'prediction', 'thoughts', 'take', 'week',
  'price', 'stock', 'market', 'markets', 'analysis', 'update', 'latest', 'news',
  // generic ranking/superlative words that match everything
  'best', 'worst', 'top', 'ranked', 'rankings', 'guide', 'review', 'championship',
]);
function topicTerms(topic) {
  return String(topic || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !TOPIC_STOPWORDS.has(t));
}
function containsAnyTerm(text, terms) {
  const t = String(text || '').toLowerCase();
  return terms.some((term) => t.includes(term));
}

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

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * For ticker-shaped queries (e.g. "APP"), drop candidates that don't actually
 * discuss the company. Matching rules avoid the ambiguous-ticker trap (a bare
 * lowercase "app" substring-matches "happen"/"apple"):
 *   - the bare ticker matches only as a real symbol — case-sensitive,
 *     word-bounded (catches "$APP", "NASDAQ: APP", "APP", but not "happen");
 *   - company name aliases (length ≥ 4, e.g. "applovin", "app lovin") match
 *     case-insensitively.
 * Never reduces a non-empty set to zero. `resolved` is reused if already fetched.
 */
async function filterTickerNoise(ticker, candidates, resolved) {
  if (!candidates.length) return candidates;
  const tk = ticker.trim();
  const r = resolved || await resolveTicker(ticker);
  const tickerRe = new RegExp(`(^|[^A-Za-z])${escapeRegex(tk)}([^A-Za-z]|$)`); // case-sensitive
  const nameAliases = r.aliases.filter((a) => a !== tk.toLowerCase() && a.length >= 4);
  const matches = (c) => {
    const text = c.text || '';
    if (tickerRe.test(text)) return true;
    const lower = text.toLowerCase();
    return nameAliases.some((a) => lower.includes(a));
  };
  const kept = candidates.filter(matches);
  if (!kept.length) {
    printLog(`[topicQuotes] ticker "${tk}" filter matched 0/${candidates.length}; keeping unfiltered set`);
    return candidates;
  }
  if (kept.length < candidates.length) {
    printLog(`[topicQuotes] ticker "${tk}" filter kept ${kept.length}/${candidates.length} (name="${r.name}")`);
  }
  return kept;
}

const DAY_MS = 86_400_000;
const BRIEF_WINDOW_STEPS = [7, 30, 90]; // days; widen until >= MIN_BRIEF_CANDIDATES
const MIN_BRIEF_CANDIDATES = 3;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Brief auto-expanding window: pick the SMALLEST step whose dated candidates
 * within [asOf - step, asOf] reach MIN_BRIEF_CANDIDATES; else the widest step.
 * Keeps undated candidates (recency-penalized later). Returns the chosen window
 * and the filtered set.
 */
function selectBriefWindow(candidates, asOfMs, steps = BRIEF_WINDOW_STEPS) {
  const datedWithin = (days) => candidates.filter((c) => {
    if (!c.publishedDate) return false;
    const t = new Date(c.publishedDate).getTime();
    return Number.isFinite(t) && t >= asOfMs - days * DAY_MS && t <= asOfMs;
  }).length;
  let chosen = steps[steps.length - 1];
  for (const d of steps) { if (datedWithin(d) >= MIN_BRIEF_CANDIDATES) { chosen = d; break; } }
  const kept = candidates.filter((c) => {
    if (!c.publishedDate) return true;
    const t = new Date(c.publishedDate).getTime();
    return !Number.isFinite(t) || (t >= asOfMs - chosen * DAY_MS && t <= asOfMs);
  });
  return { windowDays: chosen, windowExpanded: chosen > steps[0], kept };
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

  // Brief auto-expanding window: search the WIDEST step up front, then pick the
  // narrowest window that clears the candidate floor (post-fetch, in-memory, so
  // it's one fan-out, not three). Only when kind=brief and the caller didn't pin
  // an explicit minDate. The asOf (window end) stays fixed; only lookback grows.
  const autoExpand = input.kind === 'brief' && !f.minDate;
  const asOfMs = autoExpand
    ? new Date(input.asOfDate || f.maxDate || Date.now()).getTime()
    : null;
  const searchMinDate = autoExpand ? isoDay(asOfMs - BRIEF_WINDOW_STEPS[BRIEF_WINDOW_STEPS.length - 1] * DAY_MS) : minDate;
  const searchMaxDate = autoExpand ? isoDay(asOfMs) : maxDate;

  const seedThemes = Array.isArray(input.themes) && input.themes.length
    ? input.themes.filter((t) => typeof t === 'string' && t.trim())
    : [];
  const topic = (typeof input.query === 'string' && input.query.trim())
    ? input.query.trim()
    : (seedThemes[0] || '');
  if (!seedThemes.length && !topic) {
    throw new TapeHttpError(400, 'bad-request', 'Bad request', 'query or themes is required');
  }

  const groupBy = input.groupBy === 'creator' || input.groupBy === 'bull-bear' ? input.groupBy : null;

  const underlying = { searchQuotes: 0, helperTokens: 0 };
  const recordHelperLlmUsage = (_m, i = 0, o = 0) => { underlying.helperTokens += (i || 0) + (o || 0); };

  // Ticker-shaped query → resolve to the company and search the NAME, not the
  // literal ticker. Critical for ambiguous tickers like APP ("app"), U
  // ("unity") where a bare-string search retrieves noise/nothing.
  let resolved = null;
  let searchTopic = topic;
  if (isTickerShaped(topic)) {
    resolved = await resolveTicker(topic);
    if (resolved.name && resolved.name.toLowerCase() !== topic.toLowerCase()) {
      searchTopic = resolved.name; // e.g. "APP" -> "AppLovin"
    }
  }

  // Expand the (resolved) topic into podcast-realistic phrasings before fanning
  // out, so a user phrasing nobody says ("gold prognosis") or a bare ticker
  // ("APP") still retrieves. Caller themes are kept verbatim and ranked first.
  const expand = input.expandThemes !== false;
  const themes = expand
    ? await expandThemes({ topic: searchTopic, seedThemes, deps: { openai, recordHelperLlmUsage } })
    : (seedThemes.length ? seedThemes : [searchTopic]).filter(Boolean);
  underlying.themes = themes.length;

  // Fan out across themes.
  const tasks = themes.map((theme) =>
    searchQuotes(
      { query: theme, feedIds, minDate: searchMinDate, maxDate: searchMaxDate, limit: f.perThemeLimit },
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
  let candidates = [...byId.values()];

  // Ticker-shaped query → drop company-mismatch noise before ranking/capping (§4).
  if (TICKER_FILTER_ENABLED && isTickerShaped(topic)) {
    candidates = await filterTickerNoise(topic, candidates, resolved);
  }

  // Lazy-fill missing candidate dates from the parent episode before window
  // selection + ranking, so both see real dates instead of the undated penalty.
  const dates = await hydrateCandidateDates(candidates);

  // Brief: narrow to the chosen auto-expand window.
  let windowDays = null;
  let windowExpanded = false;
  if (autoExpand) {
    const sel = selectBriefWindow(candidates, asOfMs);
    candidates = sel.kept;
    windowDays = sel.windowDays;
    windowExpanded = sel.windowExpanded;
  }

  // Relevance floor: an uncovered topic should yield an empty pool, not noise.
  if (RELEVANCE_FLOOR > 0) {
    const before = candidates.length;
    candidates = candidates.filter((c) => !Number.isFinite(c.similarity) || c.similarity >= RELEVANCE_FLOOR);
    if (candidates.length < before) printLog(`[topicQuotes] relevance floor ${RELEVANCE_FLOOR} dropped ${before - candidates.length}/${before} for "${topic}"`);
  }

  // Literal-term anchoring (the real precision lever — ada-002 similarity is too
  // compressed to separate covered from uncovered topics). For a non-ticker query
  // with clear nouns, keep only clips that actually mention a topic term; if too
  // few clear it, the corpus doesn't cover the topic → empty pool (honest
  // confidence:'empty'). Ticker queries are skipped (the resolver/ticker filter
  // already anchored them on the company name, which won't equal the raw ticker).
  const terms = isTickerShaped(topic) ? [] : topicTerms(topic);
  if (terms.length && candidates.length) {
    const literal = candidates.filter((c) => containsAnyTerm(c.text, terms));
    if (literal.length >= LITERAL_MIN) {
      if (literal.length < candidates.length) printLog(`[topicQuotes] literal-anchor "${topic}" kept ${literal.length}/${candidates.length}`);
      candidates = literal;
    } else {
      printLog(`[topicQuotes] "${topic}" — only ${literal.length} literal matches (<${LITERAL_MIN}); treating as uncovered (empty pool)`);
      candidates = [];
    }
  }

  // Rank by relevance × recency, span as tiebreaker. (All survivors contain a term
  // after anchoring; the boost only matters for the no-term / ticker fallback.)
  const baseScore = terms.length
    ? (c) => defaultRelevance(c) + (containsAnyTerm(c.text, terms) ? LITERAL_BONUS : 0)
    : defaultRelevance;

  // Half-life from the requested kind (brief ~1wk, readin/split 6mo) unless the
  // caller overrides; Arc-style callers pass disableRecencyWeighting. When a Brief
  // auto-expands, COUPLE the half-life to the effective window (~windowDays) —
  // otherwise the 1-week half-life would decay the widened candidates right back out.
  const halfLifeOverride = Number.isFinite(f.halfLifeMonths)
    ? f.halfLifeMonths
    : (autoExpand ? windowDays / 30.44 : undefined);
  const recency = resolveHalfLife({
    kind: input.kind,
    halfLifeMonths: halfLifeOverride,
    disableRecencyWeighting: f.disableRecencyWeighting,
  });
  candidates = rankByRecency(candidates, recency, baseScore).slice(0, f.candidatesLimit);

  // Optional bull/bear tagging on each candidate.
  if (groupBy === 'bull-bear') {
    candidates = candidates.map((c) => ({ ...c, side: taste.classifyBullBear(c.text) }));
  }

  const body = {
    query: input.query || themes[0],
    candidates,
    _meta: {
      underlying, ...recencyMeta(recency), datesHydrated: dates.hydrated,
      ...(autoExpand ? { windowDays, windowExpanded } : {}),
    },
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
