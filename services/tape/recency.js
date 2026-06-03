/**
 * Soft recency weighting for Tape candidate retrieval.
 *
 * Applied as a multiplicative decay against the existing relevance/ranking
 * score (span) during candidate ranking, before truncation to candidatesLimit:
 *
 *   weighted_score = base_score * exp(-age_months / half_life_months)
 *
 * A quote at 1 half-life keeps 50% of its score, 2 → 25%, 3 → 12.5%. Soft, not
 * a cutoff: an old quote survives if its base score is strong enough and no
 * newer candidate outranks it.
 *
 * Per-kind half-lives (the action's framing drives the strength of decay):
 *   brief   ~1 week   — "this week"; older is the wrong window
 *   readin  6 months  — business velocity; old quotes can be wrong about the co.
 *   split   6 months  — current debate
 *   dossier   18 months — positions evolve; older is biography
 *   arc       disabled  — the time dimension IS the point; full spread preserved
 *   narrative disabled  — drift-over-time analysis; needs the full window unweighted
 *
 * SCOPE: Tape recipe layer only. `searchQuotesService` / the /api/pull agent are
 * never touched — this weights candidates *after* the shared search returns.
 */

const MS_PER_MONTH = 30.44 * 24 * 3600 * 1000;

const HALF_LIFE_MONTHS = {
  brief: 7 / 30.44, // ~1 week
  readin: 6,
  split: 6,
  dossier: 18,
  arc: null, // disabled
  narrative: null, // disabled — Narrative analyses drift over the full window (spec §3.2)
};

const DEFAULT_HALF_LIFE_MONTHS = parseFloat(process.env.TAPE_DEFAULT_HALF_LIFE_MONTHS || '12');

// Undated candidates (corpus metadata lacks publishedDate) are unknown-age, so
// unknown-risk. Giving them a full factor of 1 lets them outrank fresh DATED
// quotes — worse than surfacing an old quote, since we can't even see the age.
// Treat them as ~one half-life old: below fresh dated, above stale dated.
const UNDATED_DECAY = parseFloat(process.env.TAPE_UNDATED_DECAY_FACTOR || '0.5');

/**
 * Resolve the half-life to apply. Precedence:
 *   disableRecencyWeighting → explicit halfLifeMonths → per-kind default → global default.
 * @returns {{ halfLifeMonths: number|null, disabled: boolean }}
 */
function resolveHalfLife({ kind, halfLifeMonths, disableRecencyWeighting } = {}) {
  if (disableRecencyWeighting === true) return { halfLifeMonths: null, disabled: true };
  if (Number.isFinite(halfLifeMonths) && halfLifeMonths > 0) {
    return { halfLifeMonths, disabled: false };
  }
  if (kind && Object.prototype.hasOwnProperty.call(HALF_LIFE_MONTHS, kind)) {
    const hl = HALF_LIFE_MONTHS[kind];
    return hl == null ? { halfLifeMonths: null, disabled: true } : { halfLifeMonths: hl, disabled: false };
  }
  return { halfLifeMonths: DEFAULT_HALF_LIFE_MONTHS, disabled: false };
}

/**
 * Decay multiplier in (0, 1]. 1 when weighting is disabled. Undated / unparseable
 * candidates get UNDATED_DECAY (unknown age ⇒ unknown risk; don't let them beat
 * fresh dated quotes).
 */
function decayFactor(publishedDate, halfLifeMonths, now = Date.now()) {
  if (!halfLifeMonths || halfLifeMonths <= 0) return 1; // disabled
  if (!publishedDate) return UNDATED_DECAY;
  const t = new Date(publishedDate).getTime();
  if (!Number.isFinite(t)) return UNDATED_DECAY;
  const ageMonths = Math.max(0, (now - t) / MS_PER_MONTH);
  return Math.exp(-ageMonths / halfLifeMonths);
}

/**
 * Re-rank candidates by base_score × recency decay (descending) without
 * mutating or leaking internal fields. `baseScoreFn(candidate)` defaults to the
 * existing span-based key so non-recency ordering is otherwise preserved.
 */
function rankByRecency(candidates, { halfLifeMonths, disabled }, baseScoreFn = (c) => c.spanSec || 0, now = Date.now()) {
  if (disabled) {
    return [...candidates].sort((a, b) => baseScoreFn(b) - baseScoreFn(a));
  }
  return candidates
    .map((c) => ({ c, w: baseScoreFn(c) * decayFactor(c.publishedDate, halfLifeMonths, now) }))
    .sort((a, b) => b.w - a.w)
    .map((x) => x.c);
}

/** Build the `_meta` recency block. */
function recencyMeta({ halfLifeMonths, disabled }) {
  return {
    halfLifeApplied: disabled ? null : Math.round(halfLifeMonths * 100) / 100,
    weightingDisabled: disabled,
  };
}

module.exports = {
  HALF_LIFE_MONTHS, DEFAULT_HALF_LIFE_MONTHS,
  resolveHalfLife, decayFactor, rankByRecency, recencyMeta,
};
