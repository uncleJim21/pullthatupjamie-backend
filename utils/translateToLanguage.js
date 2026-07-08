/**
 * translateToLanguage.js — end-of-pipeline "proofreader": a pure translation
 * pass that forces the finished agent answer into the language the user asked
 * in. No cognition, no summarizing — it translates prose and quotes verbatim.
 *
 * Why this exists: the synthesis model (DeepSeek) unreliably honors the
 * respond-in-the-user's-language directive when the retrieved clips are all in
 * another language — it anchors its prose to the content language. Prompt-level
 * fixes got quote-translation working but not prose. This pass guarantees the
 * output language regardless of which model wrote the answer. It fires ONLY when
 * the detected answer language differs from the target, so most requests pay
 * nothing.
 *
 * Safety: {{clip:...}} citation tokens are ground truth and must survive intact.
 * We snapshot them before translation and, if the model drops/alters/duplicates
 * any, we discard the translation and keep the original answer (a wrong-language
 * answer is recoverable; broken citations are not).
 */

const CLIP_TOKEN_RE = /\{\{clip:[^}]+\}\}/g;

function clipTokenMultiset(text) {
  return (text.match(CLIP_TOKEN_RE) || []).slice().sort();
}

function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param {object} openai        an OpenAI-compatible client (chat.completions.create)
 * @param {string} text          the finished answer (markdown, may contain {{clip:...}})
 * @param {string} targetLangName human-readable target language, e.g. "English"
 * @returns {Promise<{text:string, usage:object|null, translated:boolean, reason?:string}>}
 */
async function translateToLanguage(openai, text, targetLangName) {
  if (!text || !text.trim()) return { text, usage: null, translated: false, reason: 'empty' };

  const before = clipTokenMultiset(text);

  const system = `You are a pure translation engine. You translate text; you do not think, answer, summarize, explain, or add anything of your own. Translate the user's ENTIRE message into ${targetLangName}.

Rules:
- Output ONLY the translation — no preamble, no notes, no quotation marks around the whole thing.
- Preserve ALL markdown exactly: headers (#, ##), bold (**), italics (*), blockquote markers (>), lists, horizontal rules (---), and every line break.
- Preserve every {{clip:...}} token EXACTLY as written — do not translate, rename, reorder, merge, or delete them, and keep each on its own line where it already is.
- Translate the words INSIDE blockquotes too (the quoted speech), so the whole answer reads in ${targetLangName}.
- If a passage is already in ${targetLangName}, leave it as-is.
- Do not add disclaimers like "(translated)".`;

  // Bounded so a slow/hung translation fails safe (caller keeps the original
  // answer) instead of stalling the response. A few-KB translation completes in
  // a few seconds; the ceiling is generous headroom, tunable via env.
  const timeoutMs = parseInt(process.env.LANGUAGE_PROOFREADER_TIMEOUT_MS || '30000', 10);
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
  }, { timeout: timeoutMs });

  const out = resp.choices?.[0]?.message?.content || '';
  const usage = resp.usage || null;

  if (!out.trim()) return { text, usage, translated: false, reason: 'empty-output' };
  if (!sameMultiset(before, clipTokenMultiset(out))) {
    return { text, usage, translated: false, reason: 'clip-token-mismatch' };
  }

  return { text: out, usage, translated: true };
}

module.exports = { translateToLanguage };
