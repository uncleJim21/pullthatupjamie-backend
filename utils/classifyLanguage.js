/**
 * classifyLanguage.js — LLM-based detection of the language a user is WRITING in.
 *
 * The stopword heuristic in detectLanguage.js is brittle on the exact cases that
 * matter: short questions ("que dice Saylor") and questions that embed English
 * proper nouns / show titles ("¿qué dice Michael Saylor en What Bitcoin Did?").
 * A tiny LLM call classifies the writing language far more reliably and returns
 * a confidence so the caller can fall back to the heuristic when unsure.
 *
 * Model: gpt-4o-mini, JSON mode, temperature 0 — a few tokens in/out, ~$0.0001.
 */

/**
 * @param {object} openai OpenAI-compatible client (chat.completions.create)
 * @param {string} text   the user's message
 * @returns {Promise<{language:string, confidence:number, usage:{input:number,output:number}|null}>}
 *          language is a lowercase ISO 639-1 code; confidence in [0,1].
 */
async function classifyQuestionLanguage(openai, text) {
  const t = String(text || '').trim();
  if (!t) return { language: 'en', confidence: 0, usage: null };

  const system = 'You determine the language the SENTENCE ITSELF is written in, judged by its '
    + 'grammar and function words. The user is often ASKING ABOUT another language, country, or '
    + 'foreign content while writing in their OWN language — do not let the topic fool you. '
    + 'Examples: "what are spanish podcasts saying about X" is ENGLISH (English grammar; "spanish" '
    + 'is just the topic); "¿qué dice Michael Saylor en What Bitcoin Did?" is SPANISH (Spanish '
    + 'grammar; the English names are just references); "was sagen spanische Podcasts über Bitcoin?" '
    + 'is GERMAN. Ignore proper nouns, brand/show/product names, country/language topic words, and '
    + 'quoted foreign titles. Respond ONLY with JSON: {"language":"<ISO 639-1 code>","confidence":'
    + '<number 0..1>}. confidence is how certain you are of the writing language.';

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 30,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: t },
    ],
  }, { timeout: parseInt(process.env.LANGUAGE_CLASSIFIER_TIMEOUT_MS || '8000', 10) });

  const parsed = JSON.parse(resp.choices?.[0]?.message?.content || '{}');
  const usage = resp.usage || {};
  const language = String(parsed.language || 'en').toLowerCase().trim().split('-')[0] || 'en';
  let confidence = Number(parsed.confidence);
  if (!isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    language,
    confidence,
    usage: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 },
  };
}

module.exports = { classifyQuestionLanguage };
