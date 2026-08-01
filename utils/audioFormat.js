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

// User-facing audio host. Public audioUrls are rewritten to this Cloudflare-
// fronted hostname so repeat playback is served from Cloudflare's cache instead
// of billing DigitalOcean egress. The path (feedId/guid.ext) is unchanged; a
// Cloudflare Worker on this host maps requests back to the raw Spaces origin.
const PUBLIC_AUDIO_HOST = 'audio.pullthatupjamie.ai';

// Our Spaces audio bucket host, in either the CDN or direct form.
const SPACES_AUDIO_HOST_RE = /cascdr-chads-stay-winning\.nyc3\.(?:cdn\.)?digitaloceanspaces\.com/i;

/**
 * Rewrite a stored DigitalOcean Spaces audio URL to the public Cloudflare host.
 * No-ops for empty/non-string values and for URLs that don't point at our audio
 * bucket (e.g. original RSS enclosures hosted on the podcaster's own domain).
 *
 * @param {string} url
 * @returns {string} the rewritten URL, or the input unchanged
 */
function publicAudioUrl(url) {
  if (!url || typeof url !== 'string') return url;
  return url.replace(SPACES_AUDIO_HOST_RE, PUBLIC_AUDIO_HOST);
}

module.exports = { AUDIO_EXTENSIONS, storageKeyFromUrl, publicAudioUrl, PUBLIC_AUDIO_HOST };
