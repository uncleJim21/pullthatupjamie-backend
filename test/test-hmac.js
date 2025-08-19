require('dotenv').config();
const crypto = require('crypto');
const http = require('http');

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

async function main() {
  const host = process.env.HOST || 'localhost';
  const port = process.env.PORT || 4131;

  // Prefer SVC_HMAC_KEYS_JSON; fallback to SHARED_HMAC_SECRET as keyId "default"
  let keyMap = {};
  if (process.env.SVC_HMAC_KEYS_JSON) {
    try {
      keyMap = JSON.parse(process.env.SVC_HMAC_KEYS_JSON);
    } catch (e) {
      throw new Error('Failed to parse SVC_HMAC_KEYS_JSON from .env');
    }
  } else if (process.env.SHARED_HMAC_SECRET) {
    keyMap = { default: process.env.SHARED_HMAC_SECRET };
  } else {
    throw new Error('Provide SVC_HMAC_KEYS_JSON or SHARED_HMAC_SECRET in your .env');
  }

  const keyId = Object.keys(keyMap)[0];
  const secret = keyMap[keyId];

  const path = '/api/debug/test-hmac';
  const method = 'POST';
  const query = { a: '1', b: '2' };
  const bodyObj = { hello: 'world' };
  const body = JSON.stringify(bodyObj);
  const timestamp = Math.floor(Date.now() / 1000);

  const { signature, bodyHashHex } = sign({ method, path, query, body, keyId, secret, timestamp });
  const queryString = buildSortedQueryString(query);
  const fullPath = queryString ? `${path}?${queryString}` : path;

  const options = {
    hostname: host,
    port,
    path: fullPath,
    method,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Svc-KeyId': keyId,
      'X-Svc-Timestamp': String(timestamp),
      'X-Svc-Body-Hash': bodyHashHex,
      'X-Svc-Signature': signature,
      // Scope header optional now; server-defined scopes recommended
    }
  };

  await new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Body:', data);
        resolve();
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


