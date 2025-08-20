require('dotenv').config();
const crypto = require('crypto');
const http = require('http');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input || '').digest('hex');
}

function buildSortedQueryString(query) {
  const keys = Object.keys(query || {}).sort();
  return keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`).join('&');
}

function sign({ method, path, query, body, keyId, secretBase64, timestamp }) {
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
  const signature = crypto.createHmac('sha256', Buffer.from(secretBase64, 'base64')).update(canonical).digest('base64');
  return { signature, bodyHashHex, queryString };
}

function request({ host, port, method, path, query, headers, body, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const queryString = buildSortedQueryString(query || {});
    const fullPath = queryString ? `${path}?${queryString}` : path;
    const options = { hostname: host, port, path: fullPath, method, headers };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timed out'));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function requestSSE({ host, port, method, path, query, headers, body, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const queryString = buildSortedQueryString(query || {});
    const fullPath = queryString ? `${path}?${queryString}` : path;
    const options = { hostname: host, port, path: fullPath, method, headers };
    const req = http.request(options, (res) => {
      let collected = '';
      const timer = setTimeout(() => {
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body: collected, note: 'timeout_partial' });
      }, timeoutMs);
      res.on('data', chunk => {
        const text = chunk.toString('utf8');
        collected += text;
        if (text.includes('[DONE]')) {
          clearTimeout(timer);
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: collected });
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body: collected });
      });
    });
    req.on('error', (err) => {
      resolve({ status: 0, error: err.message });
    });
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const host = process.env.HOST || 'localhost';
  const port = process.env.PORT || 4132;

  // Load keys and scopes
  let keyId;
  let secretBase64;
  if (process.env.SVC_HMAC_KEYS_JSON) {
    const keyMap = JSON.parse(process.env.SVC_HMAC_KEYS_JSON);
    keyId = Object.keys(keyMap)[0];
    secretBase64 = keyMap[keyId];
  } else if (process.env.SHARED_HMAC_SECRET) {
    keyId = 'default';
    secretBase64 = process.env.SHARED_HMAC_SECRET;
  } else {
    throw new Error('Provide SVC_HMAC_KEYS_JSON or SHARED_HMAC_SECRET in .env');
  }

  console.log('Using keyId:', keyId);

  // 1) Test /api/debug/test-hmac
  {
    const path = '/api/debug/test-hmac';
    const method = 'POST';
    const bodyObj = { hello: 'world' };
    const body = JSON.stringify(bodyObj);
    const ts = Math.floor(Date.now() / 1000);
    const { signature, bodyHashHex } = sign({ method, path, query: {}, body, keyId, secretBase64, timestamp: ts });
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Svc-KeyId': keyId,
      'X-Svc-Timestamp': String(ts),
      'X-Svc-Body-Hash': bodyHashHex,
      'X-Svc-Signature': signature
    };
    const res = await request({ host, port, method, path, query: {}, headers, body });
    console.log('\n[TEST] /api/debug/test-hmac ->', res.status);
    console.log(res.body);
  }

  // 2) Test /api/social/schedule
  {
    const path = '/api/social/schedule';
    const method = 'POST';
    const now = new Date();
    const inFive = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    const adminEmail = process.env.TEST_ADMIN_EMAIL || 'admin@example.com';
    const bodyObj = {
      adminEmail,
      text: 'HMAC schedule test',
      scheduledFor: inFive,
      platforms: ['twitter'],
      timezone: 'America/Chicago'
    };
    const body = JSON.stringify(bodyObj);
    const ts = Math.floor(Date.now() / 1000);
    const { signature, bodyHashHex } = sign({ method, path, query: {}, body, keyId, secretBase64, timestamp: ts });
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Svc-KeyId': keyId,
      'X-Svc-Timestamp': String(ts),
      'X-Svc-Body-Hash': bodyHashHex,
      'X-Svc-Signature': signature
    };
    const res = await request({ host, port, method, path, query: {}, headers, body });
    console.log('\n[TEST] /api/social/schedule ->', res.status);
    console.log(res.body);
  }

  // 3) Test /api/internal/jamie-assist/:lookupHash (SSE)
  {
    const lookupHash = process.env.TEST_LOOKUP_HASH; // required to get 200; if missing, expect 404
    if (!lookupHash) {
      console.log('\n[TEST] /api/internal/jamie-assist skipped (set TEST_LOOKUP_HASH to test)');
    } else {
      const path = `/api/internal/jamie-assist/${lookupHash}`;
      const method = 'POST';
      const bodyObj = { additionalPrefs: 'keep it punchy' };
      const body = JSON.stringify(bodyObj);
      const ts = Math.floor(Date.now() / 1000);
      const { signature, bodyHashHex } = sign({ method, path, query: {}, body, keyId, secretBase64, timestamp: ts });
      const headers = {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Svc-KeyId': keyId,
        'X-Svc-Timestamp': String(ts),
        'X-Svc-Body-Hash': bodyHashHex,
        'X-Svc-Signature': signature
      };
      const res = await requestSSE({ host, port, method, path, query: {}, headers, body });
      console.log('\n[TEST] /api/internal/jamie-assist ->', res.status);
      console.log(res.body ? res.body.substring(0, 300) : res.error);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


