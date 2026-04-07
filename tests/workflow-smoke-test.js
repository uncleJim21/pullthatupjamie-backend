/**
 * Smoke test for the workflow endpoint.
 * 
 * Runs against a live server instance.
 * Usage: node tests/workflow-smoke-test.js [base_url]
 * Default base_url: http://localhost:3000
 */

const http = require('http');
const https = require('https');

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const TIMEOUT_MS = 120000;

const TEST_CASES = [
  {
    name: 'Deep topic research (structured)',
    body: {
      task: 'What are podcasters saying about AI regulation this month',
      maxIterations: 3,
      outputFormat: 'structured',
      context: {},
    },
    expectFields: ['status', 'sessionId', 'iterationsUsed', 'results'],
  },
  {
    name: 'Person dossier (text format)',
    body: {
      task: 'Find everything Lyn Alden has said about the fiscal deficit on podcasts',
      maxIterations: 3,
      outputFormat: 'text',
      context: {},
    },
    expectFields: ['status', 'sessionId', 'text'],
  },
  {
    name: 'Open-ended research',
    body: {
      task: 'Help me understand the debate around open source AI models',
      maxIterations: 2,
      outputFormat: 'structured',
      context: {},
    },
    expectFields: ['status', 'sessionId'],
  },
];

function makeRequest(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const lib = url.protocol === 'https:' ? https : http;

    const payload = JSON.stringify(body);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: TIMEOUT_MS,
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

async function runTest(testCase) {
  const start = Date.now();
  console.log(`\n--- ${testCase.name} ---`);
  console.log(`Task: "${testCase.body.task}"`);

  try {
    const result = await makeRequest('/api/chat/workflow', testCase.body);
    const elapsed = Date.now() - start;

    console.log(`Status: ${result.status} (${elapsed}ms)`);

    if (result.status === 402) {
      console.log('  -> 402 Payment Required (expected if no L402 credits)');
      console.log('  SKIP (auth required)');
      return { name: testCase.name, status: 'skipped', reason: 'payment_required' };
    }

    if (result.status === 200 || result.status === 202) {
      const body = result.body;
      const missing = testCase.expectFields.filter(f => !(f in body));

      if (missing.length > 0) {
        console.log(`  FAIL: Missing fields: ${missing.join(', ')}`);
        console.log('  Response keys:', Object.keys(body).join(', '));
        return { name: testCase.name, status: 'fail', missing };
      }

      console.log(`  Status: ${body.status}`);
      console.log(`  Iterations: ${body.iterationsUsed}`);
      console.log(`  Session: ${body.sessionId}`);

      if (body.results?.clips) {
        console.log(`  Clips: ${body.results.clips.length}`);
        if (body.results.clips[0]) {
          const clip = body.results.clips[0];
          console.log(`  First clip: "${(clip.text || '').substring(0, 60)}..." from ${clip.podcast}`);
          console.log(`  Share URL: ${clip.shareUrl}`);
        }
      }

      if (body.text) {
        console.log(`  Text length: ${body.text.length} chars`);
        console.log(`  First 100 chars: ${body.text.substring(0, 100)}...`);
      }

      if (body.cost) {
        console.log(`  Cost: charged=$${body.cost.charged / 1000000}, creditBack=$${body.cost.creditBack / 1000000}, net=$${body.cost.net / 1000000}`);
      }

      console.log('  PASS');
      return { name: testCase.name, status: 'pass', elapsed };
    }

    console.log(`  FAIL: Unexpected status ${result.status}`);
    console.log('  Body:', JSON.stringify(result.body).substring(0, 200));
    return { name: testCase.name, status: 'fail', httpStatus: result.status };

  } catch (error) {
    const elapsed = Date.now() - start;
    console.log(`  ERROR (${elapsed}ms): ${error.message}`);
    return { name: testCase.name, status: 'error', error: error.message };
  }
}

async function main() {
  console.log(`Workflow Smoke Test`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Running ${TEST_CASES.length} test cases...\n`);

  // Quick health check
  try {
    const healthGet = await new Promise((resolve, reject) => {
      const url = new URL('/health', BASE_URL);
      const lib = url.protocol === 'https:' ? https : http;
      lib.get(url, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode }));
      }).on('error', reject);
    });
    console.log(`Health check: ${healthGet.status}`);
  } catch (e) {
    console.log(`WARNING: Health check failed (${e.message}). Server may not be running.`);
  }

  const results = [];
  for (const tc of TEST_CASES) {
    results.push(await runTest(tc));
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    const icon = r.status === 'pass' ? 'PASS' : r.status === 'skipped' ? 'SKIP' : 'FAIL';
    console.log(`  ${icon}: ${r.name}${r.elapsed ? ` (${r.elapsed}ms)` : ''}`);
  }

  const passed = results.filter(r => r.status === 'pass').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const failed = results.filter(r => r.status !== 'pass' && r.status !== 'skipped').length;
  console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
