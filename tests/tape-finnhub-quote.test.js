#!/usr/bin/env node
/**
 * Contract suite for the Finnhub quote provider's normalized shape.
 *
 *   node tests/tape-finnhub-quote.test.js
 *
 * No mocha/jest dependency — pure node assertions. `global.fetch` is stubbed
 * per scenario so the suite runs offline with no API key and no network.
 *
 * Goal: a Finnhub-served quote must be the SAME shape as a Yahoo-served quote
 * (tape-backend-spec §5) so the frontend can't tell them apart. The sparkline
 * component renders nothing when spark.length < 2, so the headline guarantee
 * under test is: spark ALWAYS has >= 2 points, even on the Finnhub free tier
 * where the historical-candle endpoint 403s.
 *
 * A non-zero exit code indicates at least one scenario failed.
 */

const assert = require('assert');

process.env.FINNHUB_API_KEY = 'test-key'; // make the provider think it's configured

// The provider reads global fetch at call time, so we swap it per scenario.
let fetchHandler = null;
global.fetch = async (url) => {
  if (!fetchHandler) throw new Error('no fetch handler installed');
  return fetchHandler(String(url));
};

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}
function errResponse(status) {
  return { ok: false, status, json: async () => ({}) };
}

// The canonical Yahoo-shape keys every provider must emit (provider-blind).
const REQUIRED_KEYS = ['symbol', 'name', 'price', 'currency', 'dayChangePct', 'spark', 'marketState'];

let passed = 0;
let failed = 0;
const failures = [];
function check(cond, message) {
  if (cond) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; failures.push(message); console.log(`  ✗ ${message}`); }
}

function assertContractShape(quote, label) {
  check(REQUIRED_KEYS.every((k) => k in quote), `${label}: has all required keys (${REQUIRED_KEYS.join(', ')})`);
  check(Array.isArray(quote.spark) && quote.spark.length >= 2,
    `${label}: spark is an array with >= 2 points (got ${Array.isArray(quote.spark) ? quote.spark.length : typeof quote.spark})`);
  check(quote.spark.every((v) => Number.isFinite(v)), `${label}: every spark point is a finite number`);
  check(typeof quote.name === 'string' && quote.name.length > 0, `${label}: name is a non-empty string`);
  check(typeof quote.symbol === 'string' && quote.symbol.length > 0, `${label}: symbol is a non-empty string`);
  check(quote.price === null || Number.isFinite(quote.price), `${label}: price is null or finite`);
  check(quote.currency === 'USD', `${label}: currency is USD`);
  check(quote.dayChangePct === null || Number.isFinite(quote.dayChangePct), `${label}: dayChangePct is null or finite`);
  // marketState type must be consistent with Yahoo's enum (string) or null.
  check(quote.marketState === null || typeof quote.marketState === 'string',
    `${label}: marketState is a string or null (got ${typeof quote.marketState})`);
}

// --- Scenario builders -----------------------------------------------------

// Finnhub /quote payload for a healthy symbol (free tier returns these fields).
const QUOTE_PAYLOAD = { c: 140.85, d: 3.58, dp: 2.61, h: 141.9, l: 137.2, o: 138.0, pc: 137.27, t: 1700000000 };

function freeTierHandler(url) {
  if (url.includes('/quote?')) return jsonResponse(QUOTE_PAYLOAD);
  if (url.includes('/stock/candle')) return errResponse(403);   // paid-only on free tier
  if (url.includes('/stock/profile2')) return jsonResponse({ name: 'United States Oil Fund' });
  throw new Error(`unexpected url ${url}`);
}

function freeTierNoProfileHandler(url) {
  if (url.includes('/quote?')) return jsonResponse(QUOTE_PAYLOAD);
  if (url.includes('/stock/candle')) return errResponse(403);
  if (url.includes('/stock/profile2')) return errResponse(403); // profile2 also gated
  throw new Error(`unexpected url ${url}`);
}

function paidTierHandler(url) {
  if (url.includes('/quote?')) return jsonResponse(QUOTE_PAYLOAD);
  if (url.includes('/stock/candle')) {
    return jsonResponse({ s: 'ok', c: [130, 131, 132, 133, 134, 135, 136, 137, 138, 139], t: [] });
  }
  if (url.includes('/stock/profile2')) return jsonResponse({ name: 'United States Oil Fund' });
  throw new Error(`unexpected url ${url}`);
}

async function main() {
  // Require AFTER the fetch stub + env are in place.
  const finnhub = require('../services/tape/quoteProviders/finnhub');

  console.log('\nScenario A: free tier (candle 403, profile2 OK)');
  fetchHandler = freeTierHandler;
  const a = await finnhub.fetchQuote('USO');
  assertContractShape(a, 'free-tier');
  check(a.name === 'United States Oil Fund', `free-tier: name resolved from profile2 (got "${a.name}")`);
  check(a.spark[a.spark.length - 1] === a.price, 'free-tier: live price is the final spark point');

  console.log('\nScenario B: paid tier (candle returns 10 daily closes)');
  fetchHandler = paidTierHandler;
  const b = await finnhub.fetchQuote('USO');
  assertContractShape(b, 'paid-tier');
  check(b.spark.length >= 2 && b.spark.length <= 10, `paid-tier: spark has 2..10 points (got ${b.spark.length})`);
  check(b.spark[b.spark.length - 1] === b.price, 'paid-tier: live price is the final spark point');

  // Use a symbol never resolved above so the name cache can't mask the fallback.
  console.log('\nScenario C: free tier, profile2 also gated (name must still resolve to symbol)');
  fetchHandler = freeTierNoProfileHandler;
  const c = await finnhub.fetchQuote('ZZZZ');
  assertContractShape(c, 'no-profile');
  check(c.name === 'ZZZZ', `no-profile: name falls back to symbol (got "${c.name}")`);

  console.log('\nScenario D: resolved name is cached (profile2 hit at most once across calls)');
  let profileHits = 0;
  fetchHandler = (url) => {
    if (url.includes('/stock/profile2')) { profileHits++; return jsonResponse({ name: 'Apple Inc.' }); }
    if (url.includes('/quote?')) return jsonResponse({ ...QUOTE_PAYLOAD, c: 200, pc: 198, o: 199 });
    if (url.includes('/stock/candle')) return errResponse(403);
    throw new Error(`unexpected url ${url}`);
  };
  await finnhub.fetchQuote('AAPL');
  await finnhub.fetchQuote('AAPL');
  check(profileHits === 1, `name cache: profile2 fetched exactly once for two calls (got ${profileHits})`);

  // --- Report --------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('All Finnhub quote-shape contract checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
