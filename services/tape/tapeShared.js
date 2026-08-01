/**
 * Small shared helpers for the Tape recipes: map a searchQuotes result to the
 * TapeCitation candidate shape, validate dates, and hash request bodies for
 * cache keys.
 */

const crypto = require('crypto');
const { publicAudioUrl } = require('../../utils/audioFormat');
const { TapeHttpError } = require('./tapeErrors');

/**
 * Map a `searchQuotes` result object to the TapeCitation candidate shape.
 * Field mapping (see services/searchQuotesService.js result builder):
 *   pineconeId <- shareLink, text <- quote, episodeTitle <- episode,
 *   startTime/endTime <- timeContext, publishedDate <- date.
 */
function candidateFromResult(r) {
  if (!r || !r.shareLink) return null;
  const start = r.timeContext?.start_time;
  const end = r.timeContext?.end_time;
  const spanSec = Number.isFinite(start) && Number.isFinite(end)
    ? Math.round(end - start)
    : null;
  const sim = r.similarity && Number.isFinite(r.similarity.combined) ? r.similarity.combined : null;
  return {
    pineconeId: r.shareLink,
    text: r.quote || '',
    episodeTitle: r.episode || null,
    creator: r.creator || null,
    feedId: r.feedId != null ? String(r.feedId) : null, // for source gating (tapeTaste.feed_allow)
    episodeImage: r.episodeImage && r.episodeImage !== 'Image unavailable' ? r.episodeImage : null,
    audioUrl: publicAudioUrl(r.audioUrl && r.audioUrl !== 'URL unavailable' ? r.audioUrl : null),
    startTime: Number.isFinite(start) ? start : null,
    endTime: Number.isFinite(end) ? end : null,
    publishedDate: r.date && r.date !== 'Date not provided' ? r.date : null,
    spanSec,
    similarity: sim, // vector relevance (0..1); null for lexical-only / literal hits
  };
}

/** Validate an optional YYYY-MM-DD date. Returns the string or null; throws 400 if malformed. */
function validateDate(value, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new TapeHttpError(400, 'bad-request', 'Bad request', `${label} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}

/** Stable SHA-256 of a canonicalized object, for cache keys. */
function hashBody(obj) {
  const canonical = JSON.stringify(sortKeys(obj || {}));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => {
      // ignore control flags that must not affect the cache identity
      if (k === '_nocache' || k === 'refresh') return acc;
      acc[k] = sortKeys(value[k]);
      return acc;
    }, {});
  }
  return value;
}

/** Sorted list of candidate pineconeIds — the identity set for revalidation. */
function candidateIds(body) {
  return (body?.candidates || []).map((c) => c.pineconeId).filter(Boolean).sort();
}

module.exports = { candidateFromResult, validateDate, hashBody, candidateIds };
