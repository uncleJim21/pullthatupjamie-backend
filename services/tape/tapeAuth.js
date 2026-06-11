/**
 * Tape access control (v2 — accounts-only).
 *
 * There is NO Tape-specific login and NO shared password. Real users
 * authenticate with their MAIN-APP JWT (from the separate auth server) sent on
 * every /api/tape/* request; `requireTapeAuth` resolves identity via the app's
 * shared `resolveIdentity` and requires an admin-granted `tape-basic-user`
 * entitlement. Grant via scripts/grant-tape-access.js or the admin entitlements
 * endpoint.
 *
 * Env:
 *   TAPE_TEST_AUTH   — dev/eval ONLY. When 'true', requireTapeAuth also accepts a
 *                      locally-minted test token (signTapeToken) so the eval
 *                      harness can hit the routes without a real account. Never
 *                      set this in production.
 *   TAPE_AUTH_SECRET — HS256 key used only to sign/verify the dev test token.
 */

const jwt = require('jsonwebtoken');
const { tapeError } = require('./tapeErrors');
const { resolveIdentity } = require('../../utils/identityResolver');

const TAPE_ENTITLEMENT = 'tape-basic-user';
const USER_SCOPE = 'tape-user';
const TTL_DAYS = parseInt(process.env.TAPE_AUTH_TTL_DAYS || '30', 10);

function signingSecret() { return process.env.TAPE_AUTH_SECRET || ''; }
function testAuthEnabled() { return process.env.TAPE_TEST_AUTH === 'true'; }

/**
 * DEV/EVAL ONLY: mint a local Tape test token. Accepted by requireTapeAuth only
 * when TAPE_TEST_AUTH==='true'. Not a product auth path.
 */
function signTapeToken({ sub = 'tape-test' } = {}) {
  const secret = signingSecret();
  if (!secret) throw new Error('TAPE_AUTH_SECRET is not configured');
  const expiresInSec = Math.max(1, TTL_DAYS) * 86_400;
  const token = jwt.sign({ sub, scope: USER_SCOPE, test: true }, secret, { algorithm: 'HS256', expiresIn: expiresInSec });
  return { token, expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(), scope: USER_SCOPE, sub };
}

/**
 * Strict, admin-granted access gate: an ACTIVE `tape-basic-user` Entitlement must
 * already exist for the user. We do NOT use checkEntitlementEligibility() (it
 * auto-initializes, which would grant everyone) — only an explicit grant counts.
 * Not metered: presence = access.
 */
async function hasTapeAccess(userId) {
  if (!userId || !/^[a-f0-9]{24}$/i.test(String(userId))) return false;
  try {
    // eslint-disable-next-line global-require
    const { Entitlement } = require('../../models/Entitlement');
    const rec = await Entitlement.findOne({
      identifier: String(userId),
      identifierType: 'mongoUserId',
      entitlementType: TAPE_ENTITLEMENT,
      status: 'active',
    }).lean();
    return !!rec;
  } catch (_) {
    return false; // fail-closed
  }
}

/**
 * Express middleware: authenticate the request and require Tape entitlement.
 * Product path: main-app JWT (via resolveIdentity) + `tape-basic-user`.
 * Sets `req.tape = { sub: userId, scope: 'tape-user' }`.
 */
async function requireTapeAuth(req, res, next) {
  try {
    // Dev/eval bypass (off by default; never in prod).
    if (testAuthEnabled()) {
      const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      if (m) {
        try {
          const p = jwt.verify(m[1], signingSecret(), { algorithms: ['HS256'] });
          if (p && p.test) { req.tape = { sub: p.sub, scope: USER_SCOPE, test: true }; return next(); }
        } catch (_) { /* not a test token — fall through to real auth */ }
      }
    }

    // Product auth: main-app JWT + tape-basic-user entitlement.
    const identity = await resolveIdentity(req);
    if (!identity || !identity.user) {
      return tapeError(res, 401, 'auth-failed', 'Missing or invalid auth token');
    }
    const userId = identity.identifier; // user._id string
    if (!(await hasTapeAccess(userId))) {
      return tapeError(res, 403, 'not-entitled', 'Tape access is not enabled for this account');
    }
    req.tape = { sub: userId, scope: USER_SCOPE, user: identity.user };
    return next();
  } catch (err) {
    return tapeError(res, 500, 'auth-misconfigured', 'Auth check failed', err.message);
  }
}

module.exports = { requireTapeAuth, hasTapeAccess, signTapeToken, TAPE_ENTITLEMENT, USER_SCOPE };
