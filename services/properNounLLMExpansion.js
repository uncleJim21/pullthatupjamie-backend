/**
 * Proper-noun LLM-driven query expansion.
 *
 * Generates phonetic / letter-by-letter / homophone spelling variants for
 * proper-noun-shaped queries, so the Atlas Search lexical layer can recover
 * hits where ASR transcribed the term differently than written. Example:
 *   "lncurl.lol" -> ["ln curl", "L N curl", "ellen curl", "lin curl"]
 *
 * Gating is the caller's responsibility (see PROPER_NOUN_LLM_EXPANSION_ENABLED
 * + isProperNounShaped in searchQuotesService). This module is a pure helper.
 *
 * Failure mode: returns []. Never throws. Bounded by a 2s timeout so it can't
 * stall the search request.
 *
 * Caching: in-memory Map keyed by lowercased query, capped at 1000 entries.
 * Evicts oldest by insertion order when full. Acceptable for a single-process
 * Node service; if we go horizontal, swap for Redis.
 */

const { printLog } = require('../constants.js');

const MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 2000;
const MAX_VARIANTS = 5;
const CACHE_MAX = 1000;

const cache = new Map();

function getFromCache(key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setInCache(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

const PROMPT_SYSTEM = `You are a search expansion helper for a podcast transcript search engine.

Given a proper noun or coined term that the user is searching for, generate up to ${MAX_VARIANTS} alternate spellings or transcriptions an automatic speech recognizer might produce when the term is spoken aloud.

Include where applicable:
- letter-by-letter spelling out (e.g., "L N curl" for "lncurl")
- run-together phonetic homophones (e.g., "ellen curl" for "lncurl" since L-N sounds like "Ellen")
- common misspellings or near-homophones
- the term without any TLD/domain suffix (.lol, .com, .ai, etc.)

Output ONLY a JSON array of strings. No prose, no markdown, no explanation. Do NOT include the original term in the array. Maximum ${MAX_VARIANTS} variants. Each variant must be 1-50 characters.

Example input: "lncurl.lol"
Example output: ["ln curl", "L N curl", "ellen curl", "lin curl", "lncurl"]`;

function sanitizeVariants(raw, originalQuery) {
  if (!Array.isArray(raw)) return [];
  const lowerOriginal = String(originalQuery).trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length < 1 || trimmed.length > 50) continue;
    if (!/[a-z0-9]/i.test(trimmed)) continue;
    const lower = trimmed.toLowerCase();
    if (lower === lowerOriginal) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
    if (out.length >= MAX_VARIANTS) break;
  }
  return out;
}

function parseLLMOutput(content) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart === -1 || arrEnd === -1 || arrEnd <= arrStart) return null;
  const slice = text.slice(arrStart, arrEnd + 1);
  try {
    return JSON.parse(slice);
  } catch (_err) {
    return null;
  }
}

/**
 * Generate up to MAX_VARIANTS spelling/phonetic variants for a proper-noun query.
 * @param {string} query — the original user query
 * @param {{ openai: import('openai').OpenAI }} deps
 * @param {{ requestId?: string }} [opts]
 * @returns {Promise<{ variants: string[], usage: { model: string, input_tokens: number, output_tokens: number } | null }>}
 *
 * Cache hits and skipped paths return `{ variants, usage: null }` since no
 * external API call was made. Live calls return the real OpenAI usage block
 * so the caller can attribute it against the request's cost tracker.
 */
async function expandProperNounQuery(query, { openai }, opts = {}) {
  const requestId = opts.requestId || null;
  const tag = requestId ? `[${requestId}][PN-LLM-EXPAND]` : '[PN-LLM-EXPAND]';

  if (!query || typeof query !== 'string' || !query.trim()) return { variants: [], usage: null };
  if (!openai || typeof openai.chat?.completions?.create !== 'function') {
    printLog(`${tag} skipped — openai client unavailable`);
    return { variants: [], usage: null };
  }

  const cacheKey = query.trim().toLowerCase();
  const cached = getFromCache(cacheKey);
  if (cached) {
    printLog(`${tag} cache hit query="${query}" variants=${JSON.stringify(cached)}`);
    return { variants: cached, usage: null };
  }

  const started = Date.now();
  let variants = [];
  let usage = null;

  try {
    const response = await Promise.race([
      openai.chat.completions.create({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 200,
        messages: [
          { role: 'system', content: PROMPT_SYSTEM },
          { role: 'user', content: query },
        ],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('LLM expansion timeout')), TIMEOUT_MS)),
    ]);

    const content = response?.choices?.[0]?.message?.content || '';
    const parsed = parseLLMOutput(content);
    variants = sanitizeVariants(parsed, query);
    if (response?.usage) {
      usage = {
        model: MODEL,
        input_tokens: response.usage.prompt_tokens || 0,
        output_tokens: response.usage.completion_tokens || 0,
      };
    }
    const elapsed = Date.now() - started;
    printLog(`${tag} ok query="${query}" variants=${JSON.stringify(variants)} latency=${elapsed}ms`);
  } catch (err) {
    const elapsed = Date.now() - started;
    printLog(`${tag} FAILED in ${elapsed}ms (non-fatal): ${err.message}`);
    variants = [];
  }

  setInCache(cacheKey, variants);
  return { variants, usage };
}

module.exports = {
  expandProperNounQuery,
};
