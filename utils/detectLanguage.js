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
  de: new Set(['der','die','und','den','von','zu','das','mit','sich','des','auf','für','ist','im','dem','nicht','ein','eine','als','auch','es','an','werden','war','hat','dass','sie','nach','wird','bei','einer','um','sind','noch','wie','einem','über','einen','so','zum','haben','nur','oder','aber','vor','zur','bis','mehr','durch','wenn','wir']),
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
 * @returns {string} lowercase ISO 639-1 code; "en" when uncertain / too short.
 */
function detectTextLanguage(text) {
  const tokens = tokenize(text);
  // Too little signal to trust anything but the default.
  if (tokens.length < 12) return DEFAULT_LANGUAGE;

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
  if (bestScore < 3 || density < 0.04) return DEFAULT_LANGUAGE;

  return best;
}

module.exports = { detectTextLanguage, DEFAULT_LANGUAGE };
