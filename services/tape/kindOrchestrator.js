/**
 * Kind-level orchestration: the full retrieve → synthesize → parse → hydrate →
 * assemble pipeline for each Tape action, behind one call. Composes the existing
 * internal primitives (personQuotes / topicQuotes / produce) + markerParse +
 * confidence. Returns { result, usage, synthesizedEmpty }; throws TapeHttpError
 * on hard failure (caught by withKindEndpoint).
 *
 * This is the only place the retrieve↔synthesize seam lives now — the client
 * just calls /api/tape/<kind> and renders the typed Result.
 */

const { resolveModelSelection } = require('../../constants/agentModels');
const { personQuotes } = require('./personQuotes');
const { topicQuotes } = require('./topicQuotes');
const { produce } = require('./synthesize');
const { parseDossier, parseBrief, parseSplit, parseNarrative, parseReadin } = require('./markerParse');
const { assessConfidence } = require('./confidence');
const { TapeHttpError } = require('./tapeErrors');
const { resolveTicker } = require('./tickerResolver');
const { classifyStance } = require('./stanceClassifier');
const { expandPassages } = require('./contextExpander');
const { getCard, peersByIndustry } = require('./companyCards');

// When a Read-in ticker has no real corpus coverage, zoom out to its industry:
// surface related peer/sector discussion with a loud disclaimer, instead of a dead
// empty state. Uses the company card (industry + peers + description). Default on.
const INDUSTRY_FALLBACK_ENABLED = process.env.TAPE_INDUSTRY_FALLBACK !== 'false';

async function industryReadinFallback(ticker, openai) {
  if (!INDUSTRY_FALLBACK_ENABLED) return null;
  const card = getCard(ticker);
  if (!card || !card.industry) return null;
  const peers = peersByIndustry(ticker, 5);
  const themes = [card.industry, ...peers.map((p) => p.name).filter(Boolean)].slice(0, 7);
  let cites = [];
  try {
    const { body: tq } = await topicQuotes(
      { query: card.industry, themes, kind: 'readin', expandThemes: false, noLiteralAnchor: true, filters: { mainstream: false, candidatesLimit: 6 } },
      { openai },
    );
    cites = (tq.candidates || []).slice(0, 5);
  } catch (_) { /* fall through to null */ }
  if (!cites.length) return null;
  const disclaimer = `⚠️ No podcast coverage of ${card.name} (${ticker}) was found. ${card.name} is a ${card.industry} company${card.description ? ` — ${card.description}` : '.'} The clips below are related ${card.industry} / peer discussion, NOT about ${card.name} specifically.`;
  return {
    result: {
      ticker, name: card.name || ticker, sectorTag: card.industry, yahoo: ticker,
      whatTheyDo: disclaimer, whatTheyDoCitations: cites,
      pulse: { bullLine: '', bearLine: '', priceAction: '', marqueeCitation: cites[0] || null },
      smartMoney: { bulls: [], bears: [] }, catalysts: [], risks: [],
      peers: peers.map((p) => p.ticker),
      generatedAt: isoNow(), tickers: peers.map((p) => p.ticker),
      _meta: { confidence: 'thin', confidenceReason: `No direct coverage of ${ticker}; showing ${card.industry} peers/context.`, candidateCount: cites.length, coverageFallback: 'industry' },
    },
    usage: null, synthesizedEmpty: false,
  };
}
const { audit, slimCandidate } = require('./tapeAudit');

// Stance gate (precision half of the polarity work): verify a quote is GENUINELY
// bullish/bearish before it fills a bear slot (Read-in) or a camp side (Split),
// so seeding's recall doesn't drag non-polarized quotes into a directional slot.
// Fail-open (classifier errors → un-gated pool). Disable with TAPE_STANCE_GATE=false.
const STANCE_GATE_ENABLED = process.env.TAPE_STANCE_GATE !== 'false';

const CAMPS = new Set(['bulls', 'bears', 'hawks', 'doves']);
const DAY_MS = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Citation floor (per the citation-hydration memo): when the synth leaves a
// section's citations empty, backfill from the candidate pool so the UI always
// shows real, playable receipts — model-independent. Preserves the synth's own
// picks where present; `used` dedups across sections so the same clip isn't
// repeated everywhere.
function floorEmpty(citations, subpool, used, k) {
  if (citations && citations.length) { citations.forEach((c) => used.add(c.pineconeId)); return citations; }
  const picks = [];
  for (const c of (subpool || [])) {
    if (picks.length >= k) break;
    if (c && c.pineconeId && !used.has(c.pineconeId)) { picks.push(c); used.add(c.pineconeId); }
  }
  return picks;
}
function campSide(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'bulls') return 'bull';
  if (n === 'bears') return 'bear';
  return null;
}

