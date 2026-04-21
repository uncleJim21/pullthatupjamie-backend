#!/usr/bin/env node

/**
 * HTTP Route Smoke Test
 *
 * Verifies that the HTTP endpoints still work after the service-extraction
 * refactor. Each test hits the real local server and checks for a 200 response
 * with the expected shape.
 *
 * Usage:
 *   node tests/http-route-smoke.js
 *
 * Requires the server running on localhost:4132.
 * Uses the JWT from the JWT_TEST_TOKEN env var (or reads from .env).
 */

require('dotenv').config();

const BASE = process.env.JAMIE_API_BASE || 'http://localhost:4132';
const JWT = process.env.JWT_TEST_TOKEN;

if (!JWT) {
  console.error('ERROR: JWT_TEST_TOKEN not found in environment. Set it in .env or export it.');
  process.exit(1);
}

const AUTH = { 'Authorization': `Bearer ${JWT}`, 'Content-Type': 'application/json' };

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function json(method, path, body) {
  const opts = { method, headers: AUTH };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${BASE}${path}`, opts);
  const data = await resp.json();
  return { status: resp.status, data };
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nHTTP Route Smoke Tests (${BASE})\n`);

  // --- Corpus routes ---

  await test('GET /api/corpus/feeds/:feedId', async () => {
    const { status, data } = await json('GET', '/api/corpus/feeds/1015378');
    assert(status === 200, `status ${status}`);
    assert(data.data && data.data.feedId, 'missing data.data.feedId');
  });

  await test('GET /api/corpus/feeds/:feedId/episodes', async () => {
    const { status, data } = await json('GET', '/api/corpus/feeds/1015378/episodes?limit=3');
    assert(status === 200, `status ${status}`);
    assert(Array.isArray(data.data), 'data.data not an array');
    assert(data.pagination, 'missing pagination');
  });

  await test('GET /api/corpus/episodes/:guid (first from feed)', async () => {
    const { data: feedData } = await json('GET', '/api/corpus/feeds/1015378/episodes?limit=1');
    const guid = feedData.data?.[0]?.guid;
    assert(guid, 'no episode guid found in feed');
    const { status, data } = await json('GET', `/api/corpus/episodes/${encodeURIComponent(guid)}`);
    assert(status === 200, `status ${status}`);
    assert(data.data && data.data.guid, 'missing data.data.guid');
  });

  await test('GET /api/corpus/chapters?guids=...', async () => {
    const { data: feedData } = await json('GET', '/api/corpus/feeds/1015378/episodes?limit=1');
    const guid = feedData.data?.[0]?.guid;
    assert(guid, 'no episode guid');
    const { status, data } = await json('GET', `/api/corpus/chapters?guids=${encodeURIComponent(guid)}&limit=3`);
    assert(status === 200, `status ${status}`);
    assert(Array.isArray(data.data), 'data.data not an array');
  });

  await test('GET /api/corpus/people?search=...', async () => {
    const { status, data } = await json('GET', '/api/corpus/people?search=Peter&limit=3');
    assert(status === 200, `status ${status}`);
    assert(Array.isArray(data.data), 'data.data not an array');
    assert(data.pagination, 'missing pagination');
  });

  await test('POST /api/corpus/people/episodes', async () => {
    const { status, data } = await json('POST', '/api/corpus/people/episodes', {
      name: 'Peter McCormack', limit: 3,
    });
    assert(status === 200, `status ${status}`);
    assert(Array.isArray(data.data), 'data.data not an array');
  });

  // --- Search routes ---

  await test('POST /api/search-chapters', async () => {
    const { status, data } = await json('POST', '/api/search-chapters', {
      search: 'Bitcoin', limit: 3,
    });
    assert(status === 200, `status ${status}`);
    assert(Array.isArray(data.data), 'data.data not an array');
    assert(data.pagination, 'missing pagination');
  });

  await test('POST /api/search-quotes', async () => {
    const { status, data } = await json('POST', '/api/search-quotes', {
      query: 'lightning network privacy', limit: 3,
    });
    assert(status === 200, `status ${status}`);
    assert(Array.isArray(data.results), 'data.results not an array');
    assert(data.results.length > 0, 'no results returned');
  });

  // --- Summary ---

  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
