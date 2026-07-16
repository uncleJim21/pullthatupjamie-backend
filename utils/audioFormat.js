/**
 * Audio format helpers.
 *
 * Source podcast audio may be delivered or re-hosted in more than one container
 * (legacy `.mp3`, or a re-encoded `.m4a`/AAC copy, etc.). Any code that builds a
 * storage key or cleans up an object should stay agnostic to the specific
 * extension rather than hardcoding `.mp3`. These helpers centralize the set of
 * extensions we may encounter and how to recover a bucket key from a stored URL.
 */

// Audio file extensions the pipeline may encounter. Lowercase, no leading dot.
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac'];

/**
 * Recover the bucket object key (URL pathname without the leading slash) from a
 * full CDN/storage URL. Returns null for empty/invalid input.
 *
 * @param {string} url
 * @returns {string|null}
 */
function storageKeyFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    return new URL(url).pathname.replace(/^\/+/, '');
  } catch (err) {
    return null;
  }
}

module.exports = { AUDIO_EXTENSIONS, storageKeyFromUrl };