// Strip the internal `_stance` hint off citation objects so it never leaks into
// the API response (it's an orchestration-only annotation for the stance gate).
function stripStance(arr) {
  return (arr || []).map((c) => {
    if (!c || c._stance === undefined) return c;
    const { _stance, ...rest } = c;
    return rest;
  });
}

const DEFAULT_DOSSIER_THEMES = [
  'Federal Reserve interest rates inflation policy',
  'recession risk economy',
  'stock market valuations',
  'oil commodities energy',
  'the US dollar and Treasury yields',
  'gold and safe havens',
];

const isoNow = () => new Date().toISOString();

// Dossier retrieval ladder: prefer dedicated + mainstream, but a person who only
// ever guests (titles don't contain their name) or appears on shows outside the
// allowlist would yield nothing. Broaden in steps until candidates surface —
// same resilience shape as Brief's window auto-expand.
const DOSSIER_FILTER_TIERS = [
  { dedicatedOnly: true, mainstream: true },
  { dedicatedOnly: false, mainstream: true },
  { dedicatedOnly: false, mainstream: false },
];

// Per-kind synthesis routing — LOCKED from the eval model sweep (2026-06-05):
// - Brief / Split / dossier / narrative → DeepSeek V4-Flash ('quality'): the
//   cheapest synth in the stack AND the highest quality on these kinds (eval v6:
//   Brief 9→15/20, confidence_overstated 7→0). The old "DeepSeek is flaky" issue
//   was a too-low token cap (now 8000), NOT the model — 0 compliance failures at
//   the proper cap. Trade-off is latency (~30s/synth), which Tape's content-
//   addressed caching absorbs on repeats.
// - Read-in → Haiku ('fast', see TAPE_READIN_MODEL): the citation-heavy primer;
//   DeepSeek under-produced it (eval v6: 6/20, several empty). Haiku cites reliably.
// Both overridable per env for future A/Bs.
const TAPE_SYNTH_MODEL = process.env.TAPE_SYNTH_MODEL || 'quality';
const TAPE_READIN_MODEL = process.env.TAPE_READIN_MODEL || 'fast';
// Map a requested model to a resolveModelSelection key. 'fast' → Haiku; an
// explicit model id (gpt-4o, gpt-4o-mini, …) passes through so model can be swept
// per env; anything empty/'quality'/'default' falls back to the Tape synth model.
function tapeModelKey(requested) {
  if (requested === 'fast') return 'fast';
  if (typeof requested === 'string' && requested && requested !== 'quality' && requested !== 'default') return requested;
  return TAPE_SYNTH_MODEL;
}

// Read-in bear-seeded retrieval. Podcasts skew bullish/promotional, so a neutral
// "{ticker}" vector query lands in a bull-heavy neighborhood and the synth has no
// genuine bearish material for the SMART_MONEY:BEAR slot (eval flagged
// bear_slot_not_bearish across ~11 tickers). A second retrieval seeded with
// bearish framing pulls the short/overvalued/downside neighborhood; results merge
// into the pool so real bear quotes EXIST for the synth to cite and the bear
// citation-floor to draw from. Disable with TAPE_READIN_BEAR_SEED=false.
const BEAR_SEED_ENABLED = process.env.TAPE_READIN_BEAR_SEED !== 'false';
// Read-in does NOT hard-gate by source (default false): hard-gating starved its
// bear side (eval v11: bear_slot_not_bearish 4→8). Instead the SOURCE_BOOST in
// topicQuotes SOFT-demotes non-allowlisted feeds (quality sources rank first,
// but off-topic noise is still rejected by the ticker filter + reranker). Set
// TAPE_READIN_MAINSTREAM=true to hard-gate again.
const READIN_MAINSTREAM = process.env.TAPE_READIN_MAINSTREAM === 'true';
const READIN_CAND_CAP = parseInt(process.env.TAPE_READIN_CAND_CAP || '24', 10);
function bearThemes(name) {
  return [
    `${name} overvalued bubble`,
    `${name} bear case short thesis`,
    `${name} downside risk concerns headwinds`,
    `${name} expensive valuation priced for perfection`,
    `why ${name} could fall decline`,
  ];
}
function bullThemes(topic) {
  return [
    `${topic} bullish upside`,
    `${topic} buy opportunity growth`,
    `${topic} undervalued long thesis`,
    `why ${topic} will rise positive outlook`,
  ];
}

