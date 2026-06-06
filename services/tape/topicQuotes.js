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
const { cardRerankHint } = require('./companyCards');
const { expandThemes } = require('./themeExpander');
const { resolveHalfLife, rankByRecency, recencyMeta, defaultRelevance } = require('./recency');
const { hydrateCandidateDates } = require('./dateHydration');
const { getMainstreamFeedIds } = require('./mainstreamFeeds');
const { rerankClips } = require('../../utils/clipReranker'); // reuse the pull path's quality reranker
const { printLog } = require('../../constants');

const RERANK_ENABLED = process.env.TAPE_RERANK !== 'false';
const RERANK_MAX = parseInt(process.env.TAPE_RERANK_MAX || '25', 10); // cap rerank input (scorer token budget)

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
// Drop pure fragments (too short to be a real quote) before ranking/synthesis.
const MIN_WORDS = parseInt(process.env.TAPE_MIN_WORDS || '6', 10);
// Source-diversity cap: at most N candidates per creator in the final set, so a
// single dense show/episode can't dominate (eval: source_diversity 2.2/5,
// single-publisher Briefs). Overflow is appended after, so the pool never shrinks.
const PER_CREATOR_MAX = parseInt(process.env.TAPE_PER_CREATOR_MAX || '3', 10);
function capPerCreator(list, max) {
  if (!(max > 0)) return list;
  const counts = new Map();
  const kept = [];
  const overflow = [];
  for (const c of list) {
    const k = (c.creator || 'unknown').toLowerCase();
    const n = counts.get(k) || 0;
    if (n < max) { counts.set(k, n + 1); kept.push(c); } else overflow.push(c);
  }
  return kept.concat(overflow); // diverse-first, then the rest (so slice keeps count)
}
// Spoken-vs-typed aliases: macro hosts say "BTC" as often as "bitcoin", "eth"
// for ethereum, "bullion" for gold. Without these the literal anchor rejects a
// "BTC"-only quote on a "bitcoin" query (and vice-versa). Bidirectional.
const TERM_ALIASES = {
  bitcoin: ['btc'], btc: ['bitcoin'],
  ethereum: ['eth'], eth: ['ethereum'],
  gold: ['bullion'], oil: ['crude', 'wti'],
  dollar: ['greenback', 'dxy'], treasuries: ['treasury', 'tnx'],
};
function expandTermsWithAliases(terms) {
  const out = new Set(terms);
  for (const t of terms) (TERM_ALIASES[t] || []).forEach((a) => out.add(a));
  return [...out];
}

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
  let feedIds = Array.isArray(f.feedIds) ? f.feedIds.filter(Boolean) : [];
  // Constrain retrieval to allowlisted feeds when mainstream filtering and the
  // caller didn't pin feeds — otherwise dense niche/denied shows (crypto-native
  // on a bitcoin query, etc.) crowd mainstream out of the retrieved top-N before
  // the post-filter runs. Filtering at the source spends the budget on keepers.
  // Optional (opt-in) feed-constraint: restrict retrieval to allowlisted feeds.
  // Superseded by the bitcoin-relevance deny-lift below for crowded topics, so
  // it's OFF by default (it would also exclude the bitcoin_allow shows we now
  // want to admit). Enable with TAPE_MAINSTREAM_FEED_CONSTRAINT=true.
  let feedConstraintCount = -1;
  if (f.mainstream && !feedIds.length && process.env.TAPE_MAINSTREAM_FEED_CONSTRAINT === 'true') {
    const ms = await getMainstreamFeedIds();
    feedConstraintCount = ms.length;
    if (ms.length) feedIds = ms;
  }

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

  // Bitcoin/hard-money topics admit the curated bitcoin-native shows (bitcoin_allow)
  // alongside the mainstream allowlist — for these topics they're the best sources.
  const bitcoinMode = taste.isBitcoinRelevant(topic);

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
      if (String(cand.text || '').trim().split(/\s+/).length < MIN_WORDS) continue; // drop pure fragments
      if (f.mainstream && !taste.isAcceptableSource(cand.creator, { bitcoinMode })) continue;
      byId.set(cand.pineconeId, cand);
    }
  }
  let candidates = [...byId.values()];

  // Ticker-shaped query → drop company-mismatch noise before ranking/capping (§4).
  if (TICKER_FILTER_ENABLED && isTickerShaped(topic)) {
    candidates = await filterTickerNoise(topic, candidates, resolved);
  }

  // Quality gate: reuse the pull path's LLM reranker (utils/clipReranker) to DROP
  // ad reads / sponsor spots (scored 0-1), intros, and shallow clips, and keep
  // only substantively on-topic quotes (>= minScore). This is what stops a ticker
  // like CRWV from returning sponsor copy as "analysis". One gpt-4o-mini call,
  // cached with the response; self-skips when <=2 candidates.
  if (RERANK_ENABLED && openai && candidates.length > 2) {
    try {
      // Cap the rerank input to the top-N by relevance — the scorer's output
      // budget (~600 tokens) can't score a huge merged pool, and would silently
      // return it unranked. Pre-sort by similarity so the kept set is the best.
      const rel = (c) => (Number.isFinite(c.similarity) ? c.similarity : 0.5);
      const pool = candidates.length > RERANK_MAX
        ? [...candidates].sort((a, b) => rel(b) - rel(a)).slice(0, RERANK_MAX)
        : candidates;
      const rr = await rerankClips({ query: searchTopic, clips: pool, openai, subjectInfo: isTickerShaped(topic) ? cardRerankHint(topic) : '' });
      if (rr.usage) recordHelperLlmUsage(rr.usage.model, rr.usage.input_tokens, rr.usage.output_tokens);
      underlying.rerankedFrom = pool.length;
      candidates = rr.clips;
      underlying.rerankedTo = candidates.length;
    } catch (e) { printLog(`[topicQuotes] rerank skipped: ${e.message}`); }
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
  // noLiteralAnchor: skip the literal-term gate (used by the industry-fallback
  // retrieval, which ranks purely on semantic relevance to a broad sector query).
  const terms = (isTickerShaped(topic) || input.noLiteralAnchor) ? [] : expandTermsWithAliases(topicTerms(topic));
  if (terms.length && candidates.length) {
    const literal = candidates.filter((c) => containsAnyTerm(c.text, terms));
    // Multi-word topics are specific enough that ANY literal coverage is real —
    // only empty on ZERO matches (the strict floor was wrongly emptying covered
    // topics like Hormuz/energy/gold/oil; v7 had ~8 such false-empties). Single
    // bare-noun topics keep the stricter floor (a lone "gold" hit is likely noise).
    // The card-aware reranker now provides the precision the strict floor used to.
    const floor = terms.length >= 2 ? 1 : LITERAL_MIN;
    if (literal.length >= floor) {
      if (literal.length < candidates.length) printLog(`[topicQuotes] literal-anchor "${topic}" kept ${literal.length}/${candidates.length}`);
      candidates = literal;
    } else {
      printLog(`[topicQuotes] "${topic}" — only ${literal.length} literal matches (<${floor}); treating as uncovered (empty pool)`);
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
  // Rank, then apply the per-creator diversity cap before truncating, so a single
  // dense show can't crowd the final set (improves source diversity / breaks
  // single-publisher Briefs).
  candidates = capPerCreator(rankByRecency(candidates, recency, baseScore), PER_CREATOR_MAX).slice(0, f.candidatesLimit);

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
      mainstreamFeedIds: feedConstraintCount, // telemetry: -1 not attempted, 0 empty, N constrained
      bitcoinMode, // bitcoin-native shows admitted for this topic
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
