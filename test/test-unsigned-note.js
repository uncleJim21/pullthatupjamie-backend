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
  const port = process.env.PORT || 4132;

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

  console.log(`Using keyId: ${keyId}`);

  // Create unsigned Nostr note payload
  const path = '/api/social/posts/unsigned';
  const method = 'POST';
  const query = {}; // No query parameters for this endpoint
  
  // Generate a future timestamp for scheduling (1 hour from now)
  const scheduledTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const slotId = `test-${Date.now()}`;
  
  const bodyObj = {
    adminEmail: 'test@example.com',
    text: 'Hello World! This is a test unsigned Nostr note created via JavaScript.',
    scheduledFor: scheduledTime,
    scheduledPostSlotId: slotId
  };
  
  const body = JSON.stringify(bodyObj);
  const timestamp = Math.floor(Date.now() / 1000);

  console.log('Creating unsigned Nostr note with payload:');
  console.log(JSON.stringify(bodyObj, null, 2));
  console.log('');

  const { signature, bodyHashHex } = sign({ method, path, query, body, keyId, secret, timestamp });
  const queryString = buildSortedQueryString(query);
  const fullPath = queryString ? `${path}?${queryString}` : path;

  console.log('HMAC Details:');
  console.log(`Timestamp: ${timestamp}`);
  console.log(`Body Hash: ${bodyHashHex}`);
  console.log(`Signature: ${signature}`);
  console.log('');

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
      'X-Svc-Scope': 'svc:social:schedule' // Explicitly include the required scope
    }
  };

  console.log('Making request to:', `http://${host}:${port}${fullPath}`);
  console.log('');

  await new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Response Headers:', JSON.stringify(res.headers, null, 2));
        console.log('');
        
        try {
          const responseObj = JSON.parse(data);
          console.log('Response Body:');
          console.log(JSON.stringify(responseObj, null, 2));
          
          if (res.statusCode === 200 && responseObj.success) {
            console.log('');
            console.log('✅ SUCCESS! Unsigned Nostr note created:');
            console.log(`Post ID: ${responseObj.post._id}`);
            console.log(`Status: ${responseObj.post.status}`);
            console.log(`Platform: ${responseObj.post.platform}`);
            console.log(`Scheduled for: ${responseObj.post.scheduledFor}`);
            console.log('');
            console.log('Next steps:');
            console.log('1. Use GET /api/social/posts?status=unsigned to retrieve this note');
            console.log('2. Use PUT /api/social/posts/' + responseObj.post._id + ' to sign it');
          } else {
            console.log('');
            console.log('❌ Request failed or returned error');
          }
        } catch (e) {
          console.log('Raw Response Body:', data);
        }
        
        resolve();
      });
    });
    
    req.on('error', (error) => {
      console.error('Request error:', error);
      reject(error);
    });
    
    req.write(body);
    req.end();
  });
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