// Split camp side: polarity-seeded retrieval so each side comes from its OWN
// sentiment neighborhood, not one neutral pool sorted by a keyword classifier
// (eval: both_sides_same). expandThemes off so the neutral expander doesn't
// dilute the polarity; query=topic keeps the literal-anchor/topic filter.
// Default to SOFT-demote (mainstream:false + source boost), NOT a hard mainstream
// filter — same fix we applied to Read-In. A hard filter starves the bear camp:
// genuinely bearish/contrarian takes disproportionately come from outside the
// mainstream allowlist, so excluding them makes a good Split impossible. With
// soft-demote the camp pulls bears from the whole corpus; the stance gate +
// reranker keep only on-topic, stance-correct quotes. Set TAPE_SPLIT_MAINSTREAM=
// true to restore the hard filter.
const SPLIT_MAINSTREAM = process.env.TAPE_SPLIT_MAINSTREAM === 'true';
function splitCampPool(topic, themes, openai) {
  return topicQuotes({ query: topic, themes, kind: 'split', expandThemes: false, filters: { mainstream: SPLIT_MAINSTREAM, candidatesLimit: 12 } }, { openai })
    .then((r) => r.body.candidates || [])
    .catch(() => []);
}

// Named Split side: bias toward first-person quotes (a proxy for the person
// actually SPEAKING vs being discussed by a host — the Saylor "about-them"
// fabrication). Soft re-rank; never drops, so a thinly-covered person isn't
// emptied by the heuristic alone.
function preferFirstPerson(cands) {
  return [...(cands || [])].sort((a, b) => (b._signals?.firstPerson ? 1 : 0) - (a._signals?.firstPerson ? 1 : 0));
}

/** One internal synthesis pass via the shared agentic core. */
async function synth(kind, input, candidates, model, jwtSub, auditId) {
  audit('retrieval', auditId, { kind, input, candidateCount: candidates.length, candidates: candidates.map(slimCandidate) });
  const { modelConfig } = resolveModelSelection({ model: tapeModelKey(model) });
  const validIds = new Set(candidates.map((c) => c.pineconeId).filter(Boolean));
  const r = await produce({ kind, input, candidates, modelConfig, validIds, ctx: { sub: jwtSub, model: modelConfig.id } });
  audit('synthesis', auditId, { kind, model: modelConfig.id, tokens: r.usage, synthesizedEmpty: r.synthesizedEmpty, attempts: r.attempts, rawText: r.finalText });
  return r;
}

function emptyMeta(reason) {
  return { confidence: 'empty', confidenceReason: reason, candidateCount: 0 };
}

// ---- Dossier ----
async function runDossier(body, { jwtSub, openai, auditId }) {
  const person = String(body.person || '').trim();
  if (!person) throw new TapeHttpError(400, 'bad-request', 'Bad request', 'person is required');

  let pq = null;
  let tierUsed = -1;
  for (let i = 0; i < DOSSIER_FILTER_TIERS.length; i += 1) {
    const res = await personQuotes(
      { name: person, themes: DEFAULT_DOSSIER_THEMES, kind: 'dossier', filters: DOSSIER_FILTER_TIERS[i] },
      { openai },
    );
    pq = res.body;
    if ((pq.candidates || []).length) { tierUsed = i; break; }
  }
  const candidates = pq?.candidates || [];
  if (!candidates.length) {
    return {
      result: { person, topics: [], appearances: [], generatedAt: isoNow(), tickers: [], _meta: emptyMeta(`${person} has no mainstream appearances surfaced in the corpus.`) },
      usage: null, synthesizedEmpty: true,
    };
  }

  const r = await synth('dossier', { person }, candidates, body.model, jwtSub, auditId);
  const parsed = parseDossier(r.finalText, candidates);
  // Backfill appearances from person-quotes if the synthesis omitted the block.
  const appearances = parsed.appearances.length
    ? parsed.appearances
    : (pq.appearances || []).map((a) => ({ show: a.feedTitle || null, episodeTitle: a.title || null, publishedDate: a.publishedDate || null, citationCount: 0 }));
  const conf = assessConfidence({ kind: 'dossier', candidates, finalText: r.finalText, synthesizedEmpty: r.synthesizedEmpty, emptyReason: r.reason });
  // Broadening past the mainstream allowlist caps confidence at partial and is noted.
  let { confidence, confidenceReason } = conf;
  if (tierUsed >= 2 && confidence === 'strong') {
    confidence = 'partial';
    confidenceReason = 'Broadened beyond mainstream sources — limited dedicated coverage.';
  }

  const usedD = new Set();
  const topics = parsed.topics.map((t) => ({ ...t, citations: floorEmpty(t.citations, candidates, usedD, 3) }));
  return {
    result: {
      person,
      topics,
      appearances,
      generatedAt: isoNow(),
      tickers: r.synthesizedEmpty ? [] : r.tickers,
      _meta: { confidence, confidenceReason, candidateCount: conf.candidateCount, ...(r.recovered ? { complianceRecovered: true } : {}) },
    },
    usage: r.usage,
    synthesizedEmpty: r.synthesizedEmpty || parsed.topics.length === 0,
  };
}

