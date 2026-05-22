/**
 * Dedicated HMAC verification for benchmark-mode requests.
 *
 * Single-purpose by design. Reads ONE env var (BENCHMARK_HMAC_SECRET) and
 * verifies an incoming request signature against it. If the env var is
 * unset, benchmark mode is fully off — the function always returns false,
 * and no caller can see internal `_timings`/`metrics` regardless of headers.
 *
 * Fail-quiet: bad/missing/expired headers all return false silently. Never
 * 401s, so the existence of the mechanism isn't observable to probing.
 *
 * Same crypto as middleware/hmac.js (HMAC-SHA256 over the canonical request
 * string, 60-second clock-skew window, timing-safe comparison, body-hash
 * check when raw body is available).
 *
 * Why not reuse serviceHmac? That middleware uses a multi-key/scope system
 * driven by SVC_HMAC_KEYS_JSON + ALLOWED_SCOPES_JSON. Benchmark needs only
 * one secret; threading it through the scope system would require two env
 * vars instead of one. This file keeps the single-secret promise.
 */

const crypto = require('crypto');

const KEY_ID = 'benchmark';
const DEFAULT_MAX_SKEW_SECONDS = Number(process.env.BENCHMARK_HMAC_MAX_SKEW_SECS || 60);

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

function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(a || '', 'utf8');
  const bBuf = Buffer.from(b || '', 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function computeExpectedSignature({ method, path, queryString, bodyHashHex, timestamp, secret }) {
  const canonical = [
    String(method).toUpperCase(),
    path,
    queryString || '',
    bodyHashHex || '',
    String(timestamp),
    KEY_ID,
  ].join('\n');
  return crypto.createHmac('sha256', secret).update(canonical).digest('base64');
}

/**
 * Returns true iff the request carries a valid HMAC signature for the
 * benchmark mode. Silently returns false for any failure condition.
 */
function isBenchmarkRequest(req, { maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS } = {}) {
  const secret = process.env.BENCHMARK_HMAC_SECRET;
  if (!secret) return false; // benchmark mode disabled entirely

  try {
    // X-Bench-* namespace deliberately distinct from the X-Svc-* used by
    // middleware/hmac.js — sharing that namespace would cause the existing
    // serviceHmac middleware on /api/pull to 401 us before this check runs.
    // (Originally tried X-Benchmark-* but Cloudflare's bot ruleset
    // slow-loris-hangs requests using that exact prefix.)
    const keyId = String(req.headers['x-bench-keyid'] || '');
    const tsStr = String(req.headers['x-bench-timestamp'] || '');
    const providedSig = String(req.headers['x-bench-signature'] || '');
    const providedBodyHash = String(req.headers['x-bench-body-hash'] || '');

    if (!keyId || !tsStr || !providedSig) return false;
    if (keyId !== KEY_ID) return false;

    const now = Math.floor(Date.now() / 1000);
    const ts = Number(tsStr);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(now - ts) > maxSkewSeconds) return false;

    const contentLength = Number(req.headers['content-length'] || 0);
    let bodyHashHex = providedBodyHash;
    if (contentLength > 0) {
      if (!providedBodyHash) return false;
      if (req.rawBody !== undefined) {
        const actualBodyHash = sha256Hex(req.rawBody);
        if (!timingSafeEqualStr(providedBodyHash, actualBodyHash)) return false;
      }
      // If rawBody isn't captured, we accept the provided hash on faith for
      // signature input. TLS still protects body integrity in transit, but
      // worth wiring captureRawBody before express.json() in a hardening pass.
    }

    const method = (req.method || 'GET').toUpperCase();
    const path = ((req.baseUrl || '') + (req.path || '/')) || '/';
    const queryString = buildSortedQueryString(req.query);
    const expectedSig = computeExpectedSignature({
      method, path, queryString, bodyHashHex, timestamp: ts, secret,
    });
    if (!timingSafeEqualStr(providedSig, expectedSig)) return false;

    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  isBenchmarkRequest,
  // Exported so the benchmark harness (scripts/benchmarks/signRequest.js)
  // can import and reuse the exact same canonical-string logic.
  KEY_ID,
  sha256Hex,
  buildSortedQueryString,
  computeExpectedSignature,
};
