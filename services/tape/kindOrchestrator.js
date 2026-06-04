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
const { audit, slimCandidate } = require('./tapeAudit');

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

// Tape synthesis is a no-tools prose pass. The global `quality` alias (DeepSeek
// V4) is a REASONING model that's flaky here (burns budget thinking → empty /
// truncated output that drops the trailing ## TICKERS block). So Tape uses a
// clean prose model — gpt-4o-mini, which is exactly what /api/pull routes its
// own final prose to (AGENT_SYNTHESIS_MODEL). Cheap (~$0.001/synth), reliable.
// `fast` (Haiku) honored if explicitly requested; TAPE_SYNTH_MODEL overrides.
const TAPE_SYNTH_MODEL = process.env.TAPE_SYNTH_MODEL || 'gpt-4o-mini';
function tapeModelKey(requested) {
  return requested === 'fast' ? 'fast' : TAPE_SYNTH_MODEL;
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
  let candidates = [];
  let subA = []; // per-side pools for the citation floor
  let subB = [];
  if (isCamp) {
    const { body: tq } = await topicQuotes({ query: topic, themes: [topic], kind: 'split', groupBy: 'bull-bear', filters: { mainstream: true } }, { openai });
    candidates = tq.candidates || [];
    const sa = campSide(personA);
    const sb = campSide(personB);
    const half = Math.ceil(candidates.length / 2);
    subA = sa ? candidates.filter((c) => c.side === sa) : candidates.slice(0, half);
    subB = sb ? candidates.filter((c) => c.side === sb) : candidates.slice(half);
  } else {
    const grab = (name) => personQuotes({ name, themes: [topic], kind: 'split', filters: { dedicatedOnly: false, mainstream: false } }, { openai })
      .then((r) => r.body.candidates || []).catch(() => []);
    [subA, subB] = await Promise.all([grab(personA), grab(personB)]);
    const seen = new Set();
    candidates = [...subA, ...subB].filter((c) => c.pineconeId && !seen.has(c.pineconeId) && seen.add(c.pineconeId));
  }
  if (!candidates.length) {
    return { result: { topic, sideA: { person: personA, positionSummary: '', citations: [] }, sideB: { person: personB, positionSummary: '', citations: [] }, generatedAt: isoNow(), tickers: [], _meta: emptyMeta('No quotes found for either side of this debate.') }, usage: null, synthesizedEmpty: true };
  }

  const r = await synth('split', { person: personA, personB, topic }, candidates, body.model, jwtSub, auditId);
  const parsed = parseSplit(r.finalText, candidates);
  const conf = assessConfidence({ kind: 'split', candidates, finalText: r.finalText, synthesizedEmpty: r.synthesizedEmpty, emptyReason: r.reason });
  const used = new Set();
  const sideA = { ...parsed.sideA, person: parsed.sideA.person || personA };
  const sideB = { ...parsed.sideB, person: parsed.sideB.person || personB };
  sideA.citations = floorEmpty(sideA.citations, subA, used, 3);
  sideB.citations = floorEmpty(sideB.citations, subB, used, 3);
  return {
    result: {
      topic,
      sideA,
      sideB,
      contrastSummary: parsed.contrastSummary,
      generatedAt: isoNow(),
      tickers: r.synthesizedEmpty ? [] : r.tickers,
      _meta: { confidence: conf.confidence, confidenceReason: conf.confidenceReason, candidateCount: conf.candidateCount, ...(r.recovered ? { complianceRecovered: true } : {}) },
    },
    usage: r.usage,
    synthesizedEmpty: r.synthesizedEmpty,
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

  const { body: tq } = await topicQuotes({ query: ticker, themes: [ticker], kind: 'readin', filters: { mainstream: false, candidatesLimit: 20 } }, { openai });
  const candidates = tq.candidates || [];
  if (!candidates.length) {
    return { result: { ticker, name: resolved.name || ticker, sectorTag: '', yahoo: ticker, whatTheyDo: '', whatTheyDoCitations: [], pulse: { bullLine: '', bearLine: '', priceAction: '', marqueeCitation: null }, smartMoney: { bulls: [], bears: [] }, catalysts: [], risks: [], peers: [], generatedAt: isoNow(), tickers: [], _meta: emptyMeta(`${ticker} has no meaningful mentions in the corpus.`) }, usage: null, synthesizedEmpty: true };
  }

  // Read-in is citation-critical (inline WHAT_THEY_DO pills + SMART_MONEY quotes);
  // gpt-4o-mini under-cites the primer, so this one kind defaults to Haiku, which
  // cites reliably. Other kinds stay on cheap gpt-4o-mini. Explicit body.model wins.
  const r = await synth('readin', { ticker }, candidates, body.model || 'fast', jwtSub, auditId);
  const parsed = parseReadin(r.finalText, candidates);
  const peers = r.synthesizedEmpty ? [] : r.tickers;
  // Citation floor (insurance — readin is on Haiku and usually cites well).
  const usedR = new Set();
  const whatTheyDoCitations = floorEmpty(parsed.whatTheyDoCitations, candidates, usedR, 3);
  const bulls = floorEmpty(parsed.smartMoney.bulls, candidates, usedR, 2);
  const bears = floorEmpty(parsed.smartMoney.bears, candidates, usedR, 2);
  const pulse = { ...parsed.pulse, marqueeCitation: parsed.pulse.marqueeCitation || whatTheyDoCitations[0] || candidates[0] || null };

  // Confidence scored on the ASSEMBLED result (post-floor): a Read-in that
  // renders the full structure — primer + bull & bear pulse lines + both
  // smart-money sides populated + risks — is `strong`, even if the synth's raw
  // clip tokens were malformed (the floor still attaches real, playable quotes).
  // The synth-authored prose (pulse lines, risks) is the differentiator since
  // the floor only backfills citations, not those.
  const hasWtd = !!(parsed.whatTheyDo && parsed.whatTheyDo.trim());
  const hasBullLine = !!(parsed.pulse.bullLine && parsed.pulse.bullLine.trim());
  const hasBearLine = !!(parsed.pulse.bearLine && parsed.pulse.bearLine.trim());
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
