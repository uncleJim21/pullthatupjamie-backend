/**
 * detectLanguage.js — lightweight, dependency-free language detection for the
 * agent's final answer prose.
 *
 * Purpose: tell the client what language an answer is written in
 * (`responseLanguage`) so it can decide whether a cited clip's audio language
 * differs ("translated from German"). We only need to discriminate the handful
 * of languages we actually serve and default safely to English.
 *
 * Method: function-word (stopword) frequency. Function words are the most
 * reliable language signal in running prose and survive heavy proper-noun
 * content (e.g. an English answer full of German show/person names still reads
 * as English because "the/and/of/is/that" dominate). We score the text against
 * each language's common-word set and pick the best, defaulting to "en" when
 * the signal is weak or the text is too short.
 *
 * Returns a lowercase ISO 639-1 code. NEVER null — defaults to "en".
 */

const DEFAULT_LANGUAGE = 'en';

// Distinctive high-frequency function words per language. Kept small and
// deliberately weighted toward words that DON'T collide across languages where
// possible (e.g. German "und/ist/nicht", Spanish "que/los/con", vs the shared
// romance "de/la/el"). Collisions are fine — scoring is comparative.
const STOPWORDS = {
  en: new Set(['the','and','of','to','in','is','that','it','for','was','with','as','on','be','at','this','have','from','are','you','what','about','they','said','his','her','an','or','not','but','we','he','she','their','there']),
  de: new Set(['der','die','und','den','von','zu','das','mit','sich','des','auf','für','ist','im','dem','nicht','ein','eine','als','auch','es','an','werden','war','hat','dass','sie','nach','wird','bei','einer','um','sind','noch','wie','einem','über','einen','so','zum','haben','nur','oder','aber','vor','zur','bis','mehr','durch','wenn','wir',
    // Distinctive German question/verb words that boost short-question detection
    // ("Was sagt X über…?"). Most don't collide with English; 'was' is added so
    // a German question isn't biased toward English (which also has 'was').
    'was','sagen','sagt','wer','warum','welche','wieso','wann','gegen','nutzen','menschen','deutsche','deutschsprachige','denken','meinen','sprechen','gibt','macht','kann','soll','gut','viele']),
  es: new Set(['de','la','que','el','en','los','del','se','las','por','un','para','con','una','su','al','lo','como','más','pero','sus','le','ya','son','sobre','este','esta','están','está','también','muy','hay','fue','dijo','sería']),
  pt: new Set(['de','que','do','da','em','um','para','com','não','uma','os','no','se','na','por','mais','as','dos','como','mas','foi','ao','das','seu','sua','ou','quando','muito','nos','já','está','também','pelo','isso','essa']),
  fr: new Set(['le','de','un','être','et','en','que','pour','dans','ce','il','qui','ne','sur','se','pas','plus','par','je','avec','les','des','est','une','au','aux','cette','sont','ont','mais','ou','comme','leur','nous','vous','sans']),
};

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    // keep latin letters incl. accents/umlauts; split on everything else
    .replace(/[^a-zàâäáéèêëíìîïóòôöúùûüñçß\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.minTokens=12] minimum token count before we trust a match
 * @param {number} [opts.minScore=3]   minimum function-word hits before we trust a match
 * @returns {string} lowercase ISO 639-1 code; "en" when uncertain / too short.
 */
function detectTextLanguage(text, { minTokens = 12, minScore = 3 } = {}) {
  const tokens = tokenize(text);
  // Too little signal to trust anything but the default.
  if (tokens.length < minTokens) return DEFAULT_LANGUAGE;

  const scores = {};
  for (const lang of Object.keys(STOPWORDS)) scores[lang] = 0;
  for (const tok of tokens) {
    for (const lang of Object.keys(STOPWORDS)) {
      if (STOPWORDS[lang].has(tok)) scores[lang]++;
    }
  }

  let best = DEFAULT_LANGUAGE;
  let bestScore = scores[DEFAULT_LANGUAGE] || 0;
  for (const lang of Object.keys(scores)) {
    if (scores[lang] > bestScore) { best = lang; bestScore = scores[lang]; }
  }

  // Require a minimal density of function words so a proper-noun-heavy or
  // garbled passage falls back to English rather than a spurious match.
  const density = bestScore / tokens.length;
  if (bestScore < minScore || density < 0.04) return DEFAULT_LANGUAGE;

  return best;
}

/**
 * Detect the language of a USER QUESTION. Questions are short, so we lower the
 * floors relative to answer-prose detection and add two cheap high-precision
 * signals: Spanish inverted punctuation (¿ ¡) and, as a tiebreak, accented-Latin
 * characters (which English lacks) to pull a borderline call off the English
 * default. Still defaults to "en" — the safe majority — when the signal is thin.
 * @param {string} text
 * @returns {string} lowercase ISO 639-1 code.
 */
function detectQuestionLanguage(text) {
  const s = String(text || '');
  if (/[¿¡]/.test(s)) return 'es'; // unambiguous Spanish marker
  const detected = detectTextLanguage(s, { minTokens: 4, minScore: 2 });
  if (detected !== DEFAULT_LANGUAGE) return detected;
  return DEFAULT_LANGUAGE;
}

const LANGUAGE_NAMES = { en: 'English', es: 'Spanish', de: 'German', pt: 'Portuguese', fr: 'French' };

// Per-language "translate the quote into THIS language" illustration, written
// in the target language itself so the model sees the register it should write.
const DIRECTIVE_EXAMPLES = {
  en: 'Example: a Spanish clip becomes English — *"Bitcoin es el dinero más perfecto"* → *"Bitcoin is the most perfect money"*.',
  es: 'Ejemplo: una cita en inglés se traduce al español — *"Bitcoin is a hedge against inflation"* → *"Bitcoin es una cobertura contra la inflación"*.',
  de: 'Beispiel: ein spanisches Zitat wird ins Deutsche übersetzt — *"Bitcoin es dinero para la gente"* → *"Bitcoin ist Geld für die Menschen"*.',
  pt: 'Exemplo: uma citação em inglês é traduzida para o português — *"Bitcoin is a hedge against inflation"* → *"Bitcoin é uma proteção contra a inflação"*.',
  fr: 'Exemple : une citation en anglais est traduite en français — *"Bitcoin is a hedge against inflation"* → *"Bitcoin est une couverture contre l\'inflation"*.',
};

/**
 * Build the per-request, top-priority language directive that is appended to the
 * system + synthesis prompts. Deterministic: the language is detected from the
 * user's question server-side and stated as a fact, so the model does not have
 * to infer it against a large same-language clip context (which it does
 * unreliably — see the language regression testing on jc/clip-source-language).
 * @param {string} question the user's message
 * @returns {string} a directive block (leading newlines included)
 */
function buildLanguageDirective(question) {
  const lang = detectQuestionLanguage(question);
  const name = LANGUAGE_NAMES[lang] || 'English';
  const example = DIRECTIVE_EXAMPLES[lang] || DIRECTIVE_EXAMPLES.en;
  return `\n\n## RESPONSE LANGUAGE — highest priority, overrides everything above\n`
    + `The user wrote their question in ${name}. Write your ENTIRE answer in ${name} — prose, headers, and the words inside every quote — regardless of what language the clips are in. `
    + `When a clip is in another language, translate the text inside its blockquote into ${name} and keep the \`{{clip:…}}\` token exactly as-is (translating quote display text is required and is NOT invention). `
    + `${example}`;
}

/**
 * Compact, high-recency language reminder appended to the LAST message in the
 * array (right before generation) — the position with the strongest pull on the
 * model. The system-prompt directive alone loses to a large same-language clip
 * context that sits *after* the system prompt in the message array; this reminder
 * is the last thing the model reads, so it wins. Keep it short.
 * @param {string} question the user's message
 * @returns {string} reminder text
 */
function buildLanguageReminder(question) {
  const lang = detectQuestionLanguage(question);
  const name = LANGUAGE_NAMES[lang] || 'English';
  return `[LANGUAGE — obey exactly] The user asked in ${name}. Write your entire answer in ${name}, `
    + `including translating every quote into ${name} (keep each \`{{clip:…}}\` token unchanged). `
    + `Do not answer in the clips' language just because the clips are in it.`;
}

module.exports = { detectTextLanguage, detectQuestionLanguage, buildLanguageDirective, buildLanguageReminder, LANGUAGE_NAMES, DEFAULT_LANGUAGE };