// ---- Brief ----
async function runBrief(body, { jwtSub, openai, auditId }) {
  const topic = String(body.topic || '').trim();
  const asOfDate = body.asOfDate;
  if (!topic) throw new TapeHttpError(400, 'bad-request', 'Bad request', 'topic is required');
  if (!asOfDate || !/^\d{4}-\d{2}-\d{2}/.test(asOfDate)) throw new TapeHttpError(400, 'bad-request', 'Bad request', 'asOfDate (yyyy-mm-dd) is required');

  // Backend owns the window: kind=brief + asOfDate drives the 7→30→90 auto-expand.
  const { body: tq } = await topicQuotes(
    { query: topic, kind: 'brief', asOfDate, filters: { mainstream: true } },
    { openai },
  );
  const candidates = tq.candidates || [];
  const windowDays = tq._meta?.windowDays ?? null;
  const windowExpanded = tq._meta?.windowExpanded ?? false;

  if (!candidates.length) {
    return {
      result: { topic, asOfDate, headline: '', sections: [], generatedAt: isoNow(), tickers: [], _meta: { ...emptyMeta('No mainstream coverage of this topic in the last 90 days.'), ...(windowDays != null ? { windowDays, windowExpanded } : {}) } },
      usage: null, synthesizedEmpty: true,
    };
  }

  const r = await synth('brief', { topic }, candidates, body.model, jwtSub, auditId);
  const parsed = parseBrief(r.finalText, candidates);
  const conf = assessConfidence({ kind: 'brief', candidates, finalText: r.finalText, synthesizedEmpty: r.synthesizedEmpty, emptyReason: r.reason, windowDays, windowExpanded });
  const usedB = new Set();
  const sections = parsed.sections.map((s) => {
    const byCreator = candidates.filter((c) => c.creator && s.publisher && c.creator.toLowerCase() === s.publisher.toLowerCase());
    return { ...s, citations: floorEmpty(s.citations, byCreator.length ? byCreator : candidates, usedB, 2) };
  });

  return {
    result: {
      topic,
      asOfDate,
      headline: parsed.headline,
      sections,
      generatedAt: isoNow(),
      tickers: r.synthesizedEmpty ? [] : r.tickers,
      _meta: { confidence: conf.confidence, confidenceReason: conf.confidenceReason, candidateCount: conf.candidateCount, ...(windowDays != null ? { windowDays, windowExpanded } : {}), ...(r.recovered ? { complianceRecovered: true } : {}) },
    },
    usage: r.usage,
    synthesizedEmpty: r.synthesizedEmpty || parsed.sections.length === 0,
  };
}

