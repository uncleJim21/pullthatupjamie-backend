#!/usr/bin/env node
/**
 * Evidence probe for the new /api/tape/synthesize `kind: 'narrative'`.
 *
 * Runs the three queries from the Narrative endpoint spec end-to-end against the
 * local server (retrieve via topic-quotes/person-quotes with recency weighting
 * OFF, then synthesize) and dumps the verbatim `synthesize.text` plus a parse of
 * the bucket/sentiment trajectory so we can validate the marker contract before
 * wiring narrativeService.ts to the live endpoint.
 *
 * Usage:  node scripts/tape-narrative-evidence.js [baseUrl]
 *         (defaults to http://localhost:<PORT|4132>)
 */

require('dotenv').config();
const { signTapeToken } = require('../services/tape/tapeAuth');

const BASE = process.argv[2] || `http://localhost:${process.env.PORT || 4132}`;

// Wide window + recency off + ~60 candidates, per spec §3 (retrieval expectations).
const NARR_FILTERS = { kind: 'narrative', candidatesLimit: 60, disableRecencyWeighting: true, mainstream: true };

const SCENARIOS = [
  {
    label: 'canon-shaped (named person)',
    route: 'person-quotes',
    body: {
      name: 'Luke Gromen',
      themes: ['the sovereign debt endgame', 'fiscal dominance debt spiral', 'US debt interest expense'],
      filters: { ...NARR_FILTERS },
    },
    input: { topic: 'the sovereign debt endgame', group: 'Luke Gromen' },
  },
  {
    label: 'bull-bear consensus (bears side)',
    route: 'topic-quotes',
    body: {
      query: 'the AI bubble',
      themes: ['AI bubble overvaluation', 'AI capex bubble burst', 'AI hype unsustainable'],
      groupBy: 'bull-bear',
      filters: { ...NARR_FILTERS },
    },
    group: 'bear', // keep only the bear side of the classifier
    input: { topic: 'the AI bubble', group: 'bears' },
  },
  {
    label: 'open consensus (no group)',
    route: 'topic-quotes',
    body: {
      query: 'rate cuts in 2026',
      themes: ['Fed rate cuts 2026', 'interest rate cut outlook 2026', 'Federal Reserve easing 2026'],
      filters: { ...NARR_FILTERS },
    },
    input: { topic: 'rate cuts in 2026' },
  },
];

async function call(path, token, body, method = 'POST') {
  const resp = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

// Pull the bucket lines and parse the chronological sentiment trajectory.
function parseTrajectory(text) {
  const lines = text.match(/^##\s*BUCKET\s*\|.*$/gim) || [];
  return lines.map((line) => {
    const parts = line.split('|').map((s) => s.trim());
    return { start: parts[1], end: parts[2], sentiment: parts[3] };
  });
}

function dateSpan(candidates) {
  const dates = candidates.map((c) => c.publishedDate).filter(Boolean).map((d) => String(d).slice(0, 10)).sort();
  return dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : 'n/a';
}

async function main() {
  const { token } = signTapeToken();
  console.log(`Base: ${BASE}\n`);

  for (const sc of SCENARIOS) {
    console.log('═'.repeat(78));
    console.log(`SCENARIO: ${sc.label}`);
    console.log(`  topic="${sc.input.topic}"${sc.input.group ? `  group="${sc.input.group}"` : ''}  via /${sc.route}`);
    console.log('─'.repeat(78));

    // 1) retrieve candidates
    const r = await call(`/api/tape/${sc.route}`, token, sc.body);
    if (r.status !== 200 || !r.json) {
      console.log(`  RETRIEVAL FAILED: status=${r.status} body=${JSON.stringify(r.json)}\n`);
      continue;
    }
    let candidates = r.json.candidates || [];
    if (sc.group && Array.isArray(r.json.groups)) {
      const g = r.json.groups.find((x) => String(x.key).toLowerCase().startsWith(sc.group));
      candidates = (g && g.candidates) || [];
      console.log(`  groups: ${r.json.groups.map((x) => `${x.key}(${x.candidates.length})`).join(', ')}`);
    }
    console.log(`  candidates: ${candidates.length}  | span: ${dateSpan(candidates)}  | weightingDisabled: ${r.json._meta?.weightingDisabled}`);
    if (!candidates.length) { console.log('  no candidates — skipping synthesize\n'); continue; }

    // 2) synthesize narrative
    const s = await call('/api/tape/synthesize', token, {
      kind: 'narrative', input: sc.input, candidates, model: 'fast',
    });
    if (s.status !== 200 || !s.json) {
      console.log(`  SYNTHESIZE FAILED: status=${s.status} body=${JSON.stringify(s.json)}\n`);
      continue;
    }
    const text = s.json.text || '';
    const traj = parseTrajectory(text);
    console.log(`  synthesize: status=200  model=${s.json.model}  tokens=${JSON.stringify(s.json.tokens)}  elapsedMs=${s.json.elapsedMs}`);
    console.log(`  tickers: ${JSON.stringify(s.json.tickers)}`);
    console.log(`  buckets: ${traj.length}  trajectory: ${traj.map((b) => b.sentiment).join(' → ')}`);
    if (s.json._meta?.synthesizedEmpty) console.log(`  ⚠ synthesizedEmpty: ${s.json._meta.reason}`);
    if (s.json._meta?.complianceRecovered) console.log('  ⚠ complianceRecovered (passed on auto-retry)');
    console.log('\n  ── raw synthesize.text ──────────────────────────────────────────────');
    console.log(text.split('\n').map((l) => `  ${l}`).join('\n'));
    console.log('');
  }
  console.log('═'.repeat(78));
}

main().catch((err) => { console.error(err); process.exit(1); });
