// utils/mongoConnect.js
//
// Fail-safe MongoDB startup. Mongoose does NOT retry a failed *initial*
// connect: if Atlas is unreachable at boot (IP allowlist lapse, paused
// cluster, DNS blip) the app used to sit half-dead forever — HTTP up,
// /health "ok", every DB call buffering 10s then throwing. This module:
//   - retries the initial connect with capped exponential backoff, forever
//   - tracks connection state so /health and the /api gate can explain it
//   - exposes requireDb(), an express gate that answers 503 immediately
//     instead of letting requests hang on Mongoose's buffer timeout
const mongoose = require('mongoose');

const state = {
  attempts: 0,
  connectedAt: null,
  lastError: null,
  lastErrorAt: null,
  nextRetryAt: null,
};
let listenersAttached = false;

const READY = ['disconnected', 'connected', 'connecting', 'disconnecting'];

function dbReady() {
  return mongoose.connection.readyState === 1;
}

function dbSnapshot() {
  const rs = mongoose.connection.readyState;
  return {
    status: READY[rs] || String(rs),
    readyState: rs,
    attempts: state.attempts,
    connectedAt: state.connectedAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    nextRetryAt: state.nextRetryAt,
  };
}

function attachListeners(log) {
  if (listenersAttached) return;
  listenersAttached = true;
  const c = mongoose.connection;
  c.on('error', (err) => {
    state.lastError = err?.message || String(err);
    state.lastErrorAt = new Date();
    log.error(`[mongo] connection error: ${state.lastError}`);
  });
  c.on('disconnected', () => log.warn('[mongo] disconnected — driver will auto-reconnect'));
  c.on('reconnected', () => log.log('[mongo] reconnected'));
}

/**
 * Connect, retrying forever on failure. Resolves once connected.
 * Backoff: base * 2^(attempt-1), capped at maxDelayMs (1s,2s,4s…30s).
 * `connect` / `sleep` are injectable so the loop is unit-testable.
 */
async function connectWithRetry(uri, opts = {}) {
  const {
    connect = (u, o) => mongoose.connect(u, o),
    options = {},
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = console,
  } = opts;
  if (!uri) throw new Error('connectWithRetry: no MongoDB URI provided (check MONGO_URI)');
  attachListeners(log);

  state.attempts = 0; // per connect() call — a later reconnect must not inherit an old backoff
  for (;;) {
    state.attempts += 1;
    try {
      await connect(uri, { serverSelectionTimeoutMS: 10000, ...options });
      state.connectedAt = new Date();
      state.nextRetryAt = null;
      state.lastError = null; // don't show a stale boot error next to status: connected
      state.lastErrorAt = null;
      log.log(`[mongo] connected (attempt ${state.attempts})`);
      return;
    } catch (err) {
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(state.attempts - 1, 30));
      state.lastError = err?.message || String(err);
      state.lastErrorAt = new Date();
      state.nextRetryAt = new Date(Date.now() + delay);
      log.error(`[mongo] connect attempt ${state.attempts} failed: ${state.lastError} — retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

/** Express gate: 503 with a specific body while the DB is not connected. */
function requireDb(req, res, next) {
  if (dbReady()) return next();
  res.set('Retry-After', '5');
  return res.status(503).json({
    error: 'database_unavailable',
    message: 'MongoDB is not connected; the server is retrying in the background.',
    db: dbSnapshot(),
  });
}

module.exports = { connectWithRetry, dbReady, dbSnapshot, requireDb };
