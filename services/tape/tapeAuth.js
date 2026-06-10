/**
 * Tape demo auth (spec §1).
 *
 * One shared password, exchanged for a scoped HS256 JWT, globally revocable by
 * bumping a server-side `kid`. Independent of the main CASCDR_AUTH_SECRET.
 *
 * Env:
 *   TAPE_AUTH_PASSWORD  — the shared secret (string)
 *   TAPE_AUTH_SECRET    — HS256 signing key (32+ random bytes)
 *   TAPE_AUTH_KID       — current key id (e.g. "v1"). Bump to revoke all tokens.
 *   TAPE_AUTH_TTL_DAYS  — token lifetime (default 30)
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { tapeError } = require('./tapeErrors');

const SCOPE = 'tape-demo';
const TTL_DAYS = parseInt(process.env.TAPE_AUTH_TTL_DAYS || '30', 10);

function currentKid() { return process.env.TAPE_AUTH_KID || 'v1'; }
function signingSecret() { return process.env.TAPE_AUTH_SECRET || ''; }

/** Constant-time password comparison. */
function passwordMatches(provided) {
  const expected = process.env.TAPE_AUTH_PASSWORD || '';
  if (!expected) return false; // never accept when unconfigured
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Mint a scoped Tape JWT. Returns { token, expiresAt, scope }.
 */
function signTapeToken() {
  const secret = signingSecret();
  if (!secret) throw new Error('TAPE_AUTH_SECRET is not configured');
  const expiresInSec = Math.max(1, TTL_DAYS) * 86_400;
  const token = jwt.sign(
    { sub: SCOPE, scope: SCOPE, kid: currentKid() },
    secret,
    { algorithm: 'HS256', expiresIn: expiresInSec },
  );
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  return { token, expiresAt, scope: SCOPE };
}

/**
 * Express middleware enforcing a valid, current, in-scope Tape JWT.
 * Attaches `req.tape = { sub, scope }`.
 */
function requireTapeAuth(req, res, next) {
  const header = String(req.headers.authorization || '');
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return tapeError(res, 401, 'auth-failed', 'Missing or malformed Authorization header');
  }
  const secret = signingSecret();
  if (!secret) {
    return tapeError(res, 500, 'auth-misconfigured', 'Tape auth is not configured');
  }

  let payload;
  try {
    payload = jwt.verify(m[1], secret, { algorithms: ['HS256'] });
  } catch (err) {
    const expired = err && err.name === 'TokenExpiredError';
    return tapeError(res, 401, 'auth-failed',
      expired ? 'Token expired' : 'Invalid token');
  }

  // Revocation path: stale kid → reject.
  if (payload.kid !== currentKid()) {
    return tapeError(res, 401, 'auth-failed', 'Token revoked (stale key id)');
  }
  if (payload.scope !== SCOPE) {
    return tapeError(res, 401, 'auth-failed', 'Token out of scope');
  }

  req.tape = { sub: payload.sub || SCOPE, scope: payload.scope };
  return next();
}

module.exports = { signTapeToken, requireTapeAuth, passwordMatches, SCOPE };
