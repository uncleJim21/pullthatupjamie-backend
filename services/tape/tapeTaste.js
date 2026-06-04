/**
 * Editorial taste config loader + helpers (spec §6).
 *
 * Loads config/tape-taste.yaml at startup and lazily reloads when the file's
 * mtime changes (cheap stat on each access) — no restart / SIGHUP wiring.
 *
 * Exposes:
 *   isMainstream(creator)        -> boolean
 *   isDedicated(title, name)     -> boolean
 *   scoreConfidence(signals)     -> { score, tier }
 *   classifyBullBear(text)       -> 'bull' | 'bear' | 'neutral'
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { printLog } = require('../../constants');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'tape-taste.yaml');

let cached = null;
let cachedMtimeMs = 0;

const DEFAULTS = {
  mainstream_allow: [],
  mainstream_deny: [],
  dedicated_match: 'last-name',
  confidence_signals: {
    dedicated_weight: 0.4, mainstream_weight: 0.3, span_weight: 0.3,
    high_min: 0.7, medium_min: 0.4,
  },
  bull_keywords: [],
  bear_keywords: [],
};

function load() {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch (_) {
    if (!cached) { printLog('[tapeTaste] config file missing — using defaults'); cached = { ...DEFAULTS }; }
    return cached;
  }
  if (cached && mtimeMs === cachedMtimeMs) return cached;
  try {
    const parsed = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
    cached = {
      ...DEFAULTS,
      ...parsed,
      confidence_signals: { ...DEFAULTS.confidence_signals, ...(parsed.confidence_signals || {}) },
      mainstream_allow: (parsed.mainstream_allow || []).map((s) => String(s).toLowerCase()),
      mainstream_deny: (parsed.mainstream_deny || []).map((s) => String(s).toLowerCase()),
      bull_keywords: (parsed.bull_keywords || []).map((s) => String(s).toLowerCase()),
      bear_keywords: (parsed.bear_keywords || []).map((s) => String(s).toLowerCase()),
    };
    cachedMtimeMs = mtimeMs;
    printLog(`[tapeTaste] loaded config (${cached.mainstream_allow.length} allow / ${cached.mainstream_deny.length} deny)`);
  } catch (err) {
    printLog(`[tapeTaste] failed to parse config (${err.message}) — keeping previous/defaults`);
    if (!cached) cached = { ...DEFAULTS };
  }
  return cached;
}

function isMainstream(creator) {
  const cfg = load();
  const c = String(creator || '').toLowerCase();
  if (!c) return false;
  if (cfg.mainstream_deny.some((d) => c.includes(d))) return false;
  return cfg.mainstream_allow.some((a) => c.includes(a));
}

/** Is `creator` one of the curated high-signal bitcoin-native shows? */
function isBitcoinAllowed(creator) {
  const cfg = load();
  const c = String(creator || '').toLowerCase();
  if (!c) return false;
  return (cfg.bitcoin_allow || []).some((a) => c.includes(a));
}

/** Does the topic concern bitcoin / hard-money themes? (admits bitcoin_allow shows) */
function isBitcoinRelevant(topic) {
  const cfg = load();
  const t = String(topic || '').toLowerCase();
  if (!t) return false;
  return (cfg.bitcoin_relevance_terms || []).some((term) => t.includes(term));
}

/**
 * Whether a candidate's `creator` is an acceptable source for this query.
 * Normal: mainstream allowlist (minus deny). When the topic is bitcoin-relevant,
 * the curated bitcoin-native shows (bitcoin_allow) are admitted too.
 */
function isAcceptableSource(creator, { bitcoinMode } = {}) {
  if (isMainstream(creator)) return true;
  if (bitcoinMode && isBitcoinAllowed(creator)) return true;
  return false;
}

function lastNameOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : '';
}

function isDedicated(title, name) {
  const cfg = load();
  const t = String(title || '').toLowerCase();
  const full = String(name || '').toLowerCase();
  if (!t || !full) return false;
  switch (cfg.dedicated_match) {
    case 'exact-title':
      return t.includes(full);
    case 'full-name':
      return t.includes(full);
    case 'last-name':
    default: {
      const ln = lastNameOf(name);
      return ln.length >= 2 && t.includes(ln);
    }
  }
}

/**
 * @param {object} signals
 * @param {boolean} signals.dedicated
 * @param {boolean} signals.mainstream
 * @param {number}  signals.spanRank   normalized 0..1 (longer span = higher)
 * @param {boolean} [signals.firstPerson]
 * @returns {{score:number, tier:'high'|'medium'|'low'}}
 */
function scoreConfidence({ dedicated, mainstream, spanRank = 0, firstPerson = false }) {
  const w = load().confidence_signals;
  let score =
    (dedicated ? w.dedicated_weight : 0) +
    (mainstream ? w.mainstream_weight : 0) +
    (Math.max(0, Math.min(1, spanRank)) * w.span_weight);
  if (firstPerson) score = Math.min(1, score + 0.05); // small nudge
  score = parseFloat(score.toFixed(3));
  let tier = 'low';
  if (score >= w.high_min) tier = 'high';
  else if (score >= w.medium_min) tier = 'medium';
  return { score, tier };
}

function classifyBullBear(text) {
  const cfg = load();
  const t = String(text || '').toLowerCase();
  const bull = cfg.bull_keywords.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
  const bear = cfg.bear_keywords.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
  if (bull > bear) return 'bull';
  if (bear > bull) return 'bear';
  return 'neutral';
}

module.exports = {
  isMainstream, isDedicated, scoreConfidence, classifyBullBear, lastNameOf, load,
  isBitcoinAllowed, isBitcoinRelevant, isAcceptableSource,
};
