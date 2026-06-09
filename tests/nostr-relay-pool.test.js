#!/usr/bin/env node
/**
 * Unit tests for utils/nostrRelayPool RelayRotation.
 *
 *   node tests/nostr-relay-pool.test.js
 *
 * Pure node assertions, no test framework. A non-zero exit code
 * indicates at least one scenario failed.
 */

const assert = require('assert');
const { RelayRotation, RELAY_POOL, DEFAULT_SLICE_SIZE } = require('../utils/nostrRelayPool');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log('RelayRotation');

test('pool has 12 relays, all unique wss URLs', () => {
  assert.strictEqual(RELAY_POOL.length, 12);
  assert.strictEqual(new Set(RELAY_POOL).size, 12, 'relays must be unique');
  for (const url of RELAY_POOL) {
    assert.ok(/^wss:\/\/.+/.test(url), `bad relay url: ${url}`);
  }
});

test('default slice sweeps the whole pool exactly once per rotation', () => {
  const r = new RelayRotation({});
  const ticksPerRotation = RELAY_POOL.length / DEFAULT_SLICE_SIZE; // 12/3 = 4
  assert.ok(Number.isInteger(ticksPerRotation), 'pool should divide evenly by default slice');
  const seen = new Map();
  for (let t = 0; t < ticksPerRotation; t++) {
    const slice = r.next();
    assert.strictEqual(slice.length, DEFAULT_SLICE_SIZE);
    for (const url of slice) seen.set(url, (seen.get(url) || 0) + 1);
  }
  assert.strictEqual(seen.size, RELAY_POOL.length, 'every relay covered');
  for (const [url, count] of seen) {
    assert.strictEqual(count, 1, `${url} polled ${count}x, expected exactly 1 per rotation`);
  }
});

test('cursor wraps and continues across rotations', () => {
  const r = new RelayRotation({});
  const first = [];
  const second = [];
  for (let t = 0; t < 4; t++) first.push(...r.next());
  for (let t = 0; t < 4; t++) second.push(...r.next());
  assert.deepStrictEqual(second, first, 'second full rotation should repeat the first');
});

test('uneven slice size still wraps without gaps over a full cycle', () => {
  // sliceSize 5 over 12: cursor visits 0,5,10,3(wrap),8,1(wrap)... a full
  // cycle of 12 ticks must cover every relay an equal number of times.
  const r = new RelayRotation({ sliceSize: 5 });
  const seen = new Map();
  for (let t = 0; t < RELAY_POOL.length; t++) {
    for (const url of r.next()) seen.set(url, (seen.get(url) || 0) + 1);
  }
  assert.strictEqual(seen.size, RELAY_POOL.length, 'every relay covered over a full cycle');
  const counts = [...seen.values()];
  assert.ok(counts.every((c) => c === counts[0]), 'coverage should be uniform across relays');
});

test('sliceSize is clamped to the relay list length', () => {
  const r = new RelayRotation({ relays: ['wss://a', 'wss://b'], sliceSize: 3 });
  const slice = r.next();
  assert.strictEqual(slice.length, 2, 'cannot poll more relays than exist');
  assert.deepStrictEqual(slice, ['wss://a', 'wss://b']);
});

test('explicit relays override the pool (test/override path)', () => {
  const r = new RelayRotation({ relays: ['wss://only.example'], sliceSize: 1 });
  assert.strictEqual(r.poolSize, 1);
  assert.deepStrictEqual(r.next(), ['wss://only.example']);
  assert.deepStrictEqual(r.next(), ['wss://only.example']);
});

console.log(`\n${passed} passed`);
