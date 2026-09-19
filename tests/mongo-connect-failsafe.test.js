#!/usr/bin/env node
/**
 * Regression for utils/mongoConnect.js — no database needed.
 *
 *   node tests/mongo-connect-failsafe.test.js
 *
 * Asserts: the initial connect retries with capped exponential backoff until
 * it succeeds; requireDb() answers 503 with a specific body while disconnected.
 */
const assert = require('assert');
const { connectWithRetry, requireDb, dbReady, dbSnapshot } = require('../utils/mongoConnect');
const quiet = { log() {}, warn() {}, error() {} };

(async () => {
  // 1) fails 3x then connects; delays must be 1s, 2s, 4s
  let calls = 0; const delays = [];
  await connectWithRetry('mongodb://fake', {
    connect: async () => { if (++calls < 4) throw new Error(`boom ${calls}`); },
    sleep: async (ms) => { delays.push(ms); },
    log: quiet,
  });
  assert.strictEqual(calls, 4, 'connected on 4th attempt');
  assert.deepStrictEqual(delays, [1000, 2000, 4000], 'exponential backoff');

  // 2) backoff caps at maxDelayMs
  calls = 0; delays.length = 0;
  await connectWithRetry('mongodb://fake', {
    connect: async () => { if (++calls < 6) throw new Error('boom'); },
    sleep: async (ms) => { delays.push(ms); },
    baseDelayMs: 1000, maxDelayMs: 3000, log: quiet,
  });
  assert.deepStrictEqual(delays, [1000, 2000, 3000, 3000, 3000], 'capped backoff');

  // 3) missing URI is a hard error, not an infinite loop
  await assert.rejects(connectWithRetry(''), /no MongoDB URI/);

  // 4) requireDb: real mongoose is not connected in this test -> 503 + specific body
  assert.strictEqual(dbReady(), false);
  const headers = {}; let statusCode = null; let body = null; let nextCalled = false;
  const res = { set: (k, v) => { headers[k] = v; }, status: (c) => { statusCode = c; return res; }, json: (b) => { body = b; } };
  requireDb({}, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(statusCode, 503);
  assert.strictEqual(headers['Retry-After'], '5');
  assert.strictEqual(body.error, 'database_unavailable');
  assert.strictEqual(body.db.status, 'disconnected');
  assert.ok('lastError' in dbSnapshot());

  console.log('PASS mongo-connect-failsafe (4 cases)');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
