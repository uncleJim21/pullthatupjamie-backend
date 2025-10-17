require('dotenv').config();
const crypto = require('crypto');
const http = require('http');

// Nostr utilities for key generation and signing
function generateKeyPairFromSeed(seed) {
  // Use the seed to generate a deterministic private key
  const hash = crypto.createHash('sha256').update(seed, 'utf8').digest();
  const privateKey = hash.toString('hex');
  
  // For testing purposes, generate a mock public key from the private key
  // In a real implementation, you'd use secp256k1 library
  const publicKeyHash = crypto.createHash('sha256').update(privateKey + 'pubkey', 'utf8').digest();
  const publicKey = publicKeyHash.toString('hex');
  
  return {
    privateKey: privateKey,
    publicKey: publicKey,
    nsec: 'nsec1' + privateKey, // Simplified for testing
    npub: 'npub1' + publicKey   // Simplified for testing
  };
}

function signNostrEvent(event, privateKeyHex) {
  // Create the event hash for signing (Nostr NIP-01 format)
  const eventData = [
    0, // reserved
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ];
  
  const eventString = JSON.stringify(eventData);
  const eventHash = crypto.createHash('sha256').update(eventString, 'utf8').digest();
  const eventId = eventHash.toString('hex');
  
  // For testing purposes, create a deterministic signature using HMAC
  // In a real implementation, you'd use secp256k1 for proper Nostr signatures
  const signature = crypto.createHmac('sha256', privateKeyHex)
    .update(eventId)
    .digest('hex');
  
  // Pad signature to 64 bytes (128 hex chars) to match Nostr signature format
  const paddedSignature = signature.padEnd(128, '0');
  
  return {
    id: eventId,
    sig: paddedSignature
  };
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input || '').digest('hex');
}

