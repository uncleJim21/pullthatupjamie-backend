/**
 * Ticker provider for the daily Read-In cache warmer.
 *
 * getWarmTickers() returns an ORDERED list of tickers, most-likely-picked first:
 *   1. config/tape-hot-tickers.yaml `priority`, in listed order, kept only where a
 *      company card exists (priority is a preference order, not an allowlist).
 *   2. the remaining carded tickers by market cap, descending.
 * Deduped, so each ticker appears once. The warmer slices this to its cost/count cap.
 *
 * Tying the universe to the carded set keeps warming to known names (Read-In leans
 * on card context) and auto-tracks the card list as it grows.
 *
 * FUTURE personalization seam (memory project-tape-future-ideas #3): getWarmTickers
 * accepts an optional `{ userId }`; a per-user watchlist would be prepended ahead of
 * the generic order here, with no change to the warmer. Generic order stays the
 * baseline/fallback.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const HOT = path.join(__dirname, '..', '..', 'config', 'tape-hot-tickers.yaml');
const CARDS = path.join(__dirname, '..', '..', 'config', 'tape-company-cards.yaml');

function loadYaml(p) {
  try { return yaml.load(fs.readFileSync(p, 'utf8')) || {}; } catch (_) { return {}; }
}

/**
 * @param {{ userId?: string }} [opts] reserved for future per-user ordering (unused today)
 * @returns {string[]} ordered, deduped ticker symbols
 */
function getWarmTickers(_opts = {}) {
  const cards = loadYaml(CARDS);
  const carded = Object.keys(cards);
  const cardedSet = new Set(carded);

  const hot = loadYaml(HOT);
  const priority = Array.isArray(hot.priority) ? hot.priority.map(String) : [];

  const ordered = [];
  const seen = new Set();
  const push = (t) => { if (t && cardedSet.has(t) && !seen.has(t)) { seen.add(t); ordered.push(t); } };

  // 1) curated priority, in order (skips any non-carded names)
  for (const t of priority) push(t);

  // 2) remaining carded tickers by market cap, descending
  const tail = carded
    .filter((t) => !seen.has(t))
    .map((t) => ({ t, mc: Number(cards[t]?.marketCap || cards[t]?.marketcap || 0) }))
    .sort((a, b) => b.mc - a.mc);
  for (const { t } of tail) push(t);

  return ordered;
}

/**
 * Deduped union of every persona-user's `tapePersonaSignals.tickers`, validated
 * against the carded universe. This is what makes "their stuff is hydrated" work
 * WITHOUT per-user cost: the warmer prepends this union to the generic order and
 * warms each into the SHARED cache once — so coverage scales with the breadth of
 * collective interest, not the user count. Resilient: returns [] on any error.
 */
async function getPersonaUnionTickers() {
  try {
    // eslint-disable-next-line global-require
    const { User } = require('../../models/shared/UserSchema');
    const cardedSet = new Set(Object.keys(loadYaml(CARDS)));
    const users = await User
      .find({ 'app_preferences.data.tapePersonaSignals.tickers.0': { $exists: true } })
      .select('+app_preferences')
      .lean();
    const set = new Set();
    for (const u of users) {
      const t = u && u.app_preferences && u.app_preferences.data
        && u.app_preferences.data.tapePersonaSignals
        && u.app_preferences.data.tapePersonaSignals.tickers;
      if (Array.isArray(t)) {
        for (const sym of t) {
          const s = String(sym || '').toUpperCase().trim();
          if (s && cardedSet.has(s)) set.add(s);
        }
      }
    }
    return [...set];
  } catch (_) {
    return [];
  }
}

module.exports = { getWarmTickers, getPersonaUnionTickers };