// ---- Split ----
async function runSplit(body, { jwtSub, openai, auditId }) {
  const personA = String(body.personA || '').trim();
  const personB = String(body.personB || '').trim();
  const topic = String(body.topic || '').trim();
  if (!personA || !personB || !topic) throw new TapeHttpError(400, 'bad-request', 'Bad request', 'personA, personB and topic are required');

  const isCamp = CAMPS.has(personA.toLowerCase()) || CAMPS.has(personB.toLowerCase());
  let subA = []; // per-side pools for the citation floor
  let subB = [];
  let stanceMap = new Map();
  if (isCamp) {
    // Polarity-seeded dual retrieval (recall) → stance gate (precision): each
    // side keeps only quotes whose classified stance matches its camp, so the two
    // sides genuinely oppose instead of sharing topically-adjacent neutrals.
    const [bullPool, bearPool] = await Promise.all([
      splitCampPool(topic, bullThemes(topic), openai),
      splitCampPool(topic, bearThemes(topic), openai),
    ]);
    const union = [];
    const seenU = new Set();
    for (const c of [...bullPool, ...bearPool]) { if (c?.pineconeId && !seenU.has(c.pineconeId)) { seenU.add(c.pineconeId); union.push(c); } }
    if (STANCE_GATE_ENABLED) {
      try { ({ stances: stanceMap } = await classifyStance({ subject: topic, clips: union, openai })); } catch (_) { /* fail-open */ }
    }
    const sa = campSide(personA); // 'bull' | 'bear' | null
    const sb = campSide(personB);
    if (stanceMap.size > 0) {
      const ofStance = (st) => union.filter((c) => stanceMap.get(c.pineconeId) === st);
      subA = sa ? ofStance(sa) : union;   // stance-correct quotes for camp A
      subB = sb ? ofStance(sb) : union;   // stance-correct quotes for camp B
    } else {
      subA = sa === 'bear' ? bearPool : bullPool;   // fail-open: seeded pools
      subB = sb === 'bull' ? bullPool : bearPool;
    }
  } else {
    // Named: quotes BY each person, first-person-preferred (proxy for speaking).
    const grab = (name) => personQuotes({ name, themes: [topic], kind: 'split', filters: { dedicatedOnly: false, mainstream: false } }, { openai })
      .then((r) => preferFirstPerson(r.body.candidates || [])).catch(() => []);
    [subA, subB] = await Promise.all([grab(personA), grab(personB)]);
  }
  // Merge dedup for the synth pool (side pools stay separate for the floor);
  // annotate with stance so the writer slots quotes onto the correct side.
  const seenC = new Set();
  const candidates = [];
  for (const c of [...subA, ...subB]) {
    if (!c || !c.pineconeId || seenC.has(c.pineconeId)) continue;
    seenC.add(c.pineconeId);
    candidates.push({ ...c, _stance: stanceMap.get(c.pineconeId) });
  }
  if (!candidates.length) {
    return { result: { topic, sideA: { person: personA, positionSummary: '', citations: [] }, sideB: { person: personB, positionSummary: '', citations: [] }, generatedAt: isoNow(), tickers: [], _meta: emptyMeta('No quotes found for either side of this debate.') }, usage: null, synthesizedEmpty: true };
  }

  // Note: NO context expansion on Split — it dilutes the stance-gated quotes
  // (v5: both_sides_same regressed 3→9). Expansion stays Read-In-only.
  const r = await synth('split', { person: personA, personB, topic }, candidates, body.model, jwtSub, auditId);
  const parsed = parseSplit(r.finalText, candidates);
  const conf = assessConfidence({ kind: 'split', candidates, finalText: r.finalText, synthesizedEmpty: r.synthesizedEmpty, emptyReason: r.reason });
  const used = new Set();
  const sideA = { ...parsed.sideA, person: parsed.sideA.person || personA };
  const sideB = { ...parsed.sideB, person: parsed.sideB.person || personB };
  // Citations must be side-correct (stance/person-matched) and never shared across
  // sides: keep only the model picks belonging to this side's pool, then backfill
  // from it; the shared `used` set guarantees a clip can't appear on both sides.
  const aIds = new Set(subA.map((c) => c.pineconeId));
  const bIds = new Set(subB.map((c) => c.pineconeId));
  const aModel = (sideA.citations || []).filter((c) => aIds.has(c.pineconeId));
  const bModel = (sideB.citations || []).filter((c) => bIds.has(c.pineconeId));
  sideA.citations = stripStance(floorEmpty(aModel, subA, used, 3));
  sideB.citations = stripStance(floorEmpty(bModel, subB, used, 3));

  // Honest-empty gate: a side with no genuine quotes must not present a
  // fabricated stance (the El-Erian/Summers + Saylor failures). Blank the prose
  // and citations for the starved side and report it in the confidence, instead
  // of letting the writer mirror the other side or invent a position.
  let { confidence, confidenceReason, candidateCount } = conf;
  const starved = [];
  if (!subA.length) { sideA.positionSummary = ''; sideA.citations = []; starved.push(sideA.person); }
  if (!subB.length) { sideB.positionSummary = ''; sideB.citations = []; starved.push(sideB.person); }
  if (starved.length === 2) {
    confidence = 'empty';
    confidenceReason = `No quotes found for ${sideA.person} or ${sideB.person}.`;
  } else if (starved.length === 1) {
    confidence = 'thin';
    confidenceReason = `No quotes found for ${starved[0]}; one-sided.`;
  }
  const oneSided = starved.length > 0;

  return {
    result: {
      topic,
      sideA,
      sideB,
      contrastSummary: oneSided ? '' : parsed.contrastSummary,
      generatedAt: isoNow(),
      tickers: r.synthesizedEmpty ? [] : r.tickers,
      _meta: { confidence, confidenceReason, candidateCount, ...(r.recovered ? { complianceRecovered: true } : {}) },
    },
    usage: r.usage,
    synthesizedEmpty: r.synthesizedEmpty || starved.length === 2,
  };
}

