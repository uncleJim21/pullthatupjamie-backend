/**
 * feedLanguage.js — runtime join of clip → feed language.
 *
 * Language is a FEED-level property (RSS <language> tag), populated on the
 * `type:'feed'` docs by the ingestor. Rather than denormalize it onto millions
 * of paragraph/episode docs, we cache the small feedId → language map in memory
 * (357 feeds today) and resolve it at read time. The "join" is a hashmap hit.
 *
 * Normalization:
 *   - lowercase + strip region subtag: "en-US" / "en-GB" → "en", "es-419" → "es"
 *   - empty / missing → unknown → DEFAULT_LANGUAGE ("en")
 * English is the corpus default, so unlabeled feeds resolve to "en" — which
 * means English readers never see a (false) translation badge. The only cost is
 * a genuinely-non-English-but-unlabeled feed missing its badge, a safe miss.
 */
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { printLog } = require('../constants');

const DEFAULT_LANGUAGE = 'en';
const TTL_MS = parseInt(process.env.FEED_LANGUAGE_TTL_MS || '600000', 10); // 10 min

let cache = new Map();      // String(feedId) → normalized lang (e.g. "de")
let lastLoadedAt = 0;
let loadingPromise = null;

/** lowercase + strip region; '' / null / non-string → null. */
function normalizeLang(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const base = raw.trim().toLowerCase().split('-')[0];
  return base || null;
}

async function load() {
  const feeds = await JamieVectorMetadata.find({ type: 'feed' })
    .select('feedId metadataRaw.language')
    .lean();
  const next = new Map();
  for (const f of feeds) {
    const norm = normalizeLang(f.metadataRaw?.language);
    if (norm) next.set(String(f.feedId), norm); // store only known langs; getter defaults the rest
  }
  cache = next;
  lastLoadedAt = Date.now();
  printLog(`[FEED-LANG] cache loaded: ${cache.size}/${feeds.length} feeds with a known language (default="${DEFAULT_LANGUAGE}")`);
}

/**
 * Ensure the cache is warm and fresh. Safe to await on every request — it's a
 * no-op once loaded within the TTL, and de-dupes concurrent loads. Failures are
 * non-fatal: callers fall back to DEFAULT_LANGUAGE via getFeedLanguageSync.
 */
async function ensureFeedLanguages() {
  if (cache.size > 0 && Date.now() - lastLoadedAt < TTL_MS) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = load()
    .catch(err => { printLog(`[FEED-LANG] load failed (non-fatal, using "${DEFAULT_LANGUAGE}"): ${err.message}`); })
    .finally(() => { loadingPromise = null; });
  return loadingPromise;
}

/** Sync lookup. Returns normalized language or DEFAULT_LANGUAGE ("en"). */
function getFeedLanguageSync(feedId) {
  if (feedId == null) return DEFAULT_LANGUAGE;
  return cache.get(String(feedId)) || DEFAULT_LANGUAGE;
}

// Warm on import (fire-and-forget) so the first requests are already covered.
ensureFeedLanguages();

module.exports = {
  ensureFeedLanguages,
  getFeedLanguageSync,
  normalizeLang,
  DEFAULT_LANGUAGE,
};