function buildSortedQueryString(query) {
  const keys = Object.keys(query).sort();
  return keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`).join('&');
}

function signRequest({ method, path, query, body, keyId, secret, timestamp }) {
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

async function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const responseObj = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: responseObj });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const host = process.env.HOST || 'localhost';
  const port = process.env.PORT || 4132;
  const testSeed = process.env.TEST_NOSTR_SEED;
  const testAuthToken = process.env.TEST_AUTH_TOKEN;
  
  if (!testSeed) {
    throw new Error('TEST_NOSTR_SEED environment variable is required');
  }
  
  if (!testAuthToken) {
    throw new Error('TEST_AUTH_TOKEN environment variable is required (JWT Bearer token for user authentication)');
  }

  // Get HMAC keys for API authentication
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

  console.log('🚀 Starting Full Workflow Test: Create → Wait → Sign');
  console.log('='.repeat(60));
  console.log('');

  // Generate deterministic key pair
  console.log('🔑 Generating Nostr key pair from seed...');
  const keyPair = generateKeyPairFromSeed(testSeed);
  
  console.log('Generated Nostr keys:');
  console.log(`Private Key (hex): ${keyPair.privateKey}`);
  console.log(`Public Key (hex): ${keyPair.publicKey}`);
  console.log(`nsec: ${keyPair.nsec}`);
  console.log(`npub: ${keyPair.npub}`);
  console.log('');

  // ========================================
  // STEP 1: Create unsigned note
  // ========================================
  console.log('📝 STEP 1: Creating unsigned note...');
  
  const createPath = '/api/social/posts/unsigned';
  const createMethod = 'POST';
  const scheduledTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const slotId = `workflow-test-${Date.now()}`;
  
  const createBodyObj = {
    adminEmail: 'jim.carucci+prod@protonmail.com',
    text: `🧪 Full Workflow Test: This unsigned note will be automatically signed in 5 seconds! Generated at ${new Date().toISOString()}`,
    scheduledFor: scheduledTime,
    scheduledPostSlotId: slotId
  };
  
  const createBody = JSON.stringify(createBodyObj);
  const createTimestamp = Math.floor(Date.now() / 1000);
  const { signature: createSig, bodyHashHex: createBodyHash } = signRequest({
    method: createMethod,
    path: createPath,
    query: {},
    body: createBody,
    keyId,
    secret,
    timestamp: createTimestamp
  });

  const createOptions = {
    hostname: host,
    port,
    path: createPath,
    method: createMethod,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(createBody),
      'X-Svc-KeyId': keyId,
      'X-Svc-Timestamp': String(createTimestamp),
      'X-Svc-Body-Hash': createBodyHash,
      'X-Svc-Signature': createSig,
      'X-Svc-Scope': 'svc:social:schedule'
    }
  };

  console.log('Making create request...');
  const createResponse = await makeRequest(createOptions, createBody);
  
  if (createResponse.status !== 200 || !createResponse.body.success) {
    console.error('❌ Failed to create unsigned note:', createResponse.body);
    return;
  }

  const postId = createResponse.body.post._id;
  const postContent = createResponse.body.post.content;
  
  console.log('✅ Successfully created unsigned note!');
  console.log(`📄 Post ID: ${postId}`);
  console.log(`📝 Content: "${postContent.text}"`);
  console.log(`📅 Scheduled for: ${createResponse.body.post.scheduledFor}`);
  console.log(`🔄 Status: ${createResponse.body.post.status}`);
  console.log('');

  // ========================================
  // STEP 2: Wait 5 seconds
  // ========================================
  console.log('⏳ STEP 2: Waiting 5 seconds before signing...');
  for (let i = 5; i >= 1; i--) {
    process.stdout.write(`\r⏱️  Countdown: ${i} seconds remaining...`);
    await sleep(1000);
  }
  console.log('\r✅ Wait complete!                                ');
  console.log('');

  // ========================================
  // STEP 3: Sign the note
  // ========================================
  console.log('✍️  STEP 3: Signing the Nostr event...');
  
  const nostrEvent = {
    pubkey: keyPair.publicKey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: postContent.text + 
      (postContent.mediaUrl ? `\n\n${postContent.mediaUrl}` : '')
  };

  const { id: eventId, sig: eventSignature } = signNostrEvent(nostrEvent, keyPair.privateKey);
  
  console.log('📋 Signed Nostr event details:');
  console.log(`Event ID: ${eventId}`);
  console.log(`Signature: ${eventSignature.substring(0, 32)}...`);
  console.log('');

  // ========================================
  // STEP 4: Submit signed event
  // ========================================
  console.log('📤 STEP 4: Submitting signed event via PUT...');
  
  const updatePath = `/api/social/posts/${postId}`;
  const updateMethod = 'PUT';
  
  const updateBodyObj = {
    platformData: {
      nostrEventId: eventId,
      nostrSignature: eventSignature,
      nostrPubkey: keyPair.publicKey,
      nostrCreatedAt: nostrEvent.created_at,
      nostrRelays: [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.snort.social'
      ],
      nostrPostUrl: `https://primal.net/e/note1${eventId.slice(0, 16)}...`
    }
  };
  
  const updateBody = JSON.stringify(updateBodyObj);

  const updateOptions = {
    hostname: host,
    port,
    path: updatePath,
    method: updateMethod,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(updateBody),
      'Authorization': `Bearer ${testAuthToken}`
    }
  };

  console.log('Making update request...');
  const updateResponse = await makeRequest(updateOptions, updateBody);
  
  console.log('');
  console.log('🔍 RESULTS:');
  console.log('='.repeat(60));
  console.log(`Response Status: ${updateResponse.status}`);
  
  if (updateResponse.status === 200 && updateResponse.body.success) {
    console.log('🎉 SUCCESS! Complete workflow executed successfully!');
    console.log('');
    console.log('📊 Final Post Details:');
    console.log(`Post ID: ${updateResponse.body.post._id}`);
    console.log(`Status: ${updateResponse.body.post.status} (was: unsigned)`);
    console.log(`Platform: ${updateResponse.body.post.platform}`);
    console.log(`Admin Email: ${updateResponse.body.post.adminEmail}`);
    console.log(`Scheduled For: ${updateResponse.body.post.scheduledFor}`);
    console.log('');
    console.log('✅ The post has been converted from unsigned → scheduled');
    console.log('🤖 SocialPostProcessor will now pick it up for posting to Nostr relays');
    console.log('');
    console.log('🔗 Nostr Details:');
    console.log(`Event ID: ${updateResponse.body.post.platformData.nostrEventId}`);
    console.log(`Public Key: ${updateResponse.body.post.platformData.nostrPubkey}`);
    console.log(`Relays: ${updateResponse.body.post.platformData.nostrRelays.join(', ')}`);
  } else {
    console.log('❌ FAILED! Workflow did not complete successfully');
    console.log('Response Body:');
    console.log(JSON.stringify(updateResponse.body, null, 2));
  }
  
  console.log('');
  console.log('🏁 Workflow test completed!');
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
