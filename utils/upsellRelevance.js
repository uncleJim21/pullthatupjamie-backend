/**
 * Relevance filter for auto-upsell suggestedActions.
 *
 * Roland's feedback (2026-04-23): the agent surfaced an irrelevant Spanish
 * podcast as a submit-on-demand card because the upsell pass blindly iterates
 * every feed returned by discover_podcasts during the session.
 *
 * This module prunes candidates in two tiers before they reach emitSubmitOnDemand:
 *   Tier 1 (free, ~0ms):     language match + lexical token overlap.
 *   Tier 2 (tiny LLM, ~300ms): one gpt-4o-mini batch call when 2+ candidates
 *                              survive Tier 1. Prompt uses compact 0-based indices;
 *                              model returns JSON { "keep": [0, 2, ...] } (indices only,
 *                              no false entries) to minimize tokens.
 *
 * Failure-open: any LLM error or >3s timeout falls back to Tier-1 survivors
 * rather than blocking the response.
 */

const { printLog } = require('../constants.js');

const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'the', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'about', 'from', 'up', 'down', 'out', 'over', 'under', 'into',
  'onto', 'off', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
  'could', 'can', 'may', 'might', 'must', 'shall', 'that', 'this', 'these',
  'those', 'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him',
  'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their', 'what', 'which',
  'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'if', 'then', 'so',
  'than', 'because', 'while', 'just', 'only', 'not', 'no', 'yes', 'some',
  'any', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'another', 'such', 'same', 'own', 'also', 'very', 'too', 'really', 'get',
  'got', 'gets', 'said', 'say', 'says', 'like', 'one', 'two', 'still',
  'even', 'back', 'ever', 'never', 'also', 'podcast', 'podcasts', 'show',
  'shows', 'episode', 'episodes', 'ep', 'eps',
]);

const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const CYRILLIC_RE = /[\u0400-\u04ff]/;
const ARABIC_RE = /[\u0600-\u06ff]/;
const DEVANAGARI_RE = /[\u0900-\u097f]/;
const HEBREW_RE = /[\u0590-\u05ff]/;
const LATIN_DIACRITIC_RE = /[ñáéíóúüçàèìòùâêîôûÁÉÍÓÚÑÜÇÀÈÌÒÙÂÊÎÔÛ¿¡]/;

/**
 * Cheap language detection for short user queries.
 * Intentionally coarse: we only need to distinguish "English" from
 * "clearly-not-English" to drop mismatched podcasts.
 */
function detectQueryLanguage(query) {
  if (!query || typeof query !== 'string') return 'unknown';
  if (CJK_RE.test(query)) return 'cjk';
  if (CYRILLIC_RE.test(query)) return 'ru';
  if (ARABIC_RE.test(query)) return 'ar';
  if (DEVANAGARI_RE.test(query)) return 'hi';
  if (HEBREW_RE.test(query)) return 'he';
  if (LATIN_DIACRITIC_RE.test(query)) {
    if (/ñ/i.test(query)) return 'es';
    return 'latin-other';
  }
  return 'en';
}

/**
 * Does a PodcastIndex `language` field match the detected query language?
 * Empty/missing candidate languages are treated as unknown and kept
 * (PodcastIndex data is frequently missing this field).
 */
function languageMatches(candidateLang, queryLang) {
  if (!candidateLang) return true;
  const c = String(candidateLang).toLowerCase().trim();
  if (!c) return true;
  if (queryLang === 'en') return c.startsWith('en');
  if (queryLang === 'es') return c.startsWith('es');
  if (queryLang === 'cjk') {
    return c.startsWith('zh') || c.startsWith('ja') || c.startsWith('ko');
  }
  if (queryLang === 'ru') return c.startsWith('ru');
  if (queryLang === 'ar') return c.startsWith('ar');
  if (queryLang === 'hi') return c.startsWith('hi');
  if (queryLang === 'he') return c.startsWith('he') || c.startsWith('iw');
  return true;
}

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function hasTokenOverlap(queryTokens, candidateText) {
  if (!queryTokens.length) return true;
  const candTokens = new Set(tokenize(candidateText));
  if (candTokens.size === 0) return false;
  for (const q of queryTokens) {
    if (candTokens.has(q)) return true;
  }
  return false;
}

function clamp(str, max) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Filter untranscribed-episode upsell candidates by relevance to the user query.
 *
 * @param {object}   params
 * @param {string}   params.query       - The user message driving this request.
 * @param {Array<{feed: object, episode: object, feedFallback: object}>} params.candidates
 * @param {object}   [params.openai]    - OpenAI client (if absent, Tier 2 is skipped).
 * @param {string}   [params.requestId]
 * @param {number}   [params.llmTimeoutMs=3000]
 * @returns {Promise<{
 *   approved: Array,
 *   totalCandidates: number,
 *   filteredByLang: number,
 *   filteredByOverlap: number,
 *   filteredByLLM: number,
 *   llmSkipped: boolean,
 *   llmReason: string|null,
 *   latencyMs: number,
 * }>}
 */
