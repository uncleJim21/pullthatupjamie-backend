/**
 * Sign a request with the HMAC scheme that utils/benchmarkAuth.js expects.
 *
 * Mirrors the canonical-string format used server-side:
 *   METHOD\nPATH\nSORTED_QUERY\nBODY_SHA256_HEX\nTIMESTAMP\nKEY_ID
 *
 * The keyId is fixed to "benchmark" — the server-side verifier hardcodes
 * the same string so we don't need a per-key map. The harness only knows
 * the secret (from BENCHMARK_HMAC_SECRET) and the fixed keyId.
 */

const crypto = require('crypto');

const KEY_ID = 'benchmark';

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input || '').digest('hex');
}

function buildSortedQueryString(query) {
  if (!query || typeof query !== 'object') return '';
  const params = [];
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (Array.isArray(value)) {
      for (const v of [...value].map(v => `${v}`).sort()) {
        params.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
      }
    } else if (value === undefined || value === null) {
      params.push(`${encodeURIComponent(key)}=`);
    } else {
      params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return params.join('&');
}

/**
 * @param {Object} args
 * @param {string} args.method      HTTP method (e.g. 'POST')
 * @param {string} args.path        URL path (e.g. '/api/pull')
 * @param {Object} [args.query]     Query params (object form)
 * @param {string} [args.rawBody]   The exact body string that will be sent
 * @param {string} args.secret      HMAC secret (hex string from BENCHMARK_HMAC_SECRET)
 * @returns {Object} headers to attach to the outgoing request
 */
function signRequest({ method, path, query, rawBody, secret }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHashHex = rawBody ? sha256Hex(rawBody) : '';
  const queryString = buildSortedQueryString(query);

  const canonical = [
    String(method).toUpperCase(),
    path,
    queryString || '',
    bodyHashHex || '',
    String(timestamp),
    KEY_ID,
  ].join('\n');

  const signature = crypto.createHmac('sha256', secret).update(canonical).digest('base64');

  // Deliberately distinct from the X-Svc-* namespace used by the existing
  // serviceHmac middleware mounted on /api/pull. Sharing that namespace
  // would cause the production serviceHmac (which reads a different env
  // key map) to 401 our requests before they reach the route handler.
  return {
    'X-Jamie-KeyId': KEY_ID,
    'X-Jamie-Timestamp': String(timestamp),
    'X-Jamie-Body-Hash': bodyHashHex,
    'X-Jamie-Signature': signature,
  };
}

module.exports = { signRequest, sha256Hex, buildSortedQueryString, KEY_ID };
