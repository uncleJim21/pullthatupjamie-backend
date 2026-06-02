#!/usr/bin/env node
/**
 * Ground-truth probe for /api/tape/synthesize.
 *
 * Runs real topic-quotes -> synthesize for `brief` and `readin` against the
 * local server and dumps EXACTLY what the model emits (verbatim text, tokens,
 * section markers, clip-token integrity) so we can tell whether thin/empty
 * output is a backend-prompt issue or a client-parser issue.
 *
 * Usage:  node scripts/tape-synth-groundtruth.js [baseUrl]
 *         (defaults to http://localhost:4132)
 */

require('dotenv').config();
const { signTapeToken } = require('../services/tape/tapeAuth');

const BASE = process.argv[2] || `http://localhost:${process.env.PORT || 4132}`;

const SCENARIOS = [
  {
    kind: 'brief',
    topicQuotes: { query: 'Federal Reserve interest rates', themes: ['Federal Reserve interest rates inflation', 'Fed rate cut policy outlook'], filters: { mainstream: true, candidatesLimit: 14 } },
    input: { topic: 'The Fed and interest rates' },
  },
  {
    kind: 'readin',
    topicQuotes: { query: 'Oracle ORCL', themes: ['Oracle ORCL cloud growth earnings', 'Oracle stock AI datacenter'], filters: { mainstream: true, candidatesLimit: 12 } },
    input: { topic: 'Oracle (ORCL)', ticker: 'ORCL' },
  },
  {
    kind: 'readin',
    topicQuotes: { query: 'CRWV', themes: ['CRWV', 'CRWV stock company business'], filters: { mainstream: true, candidatesLimit: 20 } },
    input: { ticker: 'CRWV', depth: 'quick' },
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

function analyze(text, candidates) {
  const markers = (text.match(/^##\s*[^\n]+/gm) || []).map((s) => s.trim());
  const clipIds = [...text.matchAll(/\{\{clip:([^}]+)\}\}/g)].map((m) => m[1]);
  const candIds = new Set(candidates.map((c) => c.pineconeId));
  const validClips = clipIds.filter((id) => candIds.has(id));
  return {
    chars: text.length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    markers,
    clipTokens: clipIds.length,
    clipTokensValid: validClips.length,
    clipSample: clipIds.slice(0, 3),
    candIdSample: [...candIds].slice(0, 3),
  };
}

(async () => {
  let token;
  try { token = signTapeToken().token; }
  catch (e) { console.error('Cannot mint token — is TAPE_AUTH_SECRET set in .env?', e.message); process.exit(1); }

  for (const sc of SCENARIOS) {
    console.log('\n' + '='.repeat(78));
    console.log(`SCENARIO: kind=${sc.kind}  topic="${sc.input.topic}"`);
    console.log('='.repeat(78));

    const tq = await call('/api/tape/topic-quotes', token, sc.topicQuotes);
    if (tq.status !== 200) { console.log('topic-quotes FAILED', tq.status, tq.json); continue; }
    const candidates = (tq.json.candidates || []).slice(0, 10);
    console.log(`topic-quotes -> ${tq.json.candidates?.length || 0} candidates (using ${candidates.length})`);
    if (!candidates.length) { console.log('NO CANDIDATES — nothing to synthesize. (retrieval issue, not synthesize)'); continue; }
    console.log('sample candidate:', JSON.stringify({ pineconeId: candidates[0].pineconeId, creator: candidates[0].creator, text: (candidates[0].text || '').slice(0, 80) + '…' }));

    const syn = await call('/api/tape/synthesize', token, {
      kind: sc.kind, input: sc.input, candidates, model: 'fast', stream: false, refresh: true,
    });
    if (syn.status !== 200) { console.log('synthesize FAILED', syn.status, syn.json); continue; }

    const text = syn.json.text || '';
    const a = analyze(text, candidates);
    console.log('\n--- SYNTHESIZE RESULT ---');
    console.log('model:', syn.json.model, '| tokens:', JSON.stringify(syn.json.tokens), '| elapsedMs:', syn.json.elapsedMs);
    console.log('analysis:', JSON.stringify(a, null, 2));
    console.log('\n--- RAW TEXT (verbatim, between markers) ---');
    console.log('>>>>>>>>>>');
    console.log(text);
    console.log('<<<<<<<<<<');
  }
  console.log('\nDone.');
})();