async function filterUpsellCandidates({
  query,
  candidates,
  openai,
  requestId = 'UPSELL',
  llmTimeoutMs = 3000,
}) {
  const t0 = Date.now();
  const result = {
    approved: [],
    totalCandidates: Array.isArray(candidates) ? candidates.length : 0,
    filteredByLang: 0,
    filteredByOverlap: 0,
    filteredByLLM: 0,
    llmSkipped: false,
    llmReason: null,
    latencyMs: 0,
  };

  if (!Array.isArray(candidates) || candidates.length === 0) {
    result.llmSkipped = true;
    result.llmReason = 'no-candidates';
    return result;
  }

  const queryLang = detectQueryLanguage(query);
  const queryTokens = tokenize(query || '');

  // --- Tier 1: language + token overlap ---
  const tier1Survivors = [];
  for (const cand of candidates) {
    const feed = cand.feed || {};
    const ep = cand.episode || {};

    if (!languageMatches(feed.language, queryLang)) {
      result.filteredByLang++;
      continue;
    }

    const guestStr = Array.isArray(ep.guests) ? ep.guests.join(' ') : '';
    const haystack = [
      feed.title || '',
      feed.author || '',
      feed.description || '',
      ep.title || '',
      ep.description || '',
      guestStr,
    ].join(' ');

    if (!hasTokenOverlap(queryTokens, haystack)) {
      result.filteredByOverlap++;
      continue;
    }

    tier1Survivors.push(cand);
  }

  if (tier1Survivors.length === 0) {
    result.llmSkipped = true;
    result.llmReason = 'no-tier1-survivors';
    result.latencyMs = Date.now() - t0;
    return result;
  }

  // If only one candidate made it through Tier 1, the LLM call adds no value.
  if (tier1Survivors.length === 1 || !openai) {
    result.approved = tier1Survivors;
    result.llmSkipped = true;
    result.llmReason = !openai ? 'no-openai-client' : 'single-survivor';
    result.latencyMs = Date.now() - t0;
    return result;
  }

  // --- Tier 2: gpt-4o-mini batch relevance (compact index ids, reply with keep[] only) ---
  const lines = tier1Survivors.map((cand, idx) => {
    const feed = cand.feed || {};
    const ep = cand.episode || {};
    const desc = clamp(ep.description || feed.description || '', 160);
    const guests = Array.isArray(ep.guests) && ep.guests.length
      ? clamp(ep.guests.join(', '), 80)
      : '';
    const guestPart = guests ? ` | guests="${guests}"` : '';
    return `[${idx}] feed="${clamp(feed.title || '', 70)}" | ep="${clamp(ep.title || '', 90)}" | lang=${feed.language || 'unknown'} | desc="${desc}"${guestPart}`;
  }).join('\n');

  const systemPrompt = 'You are a podcast-relevance classifier for transcription upsell suggestions. Reply ONLY with JSON: { "keep": [<indices>] } where keep is a list of 0-based candidate indices that are plausibly relevant to the user\'s specific query (not just the same broad topic). List ONLY indices to include — omit rejected candidates entirely. If none qualify, return {"keep":[]}.';
  const userPrompt = `User query: ${JSON.stringify(query || '')}\n\nCandidates (use the number in brackets as the id):\n${lines}\n\nReturn JSON: {"keep":[...]} — only indices worth offering for transcription.`;

  try {
    const llmPromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 120,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`gpt-4o-mini relevance timed out after ${llmTimeoutMs}ms`)), llmTimeoutMs);
    });

    const resp = await Promise.race([llmPromise, timeoutPromise]);
    const raw = resp?.choices?.[0]?.message?.content || '{}';

    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }

    const keepIdx = new Set();
    const rawKeep = parsed.keep ?? parsed.indices ?? parsed.include;
    if (Array.isArray(rawKeep)) {
      for (const x of rawKeep) {
        const n = typeof x === 'number' ? x : parseInt(String(x), 10);
        if (!Number.isFinite(n)) continue;
        const i = Math.trunc(n);
        if (i >= 0 && i < tier1Survivors.length) keepIdx.add(i);
      }
    }

    const approved = [];
    for (let i = 0; i < tier1Survivors.length; i++) {
      if (keepIdx.has(i)) approved.push(tier1Survivors[i]);
      else result.filteredByLLM++;
    }
    result.approved = approved;
    result.latencyMs = Date.now() - t0;
    return result;
  } catch (err) {
    printLog(`[${requestId}] upsell relevance Tier 2 fallback (${err.message}) — keeping ${tier1Survivors.length} Tier-1 survivor(s)`);
    result.approved = tier1Survivors;
    result.llmSkipped = true;
    result.llmReason = `tier2-error: ${err.message}`;
    result.latencyMs = Date.now() - t0;
    return result;
  }
}

module.exports = {
  filterUpsellCandidates,
  detectQueryLanguage,
  languageMatches,
  tokenize,
  hasTokenOverlap,
};