// ---- Narrative ----
async function runNarrative(body, { jwtSub, openai, auditId }) {
  const topic = String(body.topic || '').trim();
  if (!topic) throw new TapeHttpError(400, 'bad-request', 'Bad request', 'topic is required');
  const group = body.group ? String(body.group).trim() : null;
  const minDate = isoDay(Date.now() - 36 * 30.44 * DAY_MS); // ~36-month spread

  let candidates = [];
  if (group && /^(bulls|bears)$/i.test(group)) {
    const { body: tq } = await topicQuotes({ query: topic, themes: [topic], kind: 'narrative', groupBy: 'bull-bear', filters: { mainstream: true, minDate, candidatesLimit: 40 } }, { openai });
    const side = group.toLowerCase() === 'bulls' ? 'bull' : 'bear';
    candidates = (tq.candidates || []).filter((c) => c.side === side);
  } else if (group && group.toLowerCase() !== 'all') {
    const { body: pq } = await personQuotes({ name: group, themes: [topic], kind: 'narrative', filters: { dedicatedOnly: false, mainstream: false } }, { openai }).catch(() => ({ body: { candidates: [] } }));
    candidates = pq.candidates || [];
  } else {
    const { body: tq } = await topicQuotes({ query: topic, themes: [topic], kind: 'narrative', filters: { mainstream: true, minDate, candidatesLimit: 40 } }, { openai });
    candidates = tq.candidates || [];
  }
  if (!candidates.length) {
    return { result: { topic, group: group || undefined, thesis: '', buckets: [], inflections: [], generatedAt: isoNow(), tickers: [], _meta: emptyMeta('Not enough coverage to trace a narrative over time.') }, usage: null, synthesizedEmpty: true };
  }

  const r = await synth('narrative', { topic, group }, candidates, body.model, jwtSub, auditId);
  const parsed = parseNarrative(r.finalText, candidates);
  const conf = assessConfidence({ kind: 'narrative', candidates, finalText: r.finalText, synthesizedEmpty: r.synthesizedEmpty, emptyReason: r.reason });
  const usedN = new Set();
  const buckets = parsed.buckets.map((b) => {
    const s = new Date(b.start).getTime();
    const e = new Date(b.end).getTime();
    const inWin = candidates.filter((c) => {
      const t = c.publishedDate ? new Date(c.publishedDate).getTime() : NaN;
      return Number.isFinite(t) && Number.isFinite(s) && Number.isFinite(e) && t >= s && t <= e;
    });
    return { ...b, citations: floorEmpty(b.citations, inWin.length ? inWin : candidates, usedN, 2) };
  });
  return {
    result: {
      topic,
      group: group || undefined,
      thesis: parsed.thesis,
      buckets,
      inflections: parsed.inflections,
      forwardCall: parsed.forwardCall,
      generatedAt: isoNow(),
      tickers: r.synthesizedEmpty ? [] : r.tickers,
      _meta: { confidence: conf.confidence, confidenceReason: conf.confidenceReason, candidateCount: conf.candidateCount, ...(r.recovered ? { complianceRecovered: true } : {}) },
    },
    usage: r.usage,
    synthesizedEmpty: r.synthesizedEmpty || parsed.buckets.length === 0,
  };
}

