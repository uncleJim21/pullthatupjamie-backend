/**
 * person-quotes recipe (spec §2) — "best quotes BY this person on these topics".
 *
 * Powers Dossier, Arc, and the person side of Split. Composes corpus + search:
 *   resolve person -> appearances -> dedicated/mainstream filter ->
 *   search-quotes fan-out (guids × themes) -> dedup/span-sort -> confidence tag.
 */

const { searchQuotes } = require('../searchQuotesService');
const { findPeople, getPersonEpisodes } = require('../corpusService');
const taste = require('./tapeTaste');
const { TapeHttpError } = require('./tapeErrors');
const { candidateFromResult, validateDate } = require('./tapeShared');

const DEFAULTS = {
  guestsOnly: true,
  dedicatedOnly: true,
  mainstream: true,
  minSpan: 15,
  maxSpan: 120,
  episodesLimit: 6,
  quotesPerEpisode: 3,
  candidatesLimit: 25,
};

function firstPersonHeuristic(text) {
  const head = String(text || '').slice(0, 120).toLowerCase();
  return /\b(i|i'm|i've|my|we|we're|our)\b/.test(head);
}

/**
 * @param {object} input
 * @param {object} deps  { openai }
 * @returns {Promise<{body:object, underlying:object}>}
 */
async function personQuotes(input = {}, { openai } = {}) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new TapeHttpError(400, 'bad-request', 'Bad request', 'name is required');

  const f = { ...DEFAULTS, ...(input.filters || {}) };
  const minDate = validateDate(f.minDate, 'minDate');
  const maxDate = validateDate(f.maxDate, 'maxDate');
  const themes = Array.isArray(input.themes) && input.themes.length
    ? input.themes.filter((t) => typeof t === 'string' && t.trim())
    : [name];

  // Per-call usage accumulator for cost logging.
  const underlying = { peopleEpisodes: 0, searchQuotes: 0, helperTokens: 0 };
  const recordHelperLlmUsage = (_model, inTok = 0, outTok = 0) => {
    underlying.helperTokens += (inTok || 0) + (outTok || 0);
  };

  // 1. Resolve the person.
  const people = await findPeople({ search: name, guestsOnly: f.guestsOnly });
  const match = (people.data || [])[0];
  if (!match) {
    throw new TapeHttpError(404, 'person-not-found', 'Person not found',
      `No corpus match for "${name}"`);
  }
  const resolvedName = match.name;

  // 2. Appearances (fetch generously so filters have room).
  const epResp = await getPersonEpisodes({
    name: resolvedName,
    guestsOnly: f.guestsOnly,
    limit: Math.min(200, f.episodesLimit * 4),
  });
  if (epResp.error) throw new TapeHttpError(502, 'upstream-failure', 'Upstream failure', epResp.error);
  underlying.peopleEpisodes = (epResp.data || []).length;

  // 3 + 4. Dedicated + mainstream filters (default on).
  let episodes = epResp.data || [];
  if (f.dedicatedOnly) episodes = episodes.filter((e) => taste.isDedicated(e.title, resolvedName));
  if (f.mainstream) episodes = episodes.filter((e) => taste.isMainstream(e.feedTitle));
  episodes = episodes.slice(0, f.episodesLimit);

  const dedicatedGuids = new Set(episodes.filter((e) => taste.isDedicated(e.title, resolvedName)).map((e) => e.guid));

  // 5. Fan out search-quotes across guids × themes.
  const tasks = [];
  for (const ep of episodes) {
    for (const theme of themes) {
      tasks.push(
        searchQuotes(
          { query: theme, guids: [ep.guid], minDate, maxDate, limit: f.quotesPerEpisode },
          { openai, recordHelperLlmUsage },
        ).then((r) => ({ ep, results: r.results || [] })),
      );
    }
  }
  const settled = await Promise.all(tasks);
  underlying.searchQuotes = tasks.length;

  // 6. Dedup by pineconeId, compute span, filter, sort.
  const byId = new Map();
  for (const { ep, results } of settled) {
    for (const r of results) {
      const cand = candidateFromResult(r);
      if (!cand || !cand.pineconeId) continue;
      if (byId.has(cand.pineconeId)) continue;
      cand._ep = ep;
      byId.set(cand.pineconeId, cand);
    }
  }
  let candidates = [...byId.values()].filter((c) => {
    if (c.spanSec == null) return true;
    if (Number.isFinite(f.minSpan) && c.spanSec < f.minSpan) return false;
    if (Number.isFinite(f.maxSpan) && c.spanSec > f.maxSpan) return false;
    return true;
  });
  candidates.sort((a, b) => (b.spanSec || 0) - (a.spanSec || 0));
  candidates = candidates.slice(0, f.candidatesLimit);

  // 7. Confidence tagging.
  const maxSpan = candidates.reduce((m, c) => Math.max(m, c.spanSec || 0), 0) || 1;
  candidates = candidates.map((c) => {
    const dedicated = dedicatedGuids.has(c._ep?.guid);
    const mainstream = taste.isMainstream(c.creator);
    const spanRank = (c.spanSec || 0) / maxSpan;
    const firstPerson = firstPersonHeuristic(c.text);
    const { score, tier } = taste.scoreConfidence({ dedicated, mainstream, spanRank, firstPerson });
    const { _ep, ...clean } = c;
    return {
      ...clean,
      confidenceTier: tier,
      _signals: { dedicated, mainstream, spanRank: parseFloat(spanRank.toFixed(2)), firstPerson, score },
    };
  });

  const appearances = episodes.map((e) => ({
    guid: e.guid,
    title: e.title,
    feedTitle: e.feedTitle,
    publishedDate: e.publishedDate,
    role: e.role,
    imageUrl: e.imageUrl,
  }));

  const body = { person: resolvedName, appearances, candidates, _meta: { underlying } };
  return { body, underlying };
}

module.exports = { personQuotes, DEFAULTS };
