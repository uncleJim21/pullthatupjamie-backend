const crypto = require('crypto');

/**
 * Lightweight HMAC auth for service-to-service calls.
 *
 * Goals:
 * - No Redis or external state
 * - Fast and simple
 * - Reasonable security: tight time window and full-request canonicalization
 *
 * Usage (server.js):
 *   const { serviceHmac } = require('./middleware/hmac');
 *   app.post('/api/internal/task', serviceHmac({ requiredScopes: ['svc:task:run'] }), handler)
 *
 * Client must send headers:
 *   - X-Svc-KeyId: identifies which shared secret to use
 *   - X-Svc-Timestamp: unix seconds (Number)
 *   - X-Svc-Body-Hash: hex(sha256(rawBody)) or "" for empty body
 *   - X-Svc-Signature: base64(HMAC-SHA256(canonicalString, secret))
 *   - (optional) X-Svc-Scope: space-separated scopes
 *
 * Canonical string (joined by '\n'):
 *   METHOD
 *   PATH
 *   SORTED_QUERY_STRING
 *   BODY_SHA256_HEX
 *   X-Svc-Timestamp
 *   X-Svc-KeyId
 */

// Load key map from env (preferred: JSON), with fallback to a single secret
function loadKeyMap() {
  const json = process.env.SVC_HMAC_KEYS_JSON;
  const secretsAreBase64 = process.env.SVC_HMAC_SECRETS_BASE64 === 'true';
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object') {
        if (!secretsAreBase64) return parsed;
        const mapped = {};
        for (const [k, v] of Object.entries(parsed)) {
          mapped[k] = Buffer.from(String(v), 'base64');
        }
        return mapped;
      }
    } catch (_) {}
  }
  if (process.env.SHARED_HMAC_SECRET) {
    return {
      default: process.env.SVC_HMAC_SECRETS_BASE64 === 'true'
        ? Buffer.from(String(process.env.SHARED_HMAC_SECRET), 'base64')
        : process.env.SHARED_HMAC_SECRET
    };
  }
  return {};
}

const KEY_MAP = loadKeyMap();

// Load allowed scopes map from env (keyId -> [scopes])
function loadAllowedScopesMap() {
  const json = process.env.ALLOWED_SCOPES_JSON;
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}
  return null;
}

const ALLOWED_SCOPES_MAP = loadAllowedScopesMap();

function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(a || '', 'utf8');
  const bBuf = Buffer.from(b || '', 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input || '').digest('hex');
}

