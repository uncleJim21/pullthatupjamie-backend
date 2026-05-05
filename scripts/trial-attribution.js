#!/usr/bin/env node
/**
 * Generic attribution probe — prints the full SSE-final text + clip list
 * so we can eyeball whether the synthesizer is misattributing quotes.
 *
 * Usage:  node scripts/trial-attribution.js "<query>" [trials]
 */

const http = require('http');
require('dotenv').config();

const QUERY = process.argv[2] || 'Create a summary of Jim Carucci\'s latest podcast appearance';
const TRIALS = parseInt(process.argv[3] || '2', 10);
const PORT = 4132;
const JWT = process.env.JWT_TEST_TOKEN;
if (!JWT) {
  console.error('JWT_TEST_TOKEN not set in .env — cannot run probe.');
  process.exit(1);
}

function runTrial(trialNum) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ message: QUERY, mode: 'deep' });
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: '/api/pull',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'text/event-stream',
        Authorization: `Bearer ${JWT}`,
      },
    };

    const result = {
      trialNum,
      toolCalls: [],
      finalText: '',
      requestId: null,
      error: null,
    };

    const req = http.request(options, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop();
        for (const block of blocks) {
          const lines = block.split('\n');
          let eventType = null;
          let dataRaw = null;
          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataRaw = line.slice(6).trim();
          }
          if (!dataRaw || dataRaw === '[DONE]') continue;
          let payload;
          try { payload = JSON.parse(dataRaw); } catch { continue; }
          const type = eventType || payload.type;
          if (type === 'request_id') result.requestId = payload.requestId;
          if (type === 'tool_call') {
            result.toolCalls.push(`${payload.tool || payload.name}(${JSON.stringify(payload.input || {}).substring(0, 80)})`);
          }
          if (type === 'text_delta') result.finalText += payload.text || '';
          if (type === 'text_done') result.finalText = payload.text || result.finalText;
        }
      });
      res.on('end', () => resolve(result));
    });

    req.on('error', (e) => { result.error = e.message; resolve(result); });
    req.setTimeout(180000, () => { result.error = 'timeout'; req.destroy(); });
    req.write(body); req.end();
  });
}

async function main() {
  console.log(`\nQUERY: "${QUERY}"\n${'='.repeat(80)}`);
  const promises = Array.from({ length: TRIALS }, (_, i) => runTrial(i + 1));
  const results = await Promise.all(promises);
  for (const r of results) {
    console.log(`\n--- Trial ${r.trialNum} ---`);
    if (r.error) { console.log('ERROR:', r.error); continue; }
    console.log('Tool calls:');
    for (const t of r.toolCalls) console.log('  ' + t);
    console.log('\nFinal text:\n' + r.finalText);
    const clips = (r.finalText.match(/\{\{clip:[^}]+\}\}/g) || []);
    if (clips.length) {
      console.log('\nClips cited (episode GUID prefix):');
      for (const c of clips) {
        const id = c.match(/\{\{clip:([^}]+)\}\}/)[1];
        const ep = id.split('_p')[0];
        console.log('  ' + ep);
      }
    }
  }
  console.log('\n' + '='.repeat(80));
}

main();
