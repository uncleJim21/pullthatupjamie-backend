/**
 * Two-tier freshness policy + "last updated" metadata for /api/tape/*.
 *
 * Single source of truth for *how stale data may be* and *how that staleness
 * is reported*, so no handler invents its own TTL.
 *
 *   QUANTITATIVE — ticker prices. Cache TTL is short (60s open / 5m closed);
 *                  the 1-hour ceiling governs the stale-fallback path.
 *   QUALITATIVE  — podcast quotes + synthesized editorial. Cached up to
 *                  3 business days (skips weekends).
 *
 * Defaults encode the finance-professional standard and are env-overridable.
 */

const QUAL_TTL_BUSINESS_DAYS = parseInt(process.env.TAPE_QUAL_TTL_BUSINESS_DAYS || '3', 10);
const QUANT_MAX_AGE_SEC = parseInt(process.env.TAPE_QUANT_MAX_AGE_SEC || '3600', 10);
const QUOTE_TTL_OPEN_SEC = parseInt(process.env.TAPE_QUOTE_TTL_OPEN_SEC || '60', 10);
const QUOTE_TTL_CLOSED_SEC = parseInt(process.env.TAPE_QUOTE_TTL_CLOSED_SEC || '300', 10);
const SYN_TTL_DAYS = parseInt(process.env.TAPE_SYN_TTL_DAYS || '30', 10);

const TIER = { QUANTITATIVE: 'quantitative', QUALITATIVE: 'qualitative' };

/**
 * Seconds from `now` until `n` business days have elapsed. Counts forward over
 * weekdays only — a Friday result naturally lives through the weekend.
 *
 * @param {number} n          number of business days
 * @param {Date} [now=new Date()]
 * @returns {number} seconds
 */
function businessDaysToSeconds(n, now = new Date()) {
  const target = new Date(now.getTime());
  let added = 0;
  while (added < n) {
    target.setDate(target.getDate() + 1);
    const day = target.getDay(); // 0 = Sun, 6 = Sat
    if (day !== 0 && day !== 6) added += 1;
  }
  return Math.max(1, Math.round((target.getTime() - now.getTime()) / 1000));
}

/** Is the US equity market open right now? (9:30–16:00 ET, Mon–Fri.) */
function isUsMarketOpen(now = new Date()) {
  // Convert to ET via Intl; robust across server timezones / DST.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/** Cache TTL for a price quote, depending on market hours. */
function quantTtlSec({ marketOpen } = {}) {
  const open = typeof marketOpen === 'boolean' ? marketOpen : isUsMarketOpen();
  return open ? QUOTE_TTL_OPEN_SEC : QUOTE_TTL_CLOSED_SEC;
}

/** Cache TTL for qualitative (quote/editorial) responses. */
function qualTtlSec(now = new Date()) {
  return businessDaysToSeconds(QUAL_TTL_BUSINESS_DAYS, now);
}

/** Cache TTL for content-addressed synthesis output. */
function synTtlSec() {
  return Math.max(1, SYN_TTL_DAYS) * 86_400;
}

/** Hard staleness ceiling for prices (seconds). */
function quantMaxAgeSec() {
  return QUANT_MAX_AGE_SEC;
}

/**
 * Build the uniform `_meta` "last updated" block merged into every response.
 *
 * `ageSec` / `freshUntil` are derived at read time so they're correct on cache
 * hits, not frozen at write time.
 *
 * @param {object} opts
 * @param {string} opts.tier               TIER.* value
 * @param {Date|string} opts.cachedAt      when the payload entered the cache
 * @param {Date|string} [opts.fetchedAt]   when the underlying data was produced
 * @param {number} opts.ttlSec             cache TTL used for this payload
 * @param {boolean} [opts.cached=false]
 * @param {boolean} [opts.revalidated=false]
 * @param {boolean} [opts.stale=false]
 * @param {string} [opts.staleReason=null]
 * @param {Date} [opts.now=new Date()]
 */
function buildFreshnessMeta({
  tier,
  cachedAt,
  fetchedAt,
  ttlSec,
  cached = false,
  revalidated = false,
  stale = false,
  staleReason = null,
  now = new Date(),
}) {
  const cachedAtMs = cachedAt ? new Date(cachedAt).getTime() : now.getTime();
  const fetchedAtMs = fetchedAt ? new Date(fetchedAt).getTime() : cachedAtMs;
  const ageSec = Math.max(0, Math.round((now.getTime() - cachedAtMs) / 1000));
  const freshUntil = Number.isFinite(ttlSec)
    ? new Date(cachedAtMs + ttlSec * 1000).toISOString()
    : null;

  return {
    cached,
    revalidated,
    tier: tier || null,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    cachedAt: new Date(cachedAtMs).toISOString(),
    ageSec,
    freshUntil,
    stale,
    staleReason: stale ? (staleReason || 'stale') : null,
  };
}

module.exports = {
  TIER,
  businessDaysToSeconds,
  isUsMarketOpen,
  quantTtlSec,
  qualTtlSec,
  synTtlSec,
  quantMaxAgeSec,
  buildFreshnessMeta,
};
