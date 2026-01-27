#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TEST: Nostr NIP-07 Authentication Flow
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Tests the full Nostr authentication flow:
 *   1. Request challenge from auth server (bound to npub)
 *   2. Sign challenge with private key
 *   3. Verify signature and get JWT
 *   4. Use JWT to check entitlements on backend
 * 
 * Prerequisites:
 *   - Auth server running on port 6111
 *   - Backend server running on port 4132 (with DEBUG_MODE=true)
 *   - MONGO_DEBUG_URI set in .env
 * 
 * Usage:
 *   DEBUG_MODE=true node test/new-auth/test-nostr-auth.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { generateSecretKey, getPublicKey, finalizeEvent, nip19 } = require('nostr-tools');

// ═══════════════════════════════════════════════════════════════════════════════
// SAFETY CHECK: Require DEBUG_MODE=true to run tests
// ═══════════════════════════════════════════════════════════════════════════════
if (process.env.DEBUG_MODE !== 'true') {
  console.error('\x1b[31m╔════════════════════════════════════════════════════════════════╗\x1b[0m');
  console.error('\x1b[31m║  ERROR: DEBUG_MODE must be set to "true" to run this script    ║\x1b[0m');
  console.error('\x1b[31m║                                                                ║\x1b[0m');
  console.error('\x1b[31m║  Usage: DEBUG_MODE=true node test/new-auth/test-nostr-auth.js  ║\x1b[0m');
  console.error('\x1b[31m╚════════════════════════════════════════════════════════════════╝\x1b[0m');
  process.exit(1);
}

const AUTH_SERVER = process.env.AUTH_SERVER || 'http://localhost:6111';
const BACKEND_SERVER = process.env.BACKEND_SERVER || 'http://localhost:4132';
const MONGO_URI = process.env.MONGO_DEBUG_URI;

// ═══════════════════════════════════════════════════════════════════════════════
// STATIC TEST KEYPAIR - DEBUG ONLY
// ═══════════════════════════════════════════════════════════════════════════════
// This is a throwaway keypair used ONLY for testing. Never use in production.
// Generated once and hardcoded for reproducible tests.
const TEST_PRIVATE_KEY = new Uint8Array([
  0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
  0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08
]);
const TEST_PUBLIC_KEY = getPublicKey(TEST_PRIVATE_KEY);
const TEST_NPUB = nip19.npubEncode(TEST_PUBLIC_KEY);

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const log = (color, ...args) => console.log(`${colors[color]}${args.join(' ')}${colors.reset}`);

async function makeRequest(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    
    return { status: response.status, data, ok: response.ok };
  } catch (error) {
    return { status: 0, data: { error: error.message }, ok: false };
  }
}

function decodeJWT(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString());
  } catch {
    return null;
  }
}

async function cleanupTestUser() {
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 0: Cleanup - Remove existing test user');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  if (!MONGO_URI) {
    log('red', '✗ MONGO_DEBUG_URI not set, skipping cleanup');
    return false;
  }
  
  try {
    await mongoose.connect(MONGO_URI);
    
    // Get User model
    const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
      email: String,
      authProvider: {
        provider: String,
        providerId: String,
        linkedAt: Date
      },
      subscriptionType: String
    }, { collection: 'users', strict: false }));
    
    // Get Entitlement model
    const Entitlement = mongoose.models.Entitlement || mongoose.model('Entitlement', new mongoose.Schema({
      identifier: String,
      identifierType: String,
      entitlementType: String
    }, { collection: 'entitlements', strict: false }));
    
    // Find user by npub
    const user = await User.findOne({
      'authProvider.provider': 'nostr',
      'authProvider.providerId': TEST_NPUB
    });
    
    if (user) {
      // Delete entitlements for this user
      const entitlementResult = await Entitlement.deleteMany({
        identifier: user._id.toString(),
        identifierType: 'mongoUserId'
      });
      log('cyan', `  Deleted ${entitlementResult.deletedCount} entitlements for test user`);
      
      // Delete the user
      await User.deleteOne({ _id: user._id });
      log('cyan', `  Deleted test user: ${user._id}`);
    } else {
      log('cyan', '  No existing test user found');
    }
    
    await mongoose.disconnect();
    log('green', '✓ Cleanup complete');
    return true;
  } catch (error) {
    log('red', `✗ Cleanup error: ${error.message}`);
    try { await mongoose.disconnect(); } catch {}
    return false;
  }
}

