/**
 * test-sign-verify.js
 *
 * Local roundtrip test for the benchmark HMAC scheme. Signs a mock request
 * with the harness's signRequest(), then verifies it through the same
 * isBenchmarkRequest() that the server uses. Also probes negative cases
 * (bad signature, expired timestamp, body tampering) to confirm fail-quiet
 * semantics.
 *
 * Does not touch network or DB. Pure local crypto.
 *
 * Usage:
 *   BENCHMARK_HMAC_SECRET=$(openssl rand -hex 32) node scripts/benchmarks/test-sign-verify.js
 */

// Set a deterministic test secret before loading the verifier so we don't
// depend on the user's local .env.
if (!process.env.BENCHMARK_HMAC_SECRET) {
  process.env.BENCHMARK_HMAC_SECRET = 'a'.repeat(64); // 32 hex bytes worth of 'a'
}

const { signRequest, sha256Hex } = require('./signRequest');
const { isBenchmarkRequest } = require('../../utils/benchmarkAuth');

const SECRET = process.env.BENCHMARK_HMAC_SECRET;

function makeMockReq({ method = 'POST', path = '/api/pull', rawBody = '{"message":"hello"}', headers = {} } = {}) {
  return {
    method,
    baseUrl: '',
    path,
    query: {},
    rawBody,
    headers: {
      'content-length': String(Buffer.byteLength(rawBody, 'utf8')),
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    },
  };
}

let passes = 0;
let fails = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passes++; }
  else { console.log(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`); fails++; }
}

console.log('\nBenchmark HMAC roundtrip test');
console.log('─'.repeat(60));

const rawBody = JSON.stringify({ message: 'What did they say about albyhub?' });
const headers = signRequest({
  method: 'POST',
  path: '/api/pull',
  rawBody,
  secret: SECRET,
});

// Test 1: valid signature roundtrip
{
  const req = makeMockReq({ rawBody, headers });
  check('valid signature accepted', isBenchmarkRequest(req) === true);
}

// Test 2: missing all HMAC headers
{
  const req = makeMockReq({ rawBody, headers: {} });
  check('missing headers rejected silently', isBenchmarkRequest(req) === false);
}

// Test 3: bad signature
{
  const bad = { ...headers, 'X-Benchmark-Signature': 'AAAA' + headers['X-Benchmark-Signature'].slice(4) };
  const req = makeMockReq({ rawBody, headers: bad });
  check('bad signature rejected silently', isBenchmarkRequest(req) === false);
}

// Test 4: expired timestamp
{
  const oldTs = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago, well past 60s window
  const expired = { ...headers, 'X-Benchmark-Timestamp': oldTs };
  const req = makeMockReq({ rawBody, headers: expired });
  check('expired timestamp rejected silently', isBenchmarkRequest(req) === false);
}

// Test 5: body tampered (different rawBody than what was signed)
{
  const tamperedRawBody = JSON.stringify({ message: 'malicious change' });
  const req = makeMockReq({
    rawBody: tamperedRawBody,
    headers: { ...headers, 'content-length': String(Buffer.byteLength(tamperedRawBody, 'utf8')) },
  });
  check('body tamper rejected silently', isBenchmarkRequest(req) === false);
}

// Test 6: wrong keyId
{
  const wrongKey = { ...headers, 'X-Benchmark-KeyId': 'not-benchmark' };
  const req = makeMockReq({ rawBody, headers: wrongKey });
  check('wrong keyId rejected silently', isBenchmarkRequest(req) === false);
}

// Test 7: env secret unset (mechanism off)
{
  const saved = process.env.BENCHMARK_HMAC_SECRET;
  delete process.env.BENCHMARK_HMAC_SECRET;
  const req = makeMockReq({ rawBody, headers });
  const result = isBenchmarkRequest(req);
  process.env.BENCHMARK_HMAC_SECRET = saved;
  check('mechanism disabled when env unset', result === false);
}

// Test 8: signature is a function of body — body change without re-signing is rejected
// (overlaps with #5 but tests via length mismatch instead of hash)
{
  const shortBody = '{}';
  // Compute a fresh hash for the shorter body, but DO NOT re-sign — use old sig
  const tamperedHeaders = {
    ...headers,
    'X-Benchmark-Body-Hash': sha256Hex(shortBody), // hash matches new body
    'content-length': String(Buffer.byteLength(shortBody, 'utf8')),
  };
  const req = makeMockReq({ rawBody: shortBody, headers: tamperedHeaders });
  // The hash now matches the body, BUT the signature was computed over the
  // ORIGINAL hash, so signature verification should fail.
  check('body+hash swapped without resign rejected', isBenchmarkRequest(req) === false);
}

console.log('─'.repeat(60));
console.log(`\nSummary: ${passes} passed, ${fails} failed`);
process.exit(fails > 0 ? 1 : 0);
