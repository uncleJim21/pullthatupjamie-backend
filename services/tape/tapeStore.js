/**
 * Pluggable cache + counter store for /api/tape/*.
 *
 * Interface (used by every handler — never branch on backend in handlers):
 *   getJSON(key)                 -> Promise<value|null>
 *   setJSON(key, value, ttlSec)  -> Promise<void>     (stamps cachedAt alongside)
 *   incrWindow(key, ttlSec)      -> Promise<number>   (rate-limit counter)
 *   addAndGet(key, n, ttlSec)    -> Promise<number>   (running total, e.g. daily cap)
 *
 * Backend selection:
 *   - REDIS_URL set  -> Redis adapter (lazy `require('ioredis')`, so the dep is
 *                       only needed when Redis is actually enabled).
 *   - otherwise      -> in-process Map + TTL (zero infra; fine for the demo,
 *                       per-container under autoscale).
 *
 * Values are stored as `{ v, cachedAt }` so callers can reconstruct the
 * freshness `_meta` block on a cache hit.
 */

const { printLog } = require('../../constants');

const nowIso = () => new Date().toISOString();

// ----------------------------------------------------------------------------
// In-memory backend
// ----------------------------------------------------------------------------
function createMemoryStore() {
  const cache = new Map();    // key -> { value, expiresAt }
  const counters = new Map(); // key -> { count, expiresAt }

  // Periodic sweep so abandoned keys don't leak. Unref so it never holds the
  // process open.
  const sweep = setInterval(() => {
    const t = Date.now();
    for (const [k, e] of cache) if (e.expiresAt <= t) cache.delete(k);
    for (const [k, e] of counters) if (e.expiresAt <= t) counters.delete(k);
  }, 60_000);
  if (typeof sweep.unref === 'function') sweep.unref();

  return {
    backend: 'memory',
    async getJSON(key) {
      const e = cache.get(key);
      if (!e) return null;
      if (e.expiresAt <= Date.now()) { cache.delete(key); return null; }
      return e.value;
    },
    async setJSON(key, value, ttlSec) {
      cache.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    },
    async incrWindow(key, ttlSec) {
      const t = Date.now();
      const e = counters.get(key);
      if (!e || e.expiresAt <= t) {
        counters.set(key, { count: 1, expiresAt: t + ttlSec * 1000 });
        return 1;
      }
      e.count += 1;
      return e.count;
    },
    async addAndGet(key, n, ttlSec) {
      const t = Date.now();
      const e = counters.get(key);
      if (!e || e.expiresAt <= t) {
        counters.set(key, { count: n, expiresAt: t + ttlSec * 1000 });
        return n;
      }
      e.count += n;
      return e.count;
    },
  };
}

// ----------------------------------------------------------------------------
// Redis backend (opt-in)
// ----------------------------------------------------------------------------
function createRedisStore(url) {
  // eslint-disable-next-line global-require, import/no-unresolved
  const Redis = require('ioredis'); // only loaded when REDIS_URL is set
  const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  client.on('error', (err) => printLog(`[tapeStore] redis error: ${err.message}`));

  return {
    backend: 'redis',
    async getJSON(key) {
      const raw = await client.get(key);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (_) { return null; }
    },
    async setJSON(key, value, ttlSec) {
      await client.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.ceil(ttlSec)));
    },
    async incrWindow(key, ttlSec) {
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, Math.max(1, Math.ceil(ttlSec)));
      return count;
    },
    async addAndGet(key, n, ttlSec) {
      const total = await client.incrby(key, n);
      // Set expiry once (when the key is first created). incrby on a fresh key
      // returns n; treat that as "first write" and stamp the TTL.
      if (total === n) await client.expire(key, Math.max(1, Math.ceil(ttlSec)));
      return total;
    },
  };
}

// ----------------------------------------------------------------------------
// Selection
// ----------------------------------------------------------------------------
let store;
if (process.env.REDIS_URL) {
  try {
    store = createRedisStore(process.env.REDIS_URL);
    printLog('[tapeStore] using Redis backend (REDIS_URL set)');
  } catch (err) {
    console.warn(`[tapeStore] REDIS_URL set but Redis init failed (${err.message}); ` +
      `falling back to in-memory. Did you \`npm i ioredis\`?`);
    store = createMemoryStore();
  }
} else {
  store = createMemoryStore();
  printLog('[tapeStore] using in-memory backend (no REDIS_URL)');
}

/**
 * Cache helper that stamps cachedAt with the stored value and returns it on
 * read so freshness `_meta` can be reconstructed.
 *
 *   setCached(key, value, ttlSec) -> stores { v: value, cachedAt }
 *   getCached(key)                -> { value, cachedAt } | null
 */
async function setCached(key, value, ttlSec) {
  await store.setJSON(key, { v: value, cachedAt: nowIso() }, ttlSec);
}
async function getCached(key) {
  const wrapped = await store.getJSON(key);
  if (!wrapped || typeof wrapped !== 'object') return null;
  return { value: wrapped.v, cachedAt: wrapped.cachedAt || nowIso() };
}

module.exports = {
  store,
  backend: store.backend,
  setCached,
  getCached,
  // raw passthroughs for counters / caps
  incrWindow: (...a) => store.incrWindow(...a),
  addAndGet: (...a) => store.addAndGet(...a),
};
