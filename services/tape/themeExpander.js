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
const MAX_VARIANTS = 7;

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
      temperature: 0.2,
      max_tokens: 220,
      messages: [
        {
          role: 'system',
          content:
            'You decompose a finance subject into the distinct ANALYTICAL ANGLES an equity analyst or '
            + 'macro strategist would actually probe, then phrase each as a short search query a podcast '
            + 'host/guest would say, for semantic retrieval over transcripts. Output ONLY a JSON array of '
            + '5-7 strings.\n'
            + 'RULES:\n'
            + '- Each phrase 2-5 words, terse and spoken. NOT full sentences. No "the".\n'
            + '- COVER DISTINCT ANGLES, not rephrasings of the same point. For a COMPANY: profit margins, '
            + 'revenue growth, competition / moat, customer concentration, valuation, long-term strategy, '
            + 'guidance / outlook, key risks (e.g. CoreWeave → "CoreWeave profit margins", "CoreWeave '
            + 'revenue growth", "CoreWeave customer concentration", "CoreWeave debt financing", "CoreWeave '
            + 'long-term strategy", "CoreWeave valuation", "CoreWeave AI demand"). For a MACRO topic: its '
            + 'real sub-debates (gold → "gold price target", "gold safe haven", "real rates gold", '
            + '"central bank gold buying"; AI bubble → "AI capex ROI", "AI valuations bubble", '
            + '"AI concentration risk", "AI monetization").\n'
            + '- Lead each phrase with the subject so it stays on-topic. Use real jargon / products / '
            + 'people / tickers. Stay strictly on the given subject.',
        },
        { role: 'user', content: `Subject: "${topic}"\nReturn the JSON array of analyst-angle search phrases.` },
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
