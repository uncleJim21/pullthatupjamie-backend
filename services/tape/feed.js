/**
 * Personalized "for you" feed (GET /api/tape/feed).
 *
 * Pure selection/ranking over SHARED content — no synthesis, no LLM on the
 * request. Ranks recommended tickers + curated Brief topics by overlap with the
 * user's tapePersonaSignals. Each ticker carries `ready` = is its shared Read-In
 * actually cached right now (instant on click). Empty persona → the generic order.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { getWarmTickers } = require('./warmTickers');
const { getTapePersona } = require('./persona');
const { getCached } = require('./tapeStore');
const { kindCacheKey } = require('./tapeEndpoint');

const TOPICS_PATH = path.join(__dirname, '..', '..', 'config', 'tape-brief-topics.yaml');
const CARDS_PATH = path.join(__dirname, '..', '..', 'config', 'tape-company-cards.yaml');

const LIM_T = parseInt(process.env.TAPE_FEED_TICKERS || '12', 10);
const LIM_B = parseInt(process.env.TAPE_FEED_BRIEFS || '8', 10);

let _topics; let _names;
function topics() {
  if (!_topics) { try { _topics = (yaml.load(fs.readFileSync(TOPICS_PATH, 'utf8')) || {}).topics || []; } catch (_) { _topics = []; } }
  return _topics;
}
function nameMap() {
  if (!_names) {
    _names = {};
    try {
      const c = yaml.load(fs.readFileSync(CARDS_PATH, 'utf8')) || {};
      for (const [t, v] of Object.entries(c)) _names[t] = (v && v.name) || t;
    } catch (_) { _names = {}; }
  }
  return _names;
}

// Phrase match with word boundaries so short tokens don't false-positive
// (e.g. topic "cre" must NOT match persona "credit spreads"). Exact, or the
// shorter phrase appears in the longer as a whole word/phrase.
function phraseMatch(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3) return false;
  const esc = short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${esc}(\\s|$)`).test(long);
}

function rankTopics(signals) {
  const themes = (signals && signals.themes) || [];
  const tickerSet = new Set((signals && signals.tickers) || []);
  return topics()
    .map((tp, idx) => {
      const tThemes = (tp.themes || []).map((s) => String(s).toLowerCase());
      const tTickers = (tp.tickers || []).map((s) => String(s).toUpperCase());
      const matched = [];
      let hits = 0;
      for (const th of themes) {
        if (tThemes.some((x) => phraseMatch(x, th))) { hits += 2; matched.push(th); }
      }
      for (const sym of tTickers) if (tickerSet.has(sym)) { hits += 1; matched.push(sym); }
      return { title: tp.title, query: tp.query, score: hits, matched: [...new Set(matched)], idx };
    })
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .slice(0, LIM_B)
    .map((t) => ({ title: t.title, query: t.query, personalized: t.score > 0, ...(t.matched.length ? { matched: t.matched } : {}) }));
}

/**
 * @param {{ userId?: string }} opts  userId = req.tape.sub (real id for tape-user)
 * @returns {Promise<{personaApplied:boolean, tickers:object[], briefs:object[]}>}
 */
async function buildFeed({ userId } = {}) {
  const p = await getTapePersona(userId);
  const signals = (p && p.signals) || null;
  const generic = getWarmTickers();            // full carded universe, generic order
  const cardedSet = new Set(generic);
  const names = nameMap();

  // Order: persona tickers (carded) first, then generic to fill.
  const ordered = [];
  const seen = new Set();
  const add = (sym, reason) => {
    const s = String(sym).toUpperCase();
    if (s && cardedSet.has(s) && !seen.has(s)) { seen.add(s); ordered.push({ ticker: s, name: names[s] || s, reason }); }
  };
  if (signals && Array.isArray(signals.tickers)) for (const t of signals.tickers) add(t, 'persona');
  for (const t of generic) add(t, 'generic');

  const top = ordered.slice(0, LIM_T);
  // `ready` = the shared Read-In is actually cached right now (instant on click).
  await Promise.all(top.map(async (item) => {
    try { item.ready = !!(await getCached(kindCacheKey('readin', { ticker: item.ticker }))); }
    catch (_) { item.ready = false; }
  }));

  return {
    personaApplied: !!(signals && ((signals.tickers || []).length || (signals.themes || []).length)),
    tickers: top,
    briefs: rankTopics(signals),
  };
}

module.exports = { buildFeed };
