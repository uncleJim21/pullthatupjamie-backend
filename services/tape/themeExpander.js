/**
 * Theme expansion for topic-quotes (the §4 retrieval side-ask).
 *
 * A user-typed topic ("gold prognosis") is often a phrasing nobody says on a
 * podcast. Before fanning out to search-quotes, expand it into plausible
 * spoken phrasings ("gold outlook", "gold safe haven", "gold price target", …).
 *
 * Two layers:
 *   1. LLM rewrite (gpt-4o-mini) — best coverage, cached via the topic-quotes
 *      response so it's paid once per topic. Records helper token usage.
 *   2. Deterministic template fallback — used when the LLM is disabled, errors,
 *      or no openai client is available. Cheap synonyms over the head noun.
 *
 * Disable the LLM layer with TAPE_THEME_EXPANSION=false (templates still apply).
 */

const { printLog } = require('../../constants');

const LLM_ENABLED = process.env.TAPE_THEME_EXPANSION !== 'false';
const MODEL = process.env.TAPE_THEME_EXPANSION_MODEL || 'gpt-4o-mini';
const MAX_VARIANTS = 5;

// Generic finance framings appended to a topic as a deterministic fallback.
const TEMPLATE_SUFFIXES = ['outlook', 'forecast', 'price action', 'analysis', 'this week'];

function templateVariants(topic) {
  const t = String(topic || '').trim();
  if (!t) return [];
  // Strip a few weak head words people type but hosts don't say.
  const cleaned = t.replace(/\b(prognosis|prediction|thoughts|take|vibes)\b/gi, '').replace(/\s+/g, ' ').trim() || t;
  return TEMPLATE_SUFFIXES.map((s) => `${cleaned} ${s}`);
}

async function llmVariants(topic, { openai, recordHelperLlmUsage }) {
  if (!LLM_ENABLED || !openai) return null;
  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content:
            'You rewrite a finance topic into short phrasings a podcast host or guest would actually say, '
            + 'for retrieval over transcripts. Output ONLY a JSON array of 3-5 short strings, no prose. '
            + 'Keep the core subject; vary the framing (outlook, rally, risk, price target, safe haven, etc.). '
            + 'Do not add tickers or companies not implied by the topic.',
        },
        { role: 'user', content: `Topic: "${topic}"` },
      ],
    });
    const txt = resp?.choices?.[0]?.message?.content || '';
    const usage = resp?.usage;
    if (usage && typeof recordHelperLlmUsage === 'function') {
      recordHelperLlmUsage(MODEL, usage.prompt_tokens || 0, usage.completion_tokens || 0);
    }
    const match = txt.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return null;
    return arr.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  } catch (err) {
    printLog(`[themeExpander] LLM expansion failed for "${topic}": ${err.message}`);
    return null;
  }
}

/**
 * Expand a topic into a deduped, capped list of phrasings to fan out over.
 * Always includes the original `seedThemes` (verbatim, first).
 *
 * @param {object} opts
 * @param {string} opts.topic           the head topic/query
 * @param {string[]} [opts.seedThemes]  caller-provided themes (kept as-is)
 * @param {object} opts.deps            { openai, recordHelperLlmUsage }
 * @returns {Promise<string[]>}
 */
async function expandThemes({ topic, seedThemes = [], deps = {} }) {
  const seen = new Set();
  const out = [];
  const push = (s) => {
    const v = String(s || '').trim();
    const k = v.toLowerCase();
    if (v && !seen.has(k)) { seen.add(k); out.push(v); }
  };

  // 1. Caller-provided themes first (highest intent).
  seedThemes.forEach(push);
  if (topic) push(topic);

  // 2. LLM variants, then 3. template fallback (only if LLM gave nothing new).
  const llm = await llmVariants(topic, deps);
  if (llm && llm.length) llm.forEach(push);
  else templateVariants(topic).forEach(push);

  return out.slice(0, Math.max(seedThemes.length, MAX_VARIANTS) + 1);
}

module.exports = { expandThemes, templateVariants };
