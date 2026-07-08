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
 * Model: Claude Haiku. gpt-4o-mini was too weak — it flattened the markdown
 * (dropped `>` blockquotes) and occasionally mangled {{clip:...}} tokens, which
 * tripped the citation guard and fell the whole answer back to the untranslated
 * original. Haiku preserves the structure far more reliably.
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

const SYSTEM_PROMPT = (targetLangName) => `You are a pure translation engine. You translate text; you do not think, answer, summarize, explain, or add anything of your own. Translate the user's ENTIRE message into ${targetLangName}.

Preserve the document's structure EXACTLY — this is a formatted markdown answer with citations, not plain prose:
- Keep every markdown element in place: headers (#, ##, ###), bold (**text**), italics (*text*), bullet/numbered lists, and horizontal rules (---).
- Keep every blockquote a blockquote: a line that starts with "> " must still start with "> " in your output, and quotes wrapped as > *"..."* must stay wrapped exactly as > *"..."* (blockquote marker + italics + quotation marks), with the quoted speech translated inside.
- Keep every {{clip:...}} token EXACTLY as written, on its own line, in the same position. Never translate, rename, reorder, merge, split, or delete a {{clip:...}} token.
- Keep the same number of lines and line breaks. Translate line-by-line; do not merge paragraphs or reflow.

Translate ALL human-readable text — prose, headers, and the words inside blockquotes — so the whole answer reads in ${targetLangName}. If a passage is already in ${targetLangName}, leave it unchanged. Output ONLY the translated document: no preamble, no notes, no "(translated)" markers.

Example of the shape to preserve (structure identical, only the words change language):
INPUT:
## Adopción en Latinoamérica
La gente usa Bitcoin para sobrevivir.

{{clip:abc-123_p4}}
> *"Bitcoin es nuestra única cobertura contra la inflación."*
OUTPUT:
## Adoption in Latin America
People use Bitcoin to survive.

{{clip:abc-123_p4}}
> *"Bitcoin is our only hedge against inflation."*`;

/**
 * @param {object} anthropic     an Anthropic SDK client (messages.create)
 * @param {string} model         Haiku model id, e.g. "claude-haiku-4-5-20251001"
 * @param {string} text          the finished answer (markdown, may contain {{clip:...}})
 * @param {string} targetLangName human-readable target language, e.g. "English"
 * @returns {Promise<{text:string, usage:object|null, translated:boolean, reason?:string}>}
 *          usage is {input_tokens, output_tokens} for cost tracking.
 */
async function translateToLanguage(anthropic, model, text, targetLangName) {
  if (!text || !text.trim()) return { text, usage: null, translated: false, reason: 'empty' };

  const before = clipTokenMultiset(text);
  const timeoutMs = parseInt(process.env.LANGUAGE_PROOFREADER_TIMEOUT_MS || '30000', 10);
  const maxTokens = parseInt(process.env.LANGUAGE_PROOFREADER_MAX_TOKENS || '4096', 10);

  const resp = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    temperature: 0,
    system: SYSTEM_PROMPT(targetLangName),
    messages: [{ role: 'user', content: text }],
  }, { timeout: timeoutMs });

  const out = (resp.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  const usage = resp.usage
    ? { input_tokens: resp.usage.input_tokens || 0, output_tokens: resp.usage.output_tokens || 0 }
    : null;

  if (!out.trim()) return { text, usage, translated: false, reason: 'empty-output' };
  if (!sameMultiset(before, clipTokenMultiset(out))) {
    return { text, usage, translated: false, reason: 'clip-token-mismatch' };
  }

  return { text: out, usage, translated: true };
}

module.exports = { translateToLanguage };