async function main() {
  console.log('');
  log('blue', '══════════════════════════════════════════════════════════════════');
  log('blue', '  TEST: Nostr NIP-07 Authentication Flow');
  log('blue', '══════════════════════════════════════════════════════════════════');
  console.log('');
  log('cyan', `Auth Server:  ${AUTH_SERVER}`);
  log('cyan', `Backend:      ${BACKEND_SERVER}`);
  log('cyan', `Test npub:    ${TEST_NPUB.substring(0, 20)}...`);
  console.log('');
  
  let passed = 0;
  let failed = 0;
  let token = null;
  
  // ─────────────────────────────────────────────
  // Step 0: Cleanup existing test user
  // ─────────────────────────────────────────────
  await cleanupTestUser();
  console.log('');
  
  // ─────────────────────────────────────────────
  // Step 1: Request Challenge
  // ─────────────────────────────────────────────
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 1: Request Challenge');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  const challengeResult = await makeRequest(`${AUTH_SERVER}/auth/nostr/challenge`, {
    method: 'POST',
    body: JSON.stringify({ npub: TEST_NPUB }),
  });
  
  if (!challengeResult.ok || !challengeResult.data.challenge) {
    log('red', '✗ Failed to get challenge');
    console.log('Response:', JSON.stringify(challengeResult.data, null, 2));
    failed++;
    process.exit(1);
  }
  
  const challenge = challengeResult.data.challenge;
  log('green', `✓ Got challenge: ${challenge.substring(0, 20)}...`);
  passed++;
  console.log('');
  
  // ─────────────────────────────────────────────
  // Step 2: Sign Challenge Event
  // ─────────────────────────────────────────────
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 2: Sign Challenge Event');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  // Create unsigned event
  const unsignedEvent = {
    kind: 22242, // NIP-98 auth event kind
    created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', challenge]],
    content: 'Sign in to PullThatUpJamie',
    pubkey: TEST_PUBLIC_KEY,
  };
  
  // Sign the event
  const signedEvent = finalizeEvent(unsignedEvent, TEST_PRIVATE_KEY);
  
  log('green', `✓ Signed event (id: ${signedEvent.id.substring(0, 16)}...)`);
  log('cyan', `  kind: ${signedEvent.kind}`);
  log('cyan', `  pubkey: ${signedEvent.pubkey.substring(0, 16)}...`);
  log('cyan', `  sig: ${signedEvent.sig.substring(0, 32)}...`);
  passed++;
  console.log('');
  
  // ─────────────────────────────────────────────
  // Step 3: Verify Signature & Get JWT
  // ─────────────────────────────────────────────
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 3: Verify Signature & Get JWT');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  const verifyResult = await makeRequest(`${AUTH_SERVER}/auth/nostr/verify`, {
    method: 'POST',
    body: JSON.stringify({ npub: TEST_NPUB, signedEvent }),
  });
  
  if (!verifyResult.ok || !verifyResult.data.token) {
    log('red', '✗ Verification failed');
    console.log('Response:', JSON.stringify(verifyResult.data, null, 2));
    failed++;
    process.exit(1);
  }
  
  token = verifyResult.data.token;
  const payload = decodeJWT(token);
  
  log('green', `✓ Got JWT token`);
  log('cyan', '  JWT Payload:');
  console.log(JSON.stringify(payload, null, 4));
  
  // Verify JWT has correct structure
  if (payload?.provider === 'nostr' && payload?.sub === TEST_NPUB) {
    log('green', '✓ JWT payload has correct provider and sub');
    passed++;
  } else {
    log('red', '✗ JWT payload incorrect');
    failed++;
  }
  console.log('');
  
  // ─────────────────────────────────────────────
  // Step 4: Check Entitlements on Backend
  // ─────────────────────────────────────────────
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 4: Check Entitlements on Backend');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  const eligibilityResult = await makeRequest(`${BACKEND_SERVER}/api/on-demand/checkEligibility`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  
  if (!eligibilityResult.ok) {
    log('red', '✗ Failed to check eligibility');
    console.log('Response:', JSON.stringify(eligibilityResult.data, null, 2));
    failed++;
  } else {
    log('green', '✓ Got eligibility response');
    console.log(JSON.stringify(eligibilityResult.data, null, 2));
    
    // Verify tier is "registered" (no subscription)
    if (eligibilityResult.data.tier === 'registered') {
      log('green', '✓ User tier is "registered" (correct for new Nostr user)');
      passed++;
    } else {
      log('yellow', `⚠ Unexpected tier: ${eligibilityResult.data.tier}`);
    }
    
    // Verify we have entitlement data
    if (eligibilityResult.data.entitlements && Object.keys(eligibilityResult.data.entitlements).length > 0) {
      log('green', `✓ Got ${Object.keys(eligibilityResult.data.entitlements).length} entitlement types`);
      passed++;
    } else {
      log('yellow', '⚠ No entitlements returned');
    }
  }
  console.log('');
  
  // ─────────────────────────────────────────────
  // Step 5: Test Identity Resolution (Debug Endpoint)
  // ─────────────────────────────────────────────
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 5: Test Identity Resolution (Debug Endpoint)');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  const identityResult = await makeRequest(`${BACKEND_SERVER}/api/debug/test-identity`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  
  if (identityResult.ok && identityResult.data.identity) {
    log('green', '✓ Identity resolved');
    console.log(JSON.stringify(identityResult.data.identity, null, 2));
    
    if (identityResult.data.identity.provider === 'nostr') {
      log('green', '✓ Provider correctly identified as "nostr"');
      passed++;
    } else {
      log('red', `✗ Provider mismatch: ${identityResult.data.identity.provider}`);
      failed++;
    }
  } else if (identityResult.status === 404) {
    log('yellow', '⚠ Debug endpoint not available (may need DEBUG_MODE on server)');
  } else {
    log('red', '✗ Identity resolution failed');
    console.log('Response:', JSON.stringify(identityResult.data, null, 2));
    failed++;
  }
  console.log('');
  
  // ─────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────
  log('blue', '══════════════════════════════════════════════════════════════════');
  log('blue', '  Summary');
  log('blue', '══════════════════════════════════════════════════════════════════');
  console.log('');
  log('green', `Passed: ${passed}`);
  if (failed > 0) log('red', `Failed: ${failed}`);
  console.log('');
  
  log('cyan', 'Test npub (for reference):');
  console.log(`  ${TEST_NPUB}`);
  console.log('');
  
  if (token) {
    log('cyan', 'To use this token in other tests:');
    console.log(`export TEST_TOKEN="${token}"`);
    console.log('');
  }
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  log('red', 'Unexpected error:', err.message);
  console.error(err);
  process.exit(1);
});