function buildSortedQueryString(query) {
  if (!query || typeof query !== 'object') return '';
  const params = [];
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (Array.isArray(value)) {
      const sortedVals = [...value].map(v => `${v}`).sort();
      for (const v of sortedVals) params.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    } else if (value === undefined || value === null) {
      params.push(`${encodeURIComponent(key)}=`);
    } else {
      params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return params.join('&');
}

function computeSignature({ method, path, queryString, bodyHashHex, timestamp, keyId, secret }) {
  const canonical = [
    method.toUpperCase(),
    path,
    queryString || '',
    bodyHashHex || '',
    String(timestamp),
    keyId
  ].join('\n');
  return crypto.createHmac('sha256', secret).update(canonical).digest('base64');
}

/**
 * Middleware factory.
 * Options:
 *  - requiredScopes: array of scope strings to require (optional)
 *  - maxSkewSeconds: allowed clock skew in seconds (default 60)
 *  - keyHeader: header name for key id (default 'x-svc-keyid')
 *  - timestampHeader: header name for timestamp (default 'x-svc-timestamp')
 *  - sigHeader: header name for signature (default 'x-svc-signature')
 *  - bodyHashHeader: header name for body hash (default 'x-svc-body-hash')
 */
function serviceHmac(options = {}) {
  const {
    requiredScopes = [],
    maxSkewSeconds = Number(process.env.SVC_HMAC_MAX_SKEW_SECS || 60),
    keyHeader = 'x-svc-keyid',
    timestampHeader = 'x-svc-timestamp',
    sigHeader = 'x-svc-signature',
    bodyHashHeader = 'x-svc-body-hash',
    scopeHeader = 'x-svc-scope'
  } = options;

  return (req, res, next) => {
    try {
      const keyId = String(req.headers[keyHeader] || '');
      const tsStr = String(req.headers[timestampHeader] || '');
      const providedSig = String(req.headers[sigHeader] || '');
      const providedBodyHash = String(req.headers[bodyHashHeader] || '');
      const scopeStr = String(req.headers[scopeHeader] || '');
      const contentLength = Number(req.headers['content-length'] || 0);

      if (!keyId || !tsStr || !providedSig) {
        return res.status(401).json({ error: 'Missing HMAC headers' });
      }

      const secret = KEY_MAP[keyId];
      if (!secret) {
        return res.status(401).json({ error: 'Unknown HMAC key' });
      }

      // Timestamp check
      const now = Math.floor(Date.now() / 1000);
      const ts = Number(tsStr);
      if (!Number.isFinite(ts)) {
        return res.status(401).json({ error: 'Invalid timestamp' });
      }
      if (Math.abs(now - ts) > maxSkewSeconds) {
        return res.status(401).json({ error: 'Stale request' });
      }

      // Enforce body-hash presence when body exists (prevents body tampering if rawBody is not captured)
      if (contentLength > 0 && !providedBodyHash) {
        return res.status(401).json({ error: 'Missing body hash' });
      }

      // Compute body hash check if raw body is available
      if (req.rawBody !== undefined) {
        const actualBodyHash = sha256Hex(req.rawBody);
        if (providedBodyHash && !timingSafeEqualStr(providedBodyHash, actualBodyHash)) {
          return res.status(401).json({ error: 'Body hash mismatch' });
        }
      }

      // Build canonical elements
      const method = req.method || 'GET';
      const path = ((req.baseUrl || '') + (req.path || '/')) || '/';
      const queryString = buildSortedQueryString(req.query);
      const bodyHashHex = providedBodyHash || (req.rawBody ? sha256Hex(req.rawBody) : '');

      const expectedSig = computeSignature({ method, path, queryString, bodyHashHex, timestamp: ts, keyId, secret });
      if (!timingSafeEqualStr(providedSig, expectedSig)) {
        return res.status(401).json({ error: 'Bad signature' });
      }

      // Determine effective scopes: prefer server-defined map; fallback to header
      let effectiveScopes = [];
      let scopeSource = 'header';
      if (ALLOWED_SCOPES_MAP && Array.isArray(ALLOWED_SCOPES_MAP[keyId])) {
        effectiveScopes = ALLOWED_SCOPES_MAP[keyId].filter(Boolean);
        scopeSource = 'server';
      } else {
        effectiveScopes = scopeStr ? scopeStr.split(' ').filter(Boolean) : [];
      }

      // Scope check (optional)
      if (requiredScopes.length > 0) {
        const tokenScopes = new Set(effectiveScopes);
        const ok = requiredScopes.every(s => tokenScopes.has(s));
        if (!ok) return res.status(403).json({ error: 'Insufficient scope' });
      }

      // Attach minimal context
      req.serviceAuth = {
        keyId,
        scopes: effectiveScopes,
        scopeSource
      };

      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid HMAC request' });
    }
  };
}

/**
 * Optional raw body capture helper.
 * If you want body-hash verification without changing your JSON parser,
 * you can use the X-Svc-Body-Hash header. If you also want the server to
 * verify that hash against the actual raw body, place this BEFORE express.json().
 */
function captureRawBody(req, res, next) {
  // Skip if already populated (e.g., by other middleware)
  if (req.rawBody !== undefined) return next();
  // Only capture for methods that may carry a body
  const mayHaveBody = !['GET', 'HEAD'].includes((req.method || 'GET').toUpperCase());
  if (!mayHaveBody) return next();
  let chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    try {
      req.rawBody = Buffer.concat(chunks).toString('utf8');
    } catch (_) {
      req.rawBody = '';
    }
    next();
  });
}

module.exports = {
  serviceHmac,
  captureRawBody
};


