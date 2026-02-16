/**
 * Test: HMAC auth bypasses entitlement quotas
 *
 * Proves that a request signed with the HMAC service secret is resolved
 * as admin tier (unlimited) even when the anonymous IP quota is exhausted.
 *
 * Prerequisites:
 *   - Server running on localhost:4132
 *   - .env has SVC_HMAC_KEYS_JSON or SHARED_HMAC_SECRET
 *   - The anonymous entitlement for search-quotes is maxed out (usedCount >= maxUsage)
 *
 * Usage:
 *   node test/test-hmac-entitlement-bypass.js
 */

require('dotenv').config();
const crypto = require('crypto');
const http = require('http');

// ── HMAC helpers (mirrors middleware/hmac.js) ──────────────────────────────

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input || '').digest('hex');
}

function buildSortedQueryString(query) {
  const keys = Object.keys(query).sort();
  return keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`).join('&');
}

function sign({ method, path, query, body, keyId, secret, timestamp }) {
  const queryString = buildSortedQueryString(query || {});
  const bodyHashHex = sha256Hex(body || '');
  const canonical = [
    method.toUpperCase(),
    path,
    queryString,
    bodyHashHex,
    String(timestamp),
    keyId
  ].join('\n');
  const signature = crypto.createHmac('sha256', secret).update(canonical).digest('base64');
  return { signature, bodyHashHex };
}

// ── Load HMAC key from .env ────────────────────────────────────────────────

function loadKey() {
  const secretsAreBase64 = process.env.SVC_HMAC_SECRETS_BASE64 === 'true';

  if (process.env.SVC_HMAC_KEYS_JSON) {
    try {
      const keyMap = JSON.parse(process.env.SVC_HMAC_KEYS_JSON);
      const keyId = Object.keys(keyMap)[0];
      const raw = keyMap[keyId];
      const secret = secretsAreBase64 ? Buffer.from(String(raw), 'base64') : raw;
      return { keyId, secret };
    } catch (e) {
      throw new Error('Failed to parse SVC_HMAC_KEYS_JSON from .env');
    }
  }

  if (process.env.SHARED_HMAC_SECRET) {
    const raw = process.env.SHARED_HMAC_SECRET;
    const secret = secretsAreBase64 ? Buffer.from(String(raw), 'base64') : raw;
    return { keyId: 'default', secret };
  }

  throw new Error('Provide SVC_HMAC_KEYS_JSON or SHARED_HMAC_SECRET in your .env');
}

// ── HTTP request helper ────────────────────────────────────────────────────

function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const host = process.env.HOST || 'localhost';
  const port = process.env.PORT || 4132;
  const { keyId, secret } = loadKey();

  const apiPath = '/api/search-quotes';
  const method = 'POST';
  const bodyObj = {
    query: 'test hmac bypass',
    limit: 2
  };
  const body = JSON.stringify(bodyObj);

  console.log('═══════════════════════════════════════════════════════');
  console.log('  TEST: HMAC auth bypasses search-quotes entitlement');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Test 1: Request WITHOUT HMAC (should get 429 if quota is maxed) ────
  console.log('── Test 1: No HMAC headers (anonymous) ──');
  const anonResult = await makeRequest({
    hostname: host,
    port,
    path: apiPath,
    method,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  console.log(`   Status:          ${anonResult.status}`);
  console.log(`   X-Quota-Used:    ${anonResult.headers['x-quota-used'] || 'n/a'}`);
  console.log(`   X-Quota-Max:     ${anonResult.headers['x-quota-max'] || 'n/a'}`);

  if (anonResult.status === 429) {
    console.log('   ✓ Correctly rejected — anonymous quota exhausted\n');
  } else {
    console.log(`   ⚠ Got ${anonResult.status} — quota may not be exhausted yet (test still valid)\n`);
  }

  // ── Test 2: Request WITH HMAC (should succeed with admin tier) ─────────
  console.log('── Test 2: With HMAC headers (service auth) ──');
  const timestamp = Math.floor(Date.now() / 1000);
  const { signature, bodyHashHex } = sign({
    method,
    path: apiPath,
    query: {},
    body,
    keyId,
    secret,
    timestamp
  });

  const hmacResult = await makeRequest({
    hostname: host,
    port,
    path: apiPath,
    method,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Svc-KeyId': keyId,
      'X-Svc-Timestamp': String(timestamp),
      'X-Svc-Body-Hash': bodyHashHex,
      'X-Svc-Signature': signature
    }
  }, body);

  console.log(`   Status:          ${hmacResult.status}`);
  console.log(`   X-Quota-Used:    ${hmacResult.headers['x-quota-used'] || 'n/a'}`);
  console.log(`   X-Quota-Max:     ${hmacResult.headers['x-quota-max'] || 'n/a'}`);
  console.log(`   X-Quota-Remain:  ${hmacResult.headers['x-quota-remaining'] || 'n/a'}`);

  if (hmacResult.status === 200) {
    console.log('   ✓ SUCCESS — HMAC request passed through entitlement as admin\n');
  } else if (hmacResult.status === 429) {
    console.log('   ✗ FAIL — HMAC request was still quota-blocked\n');
    try {
      const parsed = JSON.parse(hmacResult.body);
      console.log('   Response:', JSON.stringify(parsed, null, 2));
    } catch { console.log('   Response:', hmacResult.body.slice(0, 500)); }
  } else {
    console.log(`   ? Unexpected status ${hmacResult.status}\n`);
    console.log('   Response:', hmacResult.body.slice(0, 500));
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════');
  const pass = anonResult.status === 429 && hmacResult.status === 200;
  if (pass) {
    console.log('  RESULT: ✓ PASS — Anonymous blocked, HMAC bypassed quota');
  } else if (hmacResult.status === 200) {
    console.log('  RESULT: ~ PARTIAL — HMAC succeeded (anon quota may not be exhausted)');
  } else {
    console.log('  RESULT: ✗ FAIL — HMAC request did not bypass entitlement');
  }
  console.log('═══════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
