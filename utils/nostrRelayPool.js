/**
 * nostrRelayPool
 *
 * Shared relay pool + round-robin rotation for the Nostr bot's
 * mention and zap watchers.
 *
 * Why rotate instead of polling all relays every tick? Polling a large
 * relay set on every cycle opens a fresh subscription to each relay
 * every few seconds — exactly the behavior relays rate-limit or ban.
 * Instead we keep a pool of high-quality relays and, each tick, poll
 * only a small rotating slice. Over a full rotation every relay is
 * swept, but any single relay sees us only once per rotation.
 *
 * Cadence math (defaults): pool = 12, slice = 3, tick = 15s →
 *   - the system touches 3 fresh relays every 15s (low detection TTL),
 *   - each individual relay is polled once every 12/3 = 4 ticks = 60s
 *     (gentle; never worse than the per-relay floor).
 * The watcher's lookback window (600s) far exceeds the 60s revisit
 * gap, so nothing is missed between a relay's polls — duplicates are
 * absorbed by the eventId unique index.
 *
 * NOTE: mention and zap watchers each own an independent rotation, so a
 * given relay may be hit by both — once/60s for mentions and once/60s
 * for zaps, i.e. ~once/30s aggregate worst case. Still within a polite
 * per-relay budget.
 *
 * The pool below is the tunable part — vet/adjust relay membership as
 * relay reliability changes. The rotation mechanism is independent of
 * which relays are in it.
 */

// 12 high-quality public relays. The first six are where this bot's
// users' clients (Primal Web, Damus, Amethyst, Ditto) actually publish
// — observed directly in the `r` relay-hint tags of real mentions.
const RELAY_POOL = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr.oxtr.dev',
  'wss://nostr.wine',
  'wss://relay.nostrplebs.com',
  'wss://nostr.einundzwanzig.space',
  'wss://nostr.sidnlabs.nl',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr.mom',
  'wss://relay.nostr.bg',
];

// How many relays to poll per tick. With a 12-relay pool and a 15s
// tick, slice=3 gives a 60s per-relay revisit interval.
const DEFAULT_SLICE_SIZE = (() => {
  const raw = parseInt(process.env.NOSTR_BOT_RELAY_SLICE_SIZE, 10);
  if (Number.isFinite(raw) && raw >= 1) return raw;
  return 3;
})();

// Per-relay query timeout for a rotated slice. Kept below the tick
// interval so a slow/dead relay in the slice can't push a tick past the
// next scheduled poll (the poll loop skips re-entrant ticks).
const DEFAULT_SLICE_QUERY_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.NOSTR_BOT_RELAY_SLICE_TIMEOUT_MS, 10);
  if (Number.isFinite(raw) && raw >= 1000) return raw;
  return 8000;
})();

/**
 * Stateful round-robin selector over a relay list. One instance per
 * watcher; the cursor persists across poll() calls for the life of the
 * process and resets harmlessly on restart.
 */
class RelayRotation {
  constructor(options = {}) {
    const relays = Array.isArray(options.relays) && options.relays.length > 0
      ? options.relays
      : RELAY_POOL;
    this.relays = relays;
    const requested = Number.isFinite(options.sliceSize) ? options.sliceSize : DEFAULT_SLICE_SIZE;
    // Never ask for more relays than the pool holds.
    this.sliceSize = Math.max(1, Math.min(requested, relays.length));
    this.cursor = 0;
  }

  /**
   * Return the next slice of relays, advancing (and wrapping) the
   * cursor. Wraps cleanly even when sliceSize does not divide the pool
   * size evenly — the next slice simply continues from where this one
   * ended.
   */
  next() {
    const out = [];
    for (let i = 0; i < this.sliceSize; i++) {
      out.push(this.relays[(this.cursor + i) % this.relays.length]);
    }
    this.cursor = (this.cursor + this.sliceSize) % this.relays.length;
    return out;
  }

  /** Total relays in the pool (for logging). */
  get poolSize() {
    return this.relays.length;
  }
}

module.exports = {
  RELAY_POOL,
  RelayRotation,
  DEFAULT_SLICE_SIZE,
  DEFAULT_SLICE_QUERY_TIMEOUT_MS,
};
