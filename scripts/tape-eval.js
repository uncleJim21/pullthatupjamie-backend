#!/usr/bin/env node
/**
 * Tape eval harness — exercises the three shipping kinds (readin / brief / split)
 * exactly as the frontend would, then grades each response in two layers:
 *
 *   Layer 1 — deterministic gate (no LLM): HTTP 200, schema/shape, confidence in
 *             the expected band, every {{clip:id}} resolves to a returned
 *             citation (no phantom pills), citations carry playable receipts
 *             (pineconeId + audioUrl + timestamps). Cheap, reliable, runs first;
 *             a structural failure short-circuits the judge.
 *   Layer 2 — LLM judge (Claude Sonnet 4.6, independent of the gpt-4o-mini/Haiku
 *             synthesizer): relevance, grounding, citation quality (ad-read
 *             detection), confidence honesty, plus kind-specific dimensions
 *             (Split: are the two sides genuinely opposing; Read-in: is the bear
 *             slot actually bearish). Returns a structured verdict via forced
 *             tool-use; the harness computes pass/fail from scores + flags.
 *
 * Auth + transport are the real frontend path: a scoped Tape JWT (minted in-proc
 * via signTapeToken) and POST /api/tape/<kind> over HTTP with refresh:true to
 * bypass the kind cache so every run measures fresh synthesis.
 *
 * Usage:
 *   node server.js                       # in another terminal (port 4132)
 *   node scripts/tape-eval.js                       # full suite (~52 + 3x subset)
 *   node scripts/tape-eval.js --only readin         # one kind
 *   node scripts/tape-eval.js --limit 3             # first N scenarios (cheap smoke)
 *   node scripts/tape-eval.js --repeat 3            # force every scenario Nx
 *   node scripts/tape-eval.js --no-judge            # Layer 1 only (no Anthropic spend)
 *   node scripts/tape-eval.js --base http://host    # target a different server
 *
 * Reports: logs/tape-eval-<utc>.json (full) + .md (summary). Exit 1 if any test fails.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { signTapeToken } = require('../services/tape/tapeAuth');
const { scenarios } = require('./tape-eval-scenarios');

// ---------------------------------------------------------------- CLI / config
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

const BASE = opt('--base', `http://localhost:${process.env.PORT || 4132}`);
const ONLY = opt('--only', null);
const TAG = opt('--tag', null); // e.g. --tag thin (run just the thin-coverage cohort)
const LIMIT = parseInt(opt('--limit', '0'), 10);
const FORCE_REPEAT = parseInt(opt('--repeat', '0'), 10);
const JUDGE_ENABLED = !flag('--no-judge');
const CONCURRENCY = parseInt(opt('--concurrency', '3'), 10);
const JUDGE_MODEL = process.env.TAPE_EVAL_JUDGE_MODEL || 'claude-sonnet-4-6';
// Which synth model each kind ran under (set on the server via env) — used only
// to price the reported token usage. readin uses its own knob.
const SYNTH_MODEL = opt('--synth-model', process.env.TAPE_SYNTH_MODEL || 'gpt-4o-mini');
const READIN_MODEL = opt('--readin-model', process.env.TAPE_READIN_MODEL || 'fast');
// $/1M tokens [input, output]. 'fast' = Haiku 4.5.
const PRICE = {
  'gpt-4o-mini': [0.15, 0.60], 'gpt-4o': [2.50, 10.00], fast: [1.0, 5.0],
  'claude-haiku-4-5': [1.0, 5.0], quality: [0.14, 0.28],
};
const costOf = (model, t) => { const p = PRICE[model] || [0, 0]; return ((t.input || 0) * p[0] + (t.output || 0) * p[1]) / 1e6; };
const meanScore = (v) => { const s = Object.values((v && v.scores) || {}); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };

const CONF_ENUM = ['strong', 'partial', 'thin', 'empty'];

// --------------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, n) => { const t = String(s || ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
const clipIdsIn = (text) => [...String(text || '').matchAll(/\{\{clip:([^}]+)\}\}/g)].map((m) => m[1]);

async function postKind(kind, body, token) {
  const startedAt = Date.now();
  let resp; let json; let netError = null;
  try {
    resp = await fetch(`${BASE}/api/tape/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      // refresh:true bypasses the kind cache so we grade fresh synthesis each run.
      body: JSON.stringify({ ...body, refresh: true }),
    });
    json = await resp.json().catch(() => null);
  } catch (err) {
    netError = err.message;
  }
  return { status: resp ? resp.status : 0, json, netError, elapsedMs: Date.now() - startedAt };
}

// Collect every citation object across a result, regardless of kind/shape.
function allCitations(result, kind) {
  const out = [];
  const push = (arr) => Array.isArray(arr) && arr.forEach((c) => c && out.push(c));
  if (kind === 'readin') {
    push(result.whatTheyDoCitations);
    push(result.smartMoney?.bulls);
    push(result.smartMoney?.bears);
    if (result.pulse?.marqueeCitation) out.push(result.pulse.marqueeCitation);
  } else if (kind === 'brief') {
    (result.sections || []).forEach((s) => push(s.citations));
  } else if (kind === 'split') {
    push(result.sideA?.citations);
    push(result.sideB?.citations);
  }
  return out;
}

// Prose fields that may carry inline {{clip:id}} tokens (must resolve to a citation).
function prosePieces(result, kind) {
  if (kind === 'readin') return [result.whatTheyDo, result.pulse?.bullLine, result.pulse?.bearLine].filter(Boolean);
  if (kind === 'brief') return [(result.sections || []).map((s) => s.body || s.summary || '').join('\n')];
  if (kind === 'split') return [result.sideA?.positionSummary, result.sideB?.positionSummary, result.contrastSummary].filter(Boolean);
  return [];
}

// --------------------------------------------------------- Layer 1: assertions
function assertLayer1(sc, res) {
  const fails = [];
  const warns = [];
  const { status, json, netError } = res;

  if (netError) { fails.push(`network error: ${netError}`); return { fails, warns, infra: true }; }
  if (status === 429) { return { fails: [], warns: ['rate-limited (429) — restart server to reset in-mem counters'], infra: true }; }
  if (status !== 200) { fails.push(`HTTP ${status}${json?.detail ? ` — ${truncate(json.detail, 120)}` : ''}`); return { fails, warns, infra: status >= 500 }; }
  if (!json || typeof json !== 'object') { fails.push('no JSON body'); return { fails, warns }; }

  const conf = json._meta?.confidence;
  if (!CONF_ENUM.includes(conf)) fails.push(`_meta.confidence missing/invalid: ${JSON.stringify(conf)}`);
  if (typeof json._meta?.candidateCount !== 'number') warns.push('_meta.candidateCount not a number');
  if (!Array.isArray(json.tickers)) warns.push('tickers[] missing');

  // Confidence band (only meaningful when defined).
  const band = sc.expect?.confidence;
  if (Array.isArray(band) && conf && !band.includes(conf)) {
    fails.push(`confidence "${conf}" outside expected [${band.join(',')}]`);
  }

  const isEmpty = conf === 'empty';
  if (!isEmpty) {
    // Kind structure must be populated on a non-empty result.
    if (sc.kind === 'readin') {
      if (!(json.whatTheyDo && json.whatTheyDo.trim())) fails.push('readin.whatTheyDo empty');
      if (!json.pulse || typeof json.pulse !== 'object') fails.push('readin.pulse missing');
      if (!json.smartMoney || !Array.isArray(json.smartMoney.bulls) || !Array.isArray(json.smartMoney.bears)) fails.push('readin.smartMoney malformed');
      if (!Array.isArray(json.risks)) fails.push('readin.risks missing');
    } else if (sc.kind === 'brief') {
      if (!Array.isArray(json.sections) || json.sections.length === 0) fails.push('brief.sections empty');
      if (typeof json.headline !== 'string') warns.push('brief.headline not a string');
    } else if (sc.kind === 'split') {
      if (!json.sideA || !json.sideB) fails.push('split missing sideA/sideB');
      if (!Array.isArray(json.sideA?.citations) || !Array.isArray(json.sideB?.citations)) fails.push('split sides missing citations[]');
    }

    // Phantom-pill check: every inline clip token must resolve to a returned citation.
    const citedIds = new Set(allCitations(json, sc.kind).map((c) => c && c.pineconeId).filter(Boolean));
    const referenced = prosePieces(json, sc.kind).flatMap(clipIdsIn);
    const phantom = [...new Set(referenced)].filter((id) => !citedIds.has(id));
    if (phantom.length) fails.push(`phantom clip token(s) not in citations: ${phantom.slice(0, 3).join(', ')}`);

    // Playable-receipt check on citations.
    const cites = allCitations(json, sc.kind);
    if (cites.length === 0) warns.push('no citations attached');
    const unplayable = cites.filter((c) => !c.pineconeId || !c.audioUrl || c.startTime == null);
    if (unplayable.length) warns.push(`${unplayable.length}/${cites.length} citation(s) missing audioUrl/startTime`);
  }

  // Window-expand bookkeeping (Brief older-asOfDate rows).
  if (sc.expect?.recordWindow && json._meta) {
    warns.push(`window: ${json._meta.windowDays ?? '?'}d expanded=${json._meta.windowExpanded ?? '?'}`);
  }

  return { fails, warns };
}

// ------------------------------------------------------- Layer 2: Sonnet judge
const JUDGE_DIMS = {
  readin: ['relevance', 'grounding', 'citation_quality', 'bull_bear_validity', 'confidence_honesty'],
  brief: ['relevance', 'grounding', 'citation_quality', 'source_diversity', 'confidence_honesty'],
  split: ['relevance', 'grounding', 'citation_quality', 'opposition', 'confidence_honesty'],
};
const FLAG_LIST = ['ad_read_cited', 'unsupported_or_fabricated_claim', 'off_topic_dominant', 'confidence_overstated', 'both_sides_same', 'bear_slot_not_bearish'];

function verdictTool(kind) {
  const dims = JUDGE_DIMS[kind];
  const scoreProps = {};
  dims.forEach((d) => { scoreProps[d] = { type: 'integer', minimum: 1, maximum: 5, description: `1=poor, 5=excellent (${d})` }; });
  return {
    name: 'record_verdict',
    description: 'Record the structured quality verdict for this Tape response.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['scores', 'critical_flags', 'rationale'],
      properties: {
        scores: { type: 'object', additionalProperties: false, required: dims, properties: scoreProps },
        critical_flags: { type: 'array', items: { type: 'string', enum: FLAG_LIST }, description: 'Raise only when clearly present.' },
        rationale: { type: 'string', description: 'One or two sentences justifying the scores and any flags.' },
      },
    },
  };
}

// Render a compact, judge-readable view of the response (prose + hydrated quotes).
function renderForJudge(sc, json) {
  const lines = [`REQUEST: ${sc.kind} ${JSON.stringify(sc.body)}`,
    `CONFIDENCE (self-reported): ${json._meta?.confidence}${json._meta?.confidenceReason ? ` — ${json._meta.confidenceReason}` : ''}`,
    `candidateCount=${json._meta?.candidateCount}`, ''];
  const quote = (c, i) => `   [${i + 1}] (${c.creator || '?'} — ${truncate(c.episodeTitle, 60)}) "${truncate(c.text, 240)}"`;
  if (sc.kind === 'readin') {
    lines.push(`WHAT THEY DO: ${truncate(json.whatTheyDo, 500)}`);
    lines.push(`PULSE bull: ${truncate(json.pulse?.bullLine, 200)}`);
    lines.push(`PULSE bear: ${truncate(json.pulse?.bearLine, 200)}`);
    lines.push(`RISKS: ${(json.risks || []).map((r) => truncate(typeof r === 'string' ? r : r.text, 120)).join(' | ')}`);
    lines.push('SMART MONEY — BULLS:'); (json.smartMoney?.bulls || []).forEach((c, i) => lines.push(quote(c, i)));
    lines.push('SMART MONEY — BEARS:'); (json.smartMoney?.bears || []).forEach((c, i) => lines.push(quote(c, i)));
  } else if (sc.kind === 'brief') {
    lines.push(`HEADLINE: ${json.headline}`);
    (json.sections || []).forEach((s, si) => {
      lines.push(`SECTION ${si + 1} (${s.publisher || '?'}): ${truncate(s.body || s.summary || s.text, 300)}`);
      (s.citations || []).forEach((c, i) => lines.push(quote(c, i)));
    });
  } else if (sc.kind === 'split') {
    lines.push(`SIDE A (${json.sideA?.person}): ${truncate(json.sideA?.positionSummary, 300)}`);
    (json.sideA?.citations || []).forEach((c, i) => lines.push(quote(c, i)));
    lines.push(`SIDE B (${json.sideB?.person}): ${truncate(json.sideB?.positionSummary, 300)}`);
    (json.sideB?.citations || []).forEach((c, i) => lines.push(quote(c, i)));
    lines.push(`CONTRAST: ${truncate(json.contrastSummary, 300)}`);
  }
  return lines.join('\n');
}

const JUDGE_GUIDANCE = {
  readin: 'This is a stock "Read-in" primer. Check the BEAR pulse line and SMART MONEY bear quotes are genuinely bearish substance (NOT sponsor/ad reads, promos, or neutral filler) — raise bear_slot_not_bearish or ad_read_cited if so. Grounding = prose claims supported by the quoted clips.',
  brief: 'This is a topical "Brief". Reward multiple distinct publishers and on-topic, substantive quotes. Penalize ad-reads/promos cited as evidence and claims not supported by the quotes.',
  split: 'This is a two-sided "Split". The single most important check: are side A and side B genuinely OPPOSING stances on the topic? If both sides argue the same direction, raise both_sides_same and score opposition 1-2. Also flag ad-reads cited as either side.',
};

// THIN-COVERAGE addendum: this name has little/no corpus material BY DESIGN. The
// test is whether the system makes an HONEST, decent read from what little exists
// — or degrades gracefully — WITHOUT inventing. Reward faithful use of sparse
// clips and correct graceful degradation; penalize ONLY fabrication, wrong-entity,
// or overconfidence. A thin/empty confidence label, a missing bull OR bear side,
// and an industry-fallback result (a disclaimer + related peers/sector clips) are
// all CORRECT behaviors here — do NOT penalize them or score grounding down for
// them. Only score grounding low if claims contradict / aren't in the cited clips.
const THIN_GUIDANCE = 'THIN-COVERAGE MODE: the corpus has little/no material on this name on purpose. Judge whether the read is HONEST and grounded in whatever clips exist (or correctly falls back to industry/peer context with a clear disclaimer). Thinness, a thin/empty label, a missing bull or bear side, and an industry-fallback result are EXPECTED and fine — do not penalize them. Flag ONLY: claims not supported by the cited clips (unsupported_or_fabricated_claim), a different same-named company (off_topic_dominant), or confidence overstated relative to the sparse evidence (confidence_overstated).';

async function judge(client, sc, json) {
  const tool = verdictTool(sc.kind);
  const thin = (sc.tags || []).includes('thin');
  const system = `You are a rigorous evaluator of an automated financial-podcast summarization API. Score each dimension 1-5 and raise critical flags ONLY when clearly warranted. Be skeptical: a fluent summary built on off-topic or ad-read quotes is a FAILURE, not a pass. ${JUDGE_GUIDANCE[sc.kind]}${thin ? ` ${THIN_GUIDANCE}` : ''}`;
  const user = `Evaluate this response and call record_verdict.\n\n${renderForJudge(sc, json)}`;
  const resp = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1024,
    temperature: 0,
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'record_verdict' },
    messages: [{ role: 'user', content: user }],
  });
  const block = (resp.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error('judge returned no tool_use');
  return { verdict: block.input, usage: resp.usage };
}

// Pass policy (calibrated): the critical flags are the hard fails (real defects).
// The numeric bar is "acceptable across the board, not excellent" — a score of 3
// ("on-topic and supported, if unremarkable") passes; only a 1-2 on a primary
// dimension fails. This isolates genuine defects from "good-but-not-great", which
// the original >=4 bar conflated. Tune via TAPE_EVAL_MIN_SCORE.
const MIN_SCORE = parseInt(process.env.TAPE_EVAL_MIN_SCORE || '3', 10);
// Flags that fail a THIN-coverage scenario — only the "we got it wrong" ones.
// Thinness/empty/missing-side/fallback are NOT failures in thin mode, so flags
// like bear_slot_not_bearish / both_sides_same don't count there.
const THIN_FAIL_FLAGS = new Set(['unsupported_or_fabricated_claim', 'off_topic_dominant', 'confidence_overstated', 'ad_read_cited']);
function computePass(layer1, verdict, sc) {
  if (layer1.fails.length) return { pass: false, why: layer1.fails.join('; ') };
  const thin = sc && (sc.tags || []).includes('thin');
  // No verdict = empty/no-coverage. For thin that's an HONEST result → pass.
  if (!verdict) return { pass: true, why: thin ? 'honest empty / no coverage' : 'layer1-only (empty or no-judge)' };
  const s = verdict.scores || {};
  const flags = Array.isArray(verdict.critical_flags) ? verdict.critical_flags : [];
  const reasons = [];
  if ((s.relevance ?? 0) < MIN_SCORE) reasons.push(`relevance ${s.relevance}`); // wrong/off-topic always fails
  if ((s.grounding ?? 0) < MIN_SCORE) reasons.push(`grounding ${s.grounding}`); // unfaithful to clips always fails
  if (thin) {
    // Don't fail thin on citation_quality (sparse material) or non-fatal flags.
    const fatal = flags.filter((f) => THIN_FAIL_FLAGS.has(f));
    if (fatal.length) reasons.push(`flags: ${fatal.join(',')}`);
  } else {
    if ((s.citation_quality ?? 0) < MIN_SCORE) reasons.push(`citation_quality ${s.citation_quality}`);
    if (flags.length) reasons.push(`flags: ${flags.join(',')}`);
  }
  return { pass: reasons.length === 0, why: reasons.join('; ') || 'ok' };
}

// ---------------------------------------------------------------- run one test
async function runOne(client, sc, token, runIdx) {
  const res = await postKind(sc.kind, sc.body, token);
  const layer1 = assertLayer1(sc, res);
  let verdict = null; let judgeUsage = null;
  const conf = res.json?._meta?.confidence;
  const judgeable = JUDGE_ENABLED && client && res.status === 200 && conf && conf !== 'empty' && layer1.fails.length === 0;
  if (judgeable) {
    try { const j = await judge(client, sc, res.json); verdict = j.verdict; judgeUsage = j.usage; }
    catch (err) { layer1.warns.push(`judge error: ${err.message}`); }
  }
  const { pass, why } = computePass(layer1, verdict, sc);
  const tokens = res.json?._meta?.tokens || null;
  const synthModel = sc.kind === 'readin' ? READIN_MODEL : SYNTH_MODEL;
  const cost = tokens ? costOf(synthModel, tokens) : 0;
  const quality = meanScore(verdict); // mean judge dimension (1-5); null if unjudged
  return {
    id: sc.id, kind: sc.kind, runIdx, body: sc.body, tags: sc.tags,
    status: res.status, elapsedMs: res.elapsedMs, infra: !!layer1.infra,
    confidence: conf ?? null, candidateCount: res.json?._meta?.candidateCount ?? null,
    coverageFallback: res.json?._meta?.coverageFallback || null,
    layer1Fails: layer1.fails, layer1Warns: layer1.warns,
    verdict, judgeUsage, pass, why, tokens, synthModel, cost, quality,
  };
}

// ------------------------------------------------------- concurrency + repeats
async function runPool(items, worker, size) {
  const out = new Array(items.length);
  let next = 0;
  async function lane() { while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
  return out;
}

function buildRunList(list) {
  const jobs = [];
  for (const sc of list) {
    const reps = FORCE_REPEAT > 0 ? FORCE_REPEAT : (sc.stability3x ? 3 : 1);
    for (let r = 0; r < reps; r += 1) jobs.push({ sc, runIdx: r, reps });
  }
  return jobs;
}

// ----------------------------------------------------------------- reporting
function aggregate(results) {
  const byId = new Map();
  for (const r of results) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  const perScenario = [];
  for (const [id, runs] of byId) {
    const passes = runs.filter((r) => r.pass).length;
    const infra = runs.every((r) => r.infra);
    const majorityPass = passes * 2 >= runs.length;
    const qs = runs.map((r) => r.quality).filter((q) => q != null);
    const quality = qs.length ? qs.reduce((a, b) => a + b, 0) / qs.length : null; // mean dims (1-5)
    const flagCount = new Set(runs.flatMap((r) => r.verdict?.critical_flags || [])).size;
    // Tier: PASS (clean) · SOFT (ship-with-caveats: one flag or merely-thin quality)
    // · HARD (broken: low quality or multiple flags / empty-pool band fail).
    let tier;
    if (infra) tier = 'INFRA';
    else if (majorityPass) tier = 'PASS';
    else if (quality != null && quality >= 2.5 && flagCount <= 1) tier = 'SOFT';
    else tier = 'HARD';
    perScenario.push({
      id, kind: runs[0].kind, tags: runs[0].tags, body: runs[0].body, runs: runs.length,
      passes, majorityPass, infra, quality, flagCount, tier,
      confidences: runs.map((r) => r.confidence),
      flagged: infra, // surfaced separately
      detail: runs,
    });
  }
  return perScenario;
}

function avgDims(results) {
  const sums = {}; const counts = {};
  for (const r of results) {
    if (!r.verdict) continue;
    for (const [k, v] of Object.entries(r.verdict.scores || {})) { sums[k] = (sums[k] || 0) + v; counts[k] = (counts[k] || 0) + 1; }
  }
  const out = {};
  for (const k of Object.keys(sums)) out[k] = +(sums[k] / counts[k]).toFixed(2);
  return out;
}

function mdReport(perScenario, results, meta) {
  const kinds = ['readin', 'brief', 'split'];
  const L = [];
  L.push(`# Tape eval report`, '', `- generated: ${meta.generatedAt}`, `- base: ${meta.base}`, `- judge: ${meta.judgeEnabled ? meta.judgeModel : 'DISABLED'}`, `- scenarios: ${perScenario.length} (${results.length} runs incl. repeats)`, '');

  L.push('## Pass rate by kind', '', '| kind | scenarios | passed | rate |', '|---|---|---|---|');
  for (const k of kinds) {
    const rows = perScenario.filter((s) => s.kind === k && !s.infra);
    const passed = rows.filter((s) => s.majorityPass).length;
    if (rows.length) L.push(`| ${k} | ${rows.length} | ${passed} | ${Math.round((passed / rows.length) * 100)}% |`);
  }
  const gradable = perScenario.filter((s) => !s.infra);
  const passedAll = gradable.filter((s) => s.majorityPass).length;
  L.push(`| **all** | **${gradable.length}** | **${passedAll}** | **${gradable.length ? Math.round((passedAll / gradable.length) * 100) : 0}%** |`, '');

  // Overall quality score (0-100) from mean judge dimensions — the gradient view.
  const qsAll = gradable.map((s) => s.quality).filter((q) => q != null);
  const meanQ = qsAll.length ? qsAll.reduce((a, b) => a + b, 0) / qsAll.length : 0;
  L.push('## Quality score & tiers', '', `**Overall quality: ${(meanQ / 5 * 100).toFixed(0)}/100** (mean judge dimension ${meanQ.toFixed(2)}/5)`, '');
  L.push('| kind | quality /100 | PASS | SOFT | HARD |', '|---|---|---|---|---|');
  for (const k of kinds) {
    const rows = gradable.filter((s) => s.kind === k);
    if (!rows.length) continue;
    const q = rows.map((s) => s.quality).filter((x) => x != null);
    const qm = q.length ? Math.round(q.reduce((a, b) => a + b, 0) / q.length / 5 * 100) : 0;
    const t = (name) => rows.filter((s) => s.tier === name).length;
    L.push(`| ${k} | ${qm} | ${t('PASS')} | ${t('SOFT')} | ${t('HARD')} |`);
  }
  const tAll = (name) => gradable.filter((s) => s.tier === name).length;
  L.push(`| **all** | **${(meanQ / 5 * 100).toFixed(0)}** | **${tAll('PASS')}** | **${tAll('SOFT')}** | **${tAll('HARD')}** |`, '');
  L.push('_SOFT = ship-with-caveats (one flag or merely-thin); HARD = broken (low quality / multiple flags / empty pool)._', '');

  // Synthesis cost (token usage × per-model price) + gpt-4o-mini-equivalent differential.
  const runs = perScenario.flatMap((s) => s.detail);
  const withTok = runs.filter((r) => r.tokens);
  if (withTok.length) {
    const total = withTok.reduce((a, r) => a + (r.cost || 0), 0);
    const baseline = withTok.reduce((a, r) => a + costOf('gpt-4o-mini', r.tokens), 0);
    const inTok = withTok.reduce((a, r) => a + (r.tokens.input || 0), 0);
    const outTok = withTok.reduce((a, r) => a + (r.tokens.output || 0), 0);
    L.push('## Synthesis cost', '', `- models: non-readin=\`${SYNTH_MODEL}\`, readin=\`${READIN_MODEL}\``,
      `- tokens: ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out across ${withTok.length} synths`,
      `- **total synth cost: $${total.toFixed(4)}** (${(total / withTok.length * 1000).toFixed(2)}¢ per synth × 1000)`,
      `- same tokens at gpt-4o-mini: $${baseline.toFixed(4)} → **${baseline > 0 ? (total / baseline).toFixed(1) : '∞'}× differential**`, '');
  }

  const dims = avgDims(results);
  if (Object.keys(dims).length) {
    L.push('## Judge dimension averages (1-5)', '', '| dimension | avg |', '|---|---|');
    for (const [k, v] of Object.entries(dims)) L.push(`| ${k} | ${v} |`);
    L.push('');
  }

  const failures = gradable.filter((s) => !s.majorityPass);
  L.push(`## Failures (${failures.length})`, '');
  if (failures.length === 0) L.push('_none_', '');
  else {
    L.push('| id | kind | conf | why |', '|---|---|---|---|');
    for (const s of failures) {
      const r = s.detail.find((x) => !x.pass) || s.detail[0];
      L.push(`| ${s.id} | ${s.kind} | ${s.confidences.join('/')} | ${truncate((r.why || '') + (r.verdict ? ` — ${r.verdict.rationale}` : ''), 160).replace(/\|/g, '\\|')} |`);
    }
    L.push('');
  }

  const repeated = perScenario.filter((s) => s.runs > 1);
  if (repeated.length) {
    L.push('## Stability (repeated scenarios)', '', '| id | runs | passes | confidences |', '|---|---|---|---|');
    for (const s of repeated) L.push(`| ${s.id} | ${s.runs} | ${s.passes}/${s.runs} | ${s.confidences.join(', ')} |`);
    L.push('');
  }

  const infra = perScenario.filter((s) => s.infra);
  if (infra.length) {
    L.push(`## Infra / skipped (${infra.length})`, '', '_rate-limit (429) or network/5xx — not quality failures; restart the server to reset in-memory rate counters and re-run._', '');
    for (const s of infra) L.push(`- ${s.id} (${s.kind}): ${truncate((s.detail[0].layer1Fails.concat(s.detail[0].layer1Warns)).join('; '), 120)}`);
    L.push('');
  }

  // Thin-coverage cohort — graded on honest handling of limited info, not richness.
  const thin = perScenario.filter((s) => (s.tags || []).includes('thin'));
  if (thin.length) {
    const passed = thin.filter((s) => s.majorityPass).length;
    L.push(`## Thin-coverage cohort (${passed}/${thin.length} ok — honest-read-or-graceful-fallback, no fabrication)`, '',
      '| ticker | conf | outcome | ok | note |', '|---|---|---|---|---|');
    for (const s of thin) {
      const r = s.detail[0];
      const outcome = r.coverageFallback === 'industry' ? 'industry-fallback'
        : r.confidence === 'empty' ? 'honest-empty'
        : `analyzed (${r.candidateCount} clips)`;
      const why = s.majorityPass ? '' : truncate((r.why || '') + (r.verdict ? ` — ${r.verdict.rationale}` : ''), 110).replace(/\|/g, '\\|');
      L.push(`| ${s.body?.ticker || s.id} | ${s.confidences.join('/')} | ${outcome} | ${s.majorityPass ? '✓' : '✗'} | ${why} |`);
    }
    L.push('');
  }

  const lat = results.map((r) => r.elapsedMs).sort((a, b) => a - b);
  if (lat.length) {
    const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];
    L.push('## Latency (ms)', '', `- p50 ${p(0.5)} · p90 ${p(0.9)} · max ${lat[lat.length - 1]}`, '');
  }
  return L.join('\n');
}

// ----------------------------------------------------------------------- main
async function main() {
  let list = scenarios.filter((s) => (!ONLY || s.kind === ONLY) && (!TAG || (s.tags || []).includes(TAG)));
  if (LIMIT > 0) list = list.slice(0, LIMIT);
  if (list.length === 0) { console.error('No scenarios match the filter.'); process.exit(2); }

  // Auth exactly as the post-login frontend: a scoped Tape JWT.
  let token;
  try { token = signTapeToken().token; }
  catch (err) { console.error(`Cannot mint Tape JWT: ${err.message}\nIs TAPE_AUTH_SECRET set in .env?`); process.exit(2); }

  // Preflight: confirm the server is up.
  const ping = await postKind('readin', { ticker: 'AAPL' }, token).catch(() => ({ status: 0 }));
  if (ping.status === 0) { console.error(`No server at ${BASE}. Start it: node server.js`); process.exit(2); }

  let client = null;
  if (JUDGE_ENABLED) {
    if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set — run with --no-judge for Layer 1 only.'); process.exit(2); }
    client = new Anthropic();
  }

  const jobs = buildRunList(list);
  console.log(`Running ${jobs.length} request(s) across ${list.length} scenario(s) → ${BASE} (judge: ${JUDGE_ENABLED ? JUDGE_MODEL : 'off'}, concurrency ${CONCURRENCY})\n`);

  let done = 0;
  const results = await runPool(jobs, async (job) => {
    const r = await runOne(client, job.sc, token, job.runIdx);
    done += 1;
    const mark = r.infra ? '∼' : (r.pass ? '✓' : '✗');
    console.log(`${mark} [${done}/${jobs.length}] ${r.id}#${r.runIdx} ${r.kind} conf=${r.confidence ?? '-'} ${r.elapsedMs}ms ${r.pass ? '' : `(${truncate(r.why, 80)})`}`);
    return r;
  }, CONCURRENCY);

  const perScenario = aggregate(results);
  const meta = { generatedAt: new Date().toISOString(), base: BASE, judgeEnabled: JUDGE_ENABLED, judgeModel: JUDGE_MODEL };
  const md = mdReport(perScenario, results, meta);

  const stamp = meta.generatedAt.replace(/[:.]/g, '-');
  const dir = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `tape-eval-${stamp}.json`);
  const mdPath = path.join(dir, `tape-eval-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify({ meta, perScenario, results }, null, 2));
  fs.writeFileSync(mdPath, md);

  console.log(`\n${md}\n`);
  console.log(`Reports written:\n  ${jsonPath}\n  ${mdPath}`);

  const gradable = perScenario.filter((s) => !s.infra);
  const failed = gradable.filter((s) => !s.majorityPass);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
