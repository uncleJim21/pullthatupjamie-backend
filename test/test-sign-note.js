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

// Simplified bech32 encoding for Nostr keys
function bech32Encode(hexString) {
  // This is a simplified version - in production you'd use a proper bech32 library
  // For testing purposes, we'll use the hex directly
  return hexString;
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

async function main() {
  const host = process.env.HOST || 'localhost';
  const port = process.env.PORT || 4132;
  const testSeed = process.env.TEST_NOSTR_SEED;
  const testAuthToken = process.env.TEST_AUTH_TOKEN;
  const existingPostId = process.env.EXISTING_POST_ID; // Optional: use existing post instead of creating new one
  
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

  console.log('🔑 Generating Nostr key pair from seed...');
  
  // Generate deterministic key pair
  const keyPair = generateKeyPairFromSeed(testSeed);
  
  console.log('Generated Nostr keys:');
  console.log(`Private Key (hex): ${keyPair.privateKey}`);
  console.log(`Public Key (hex): ${keyPair.publicKey}`);
  console.log(`nsec: ${keyPair.nsec}`);
  console.log(`npub: ${keyPair.npub}`);
  console.log('');

  let postId;
  let postContent;
  
  if (existingPostId) {
    // Use existing post
    console.log(`📄 Using existing post ID: ${existingPostId}`);
    postId = existingPostId;
    postContent = {
      text: 'Hello World! This is a test unsigned Nostr note created via JavaScript.',
      mediaUrl: null
    };
  } else {
    // Step 1: Create an unsigned note first
    console.log('📝 Creating unsigned note...');
    
    const createPath = '/api/social/posts/unsigned';
    const createMethod = 'POST';
    const scheduledTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const slotId = `test-sign-${Date.now()}`;
    
    const createBodyObj = {
      adminEmail: 'jim.carucci+prod@protonmail.com',
      text: 'Hello World! This note will be signed with a deterministic Nostr key.',
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

    const createResponse = await makeRequest(createOptions, createBody);
    
    if (createResponse.status !== 200 || !createResponse.body.success) {
      console.error('❌ Failed to create unsigned note:', createResponse.body);
      return;
    }

    postId = createResponse.body.post._id;
    postContent = createResponse.body.post.content;
    console.log(`✅ Created unsigned note with ID: ${postId}`);
  }
  console.log('');

  // Step 2: Sign the Nostr event
  console.log('✍️  Signing Nostr event...');
  
  const nostrEvent = {
    pubkey: keyPair.publicKey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: postContent.text + 
      (postContent.mediaUrl ? `\n\n${postContent.mediaUrl}` : '')
  };

  const { id: eventId, sig: eventSignature } = signNostrEvent(nostrEvent, keyPair.privateKey);
  
  console.log('Signed Nostr event:');
  console.log(`Event ID: ${eventId}`);
  console.log(`Signature: ${eventSignature}`);
  console.log('');

  // Step 3: Submit the signed event via PUT
  console.log('📤 Submitting signed event...');
  
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
  const updateTimestamp = Math.floor(Date.now() / 1000);
  const { signature: updateSig, bodyHashHex: updateBodyHash } = signRequest({
    method: updateMethod,
    path: updatePath,
    query: {},
    body: updateBody,
    keyId,
    secret,
    timestamp: updateTimestamp
  });

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

  const updateResponse = await makeRequest(updateOptions, updateBody);
  
  console.log('Update Response Status:', updateResponse.status);
  console.log('Update Response Body:');
  console.log(JSON.stringify(updateResponse.body, null, 2));
  
  if (updateResponse.status === 200 && updateResponse.body.success) {
    console.log('');
    console.log('🎉 SUCCESS! Note signed and status updated:');
    console.log(`Post ID: ${updateResponse.body.post._id}`);
    console.log(`Status: ${updateResponse.body.post.status}`);
    console.log(`Platform: ${updateResponse.body.post.platform}`);
    console.log('');
    console.log('The unsigned note has been converted to scheduled status!');
    console.log('It will now be processed by the SocialPostProcessor.');
  } else {
    console.log('');
    console.log('❌ Failed to sign the note');
  }
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