// ---- Read-in ----
async function runReadin(body, { jwtSub, openai, auditId }) {
  const ticker = String(body.ticker || '').trim();
  if (!ticker) throw new TapeHttpError(400, 'bad-request', 'Bad request', 'ticker is required');
  const resolved = await resolveTicker(ticker);

  // Two retrievals: a neutral pool (bull/primer material) + a bear-seeded pool so
  // genuinely bearish quotes are present. Bear call skips theme expansion so the
  // neutral expander doesn't dilute the bearish framing, and uses query=ticker so
  // the resolver + ticker-noise filter still anchor results on the company.
  const bearName = resolved.name || ticker;
  // NOTE: exec/product search-seeding was tried (v9) and reverted — adding those
  // themes to the BULL pool crowded out the bear-seeded clips at the merge cap and
  // worsened bear_slot_not_bearish. Recall on sparse tickers needs a bear-protected
  // approach, not bull-pool seeding.
  const [bullRes, bearRes] = await Promise.all([
    topicQuotes({ query: ticker, themes: [ticker], kind: 'readin', strictTicker: true, filters: { mainstream: READIN_MAINSTREAM, candidatesLimit: 18 } }, { openai }),
    BEAR_SEED_ENABLED
      ? topicQuotes({ query: ticker, themes: bearThemes(bearName), kind: 'readin', expandThemes: false, strictTicker: true, filters: { mainstream: READIN_MAINSTREAM, candidatesLimit: 12 } }, { openai }).catch(() => ({ body: { candidates: [] } }))
      : Promise.resolve({ body: { candidates: [] } }),
  ]);
  const bullCands = bullRes.body.candidates || [];
  const bearCands = bearRes.body.candidates || [];
  // Track which ids came from the bear-seeded retrieval (no flag mutation on the
  // candidate, so nothing leaks into the API response). Merge bull-first, dedup.
  const bearIds = new Set(bearCands.map((c) => c.pineconeId).filter(Boolean));
  const seenIds = new Set();
  const candidates = [];
  for (const c of [...bullCands, ...bearCands]) {
    if (!c || !c.pineconeId || seenIds.has(c.pineconeId)) continue;
    seenIds.add(c.pineconeId);
    candidates.push(c);
    if (candidates.length >= READIN_CAND_CAP) break;
  }
  if (!candidates.length) {
    const fb = await industryReadinFallback(ticker, openai);
    if (fb) return fb;
    return { result: { ticker, name: resolved.name || ticker, sectorTag: '', yahoo: ticker, whatTheyDo: '', whatTheyDoCitations: [], pulse: { bullLine: '', bearLine: '', priceAction: '', marqueeCitation: null }, smartMoney: { bulls: [], bears: [] }, catalysts: [], risks: [], peers: [], generatedAt: isoNow(), tickers: [], _meta: emptyMeta(`${ticker} has no meaningful mentions in the corpus.`) }, usage: null, synthesizedEmpty: true };
  }

  // Stance gate: classify each candidate's stance toward the company so the bear
  // slot is filled only by genuinely BEARISH quotes (seeding surfaces the bearish
  // neighborhood; this verifies polarity). Fail-open → un-gated bear-seeded pool.
  let stanceMap = new Map();
  if (STANCE_GATE_ENABLED) {
    try { ({ stances: stanceMap } = await classifyStance({ subject: bearName, clips: candidates, openai })); } catch (_) { /* fail-open */ }
  }
  const gateActive = stanceMap.size > 0;
  const cands = candidates.map((c) => ({ ...c, _stance: stanceMap.get(c.pineconeId) }));

  // Read-in is citation-critical (inline WHAT_THEY_DO pills + SMART_MONEY quotes);
  // gpt-4o-mini under-cites the primer, so this one kind defaults to Haiku, which
  // cites reliably. Other kinds stay on cheap gpt-4o-mini. Explicit body.model wins.
  // Stitch adjacent paragraphs onto truncated clips for the synthesis pass only;
  // citations still hydrate against the original `cands` (original text + times).
  const synthCands = await expandPassages(cands);
  const r = await synth('readin', { ticker }, synthCands, body.model || TAPE_READIN_MODEL, jwtSub, auditId);
  const parsed = parseReadin(r.finalText, cands);

  // Honest-empty: synthesis produced nothing (clips too thin/off-topic). Do NOT
  // floor citations onto an empty read-in — that surfaced off-topic quotes (e.g.
  // 23andMe / COVID clips on a TVTX read-in). Return a clean empty state.
  if (r.synthesizedEmpty || !parsed.whatTheyDo) {
    const fb = await industryReadinFallback(ticker, openai);
    if (fb) { fb.usage = r.usage; return fb; } // keep token accounting from the attempt
    return {
      result: { ticker, name: resolved.name || ticker, sectorTag: '', yahoo: ticker, whatTheyDo: '', whatTheyDoCitations: [], pulse: { bullLine: '', bearLine: '', priceAction: '', marqueeCitation: null }, smartMoney: { bulls: [], bears: [] }, catalysts: [], risks: [], peers: [], generatedAt: isoNow(), tickers: [], _meta: emptyMeta(r.reason || `${ticker} has no meaningful mentions in the corpus.`) },
      usage: r.usage,
      synthesizedEmpty: true,
    };
  }
  const peers = r.tickers;

  // Citation floor. The bear slot draws ONLY from genuinely-bearish quotes (when
  // the gate is active): keep stance-correct model picks, then backfill from the
  // bear-stance pool. If nothing is genuinely bearish, the bear slot stays empty
  // and the bear pulse line is blanked — honest over a fabricated bear case.
  const usedR = new Set();
  const bearStancePool = gateActive ? cands.filter((c) => c._stance === 'bear') : cands.filter((c) => bearIds.has(c.pineconeId));
  const bearStanceIds = new Set(bearStancePool.map((c) => c.pineconeId));
  const nonBearPool = gateActive ? cands.filter((c) => c._stance !== 'bear') : cands.filter((c) => !bearIds.has(c.pineconeId));
  const modelBears = gateActive ? (parsed.smartMoney.bears || []).filter((c) => bearStanceIds.has(c.pineconeId)) : (parsed.smartMoney.bears || []);
  const bears = stripStance(floorEmpty(modelBears, bearStancePool.length ? bearStancePool : (gateActive ? [] : cands), usedR, 2));
  const whatTheyDoCitations = stripStance(floorEmpty(parsed.whatTheyDoCitations, cands, usedR, 3));
  const bulls = stripStance(floorEmpty(parsed.smartMoney.bulls, nonBearPool.length ? nonBearPool : cands, usedR, 2));
  // Blank an unsupported bear pulse line: no genuine bear quote ⇒ nothing backs it.
  const bearLine = (gateActive && bears.length === 0) ? '' : parsed.pulse.bearLine;
  const marquee = parsed.pulse.marqueeCitation || whatTheyDoCitations[0] || cands[0] || null;
  const pulse = { ...parsed.pulse, bearLine, marqueeCitation: marquee ? stripStance([marquee])[0] : null };

  // Confidence scored on the ASSEMBLED result (post-floor): a Read-in that
  // renders the full structure — primer + bull & bear pulse lines + both
  // smart-money sides populated + risks — is `strong`, even if the synth's raw
  // clip tokens were malformed (the floor still attaches real, playable quotes).
  // The synth-authored prose (pulse lines, risks) is the differentiator since
  // the floor only backfills citations, not those.
  const hasWtd = !!(parsed.whatTheyDo && parsed.whatTheyDo.trim());
  const hasBullLine = !!(parsed.pulse.bullLine && parsed.pulse.bullLine.trim());
  const hasBearLine = !!(bearLine && bearLine.trim());
  const hasRisks = parsed.risks.length > 0;
  let confidence;
  let confidenceReason = null;
  if (r.synthesizedEmpty || !hasWtd) {
    confidence = 'empty';
    confidenceReason = r.reason || `${ticker} has no meaningful mentions in the corpus.`;
  } else if (hasBullLine && hasBearLine && bulls.length >= 1 && bears.length >= 1 && hasRisks) {
    confidence = 'strong';
  } else if (hasBullLine || hasBearLine || hasRisks || bulls.length || bears.length) {
    const missing = [!hasBullLine && 'bull', !hasBearLine && 'bear', !hasRisks && 'risks'].filter(Boolean).join('/');
    confidence = 'partial';
    confidenceReason = missing ? `Incomplete: ${missing} not synthesized.` : 'Some sections thin.';
  } else {
    confidence = 'thin';
    confidenceReason = 'Only a primer; no bull/bear structure available.';
  }
  return {
    result: {
      ticker,
      name: resolved.name || ticker,
      sectorTag: '', // not in the current readin marker contract; left blank
      yahoo: ticker,
      whatTheyDo: parsed.whatTheyDo, // keeps {{clip:id}} tokens for inline pills
      whatTheyDoCitations,
      pulse,
      smartMoney: { bulls, bears },
      catalysts: [],
      risks: parsed.risks,
      peers,
      generatedAt: isoNow(),
      tickers: peers,
      _meta: { confidence, confidenceReason, candidateCount: candidates.length, ...(r.recovered ? { complianceRecovered: true } : {}) },
    },
    usage: r.usage,
    synthesizedEmpty: r.synthesizedEmpty || !parsed.whatTheyDo,
  };
}

module.exports = { runDossier, runBrief, runSplit, runNarrative, runReadin, DEFAULT_DOSSIER_THEMES };
