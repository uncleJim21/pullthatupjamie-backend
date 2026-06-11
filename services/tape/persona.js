/**
 * Read a Tape user's persona + signals, with a small in-process TTL cache.
 *
 * Persona lives in User.app_preferences.data.{tapePersona,tapePersonaSignals}
 * (written by routes/appPreferencesRoutes.js). Tape endpoints resolve it per
 * request via req.tape.sub; the ~60s cache avoids a Mongo read on every kind
 * call while keeping persona edits near-immediate. invalidate() is called on
 * persona save so changes apply at once.
 */

const TTL_MS = parseInt(process.env.TAPE_PERSONA_TTL_MS || '60000', 10);
const cache = new Map(); // userId -> { value, exp }

const EMPTY_SIGNALS = { tickers: [], shows: [], themes: [] };

/**
 * @param {string} userId  the Tape JWT sub (real Mongo userId for tape-user)
 * @returns {Promise<{persona:string, signals:{tickers:string[],shows:string[],themes:string[]}}|null>}
 *   null for demo/anon or no persona set.
 */
async function getTapePersona(userId) {
  if (!userId || userId === 'tape-demo') return null;
  // Mongo ObjectIds are 24 hex chars; bail early on the demo sub or junk.
  if (!/^[a-f0-9]{24}$/i.test(String(userId))) return null;

  const hit = cache.get(userId);
  if (hit && hit.exp > Date.now()) return hit.value;

  let value = null;
  try {
    // eslint-disable-next-line global-require
    const { User } = require('../../models/shared/UserSchema');
    const user = await User.findById(userId).select('+app_preferences').lean();
    const data = (user && user.app_preferences && user.app_preferences.data) || {};
    if (data.tapePersona) {
      value = { persona: data.tapePersona, signals: { ...EMPTY_SIGNALS, ...(data.tapePersonaSignals || {}) } };
    }
  } catch (_) {
    value = null; // fail-open: no persona bias rather than erroring the request
  }
  cache.set(userId, { value, exp: Date.now() + TTL_MS });
  return value;
}

/** Drop a user's cached persona (call on persona save). */
function invalidatePersona(userId) {
  if (userId) cache.delete(userId);
}

module.exports = { getTapePersona, invalidatePersona, EMPTY_SIGNALS };
