#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * QUOTA BURN-DOWN TEST SCRIPT (JavaScript Version)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Tests that quota limits are enforced correctly for each tier across ALL
 * entitlement types via debug endpoints.
 * 
 * Usage:
 *   node test/new-auth/test-quota-burndown.js
 * 
 * Requirements:
 *   - Server running with DEBUG_MODE=true on localhost:4132
 *   - MONGO_DEBUG_URI env var set (or uses default)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { ENTITLEMENT_TYPES: ET, ALL_ENTITLEMENT_TYPES } = require('../../constants/entitlementTypes');

// ═══════════════════════════════════════════════════════════════════════════════
// SAFETY CHECK: Require DEBUG_MODE=true to run tests
// ═══════════════════════════════════════════════════════════════════════════════
if (process.env.DEBUG_MODE !== 'true') {
  console.error('\x1b[31m╔════════════════════════════════════════════════════════════════╗\x1b[0m');
  console.error('\x1b[31m║  ERROR: DEBUG_MODE must be set to "true" to run this script    ║\x1b[0m');
  console.error('\x1b[31m║                                                                ║\x1b[0m');
  console.error('\x1b[31m║  Usage: DEBUG_MODE=true node test/new-auth/test-quota-burndown.js  ║\x1b[0m');
  console.error('\x1b[31m╚════════════════════════════════════════════════════════════════╝\x1b[0m');
  process.exit(1);
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:4132';

// Test user JWTs
const TEST_USERS = {
  registered: {
    email: 'jim.carucci+test-registered@protonmail.com',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJqaW0uY2FydWNjaSt0ZXN0LXJlZ2lzdGVyZWRAcHJvdG9ubWFpbC5jb20iLCJwcm92aWRlciI6ImVtYWlsIiwiZW1haWwiOiJqaW0uY2FydWNjaSt0ZXN0LXJlZ2lzdGVyZWRAcHJvdG9ubWFpbC5jb20iLCJpYXQiOjE3Njk1MzA5NjksImV4cCI6MTgwMTA2Njk2OX0.lfJRBzH6viUNqXABixvCOLGT4oLsxWWFA4kkGl1m1RU',
  },
  subscriber: {
    email: 'jim.carucci+test-subscriber@protonmail.com',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJqaW0uY2FydWNjaSt0ZXN0LXN1YnNjcmliZXJAcHJvdG9ubWFpbC5jb20iLCJwcm92aWRlciI6ImVtYWlsIiwiZW1haWwiOiJqaW0uY2FydWNjaSt0ZXN0LXN1YnNjcmliZXJAcHJvdG9ubWFpbC5jb20iLCJpYXQiOjE3Njk1MzA5NjgsImV4cCI6MTgwMTA2Njk2OH0.j39K_zEwSPBNPvO_0vy_szVACtejDWLuoO_pEAGBpsc',
  },
  admin: {
    email: 'jim.carucci+test-admin@protonmail.com',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJqaW0uY2FydWNjaSt0ZXN0LWFkbWluQHByb3Rvbm1haWwuY29tIiwicHJvdmlkZXIiOiJlbWFpbCIsImVtYWlsIjoiamltLmNhcnVjY2krdGVzdC1hZG1pbkBwcm90b25tYWlsLmNvbSIsImlhdCI6MTc2OTUzMDk2OCwiZXhwIjoxODAxMDY2OTY4fQ.8U2sFsybhAMsFpLvUftlXffUfX5k1tlvhGNmRD-kh78',
  }
};

// All entitlement types to test (imported from constants)

// Debug mode limits (from entitlementMiddleware.js QUOTA_CONFIG_DEBUG)
const DEBUG_LIMITS = {
  [ET.SEARCH_QUOTES]:       { anonymous: 3, registered: 3, subscriber: 5, admin: -1 },
  [ET.SEARCH_QUOTES_3D]:    { anonymous: 3, registered: 3, subscriber: 5, admin: -1 },
  [ET.MAKE_CLIP]:           { anonymous: 2, registered: 3, subscriber: 5, admin: -1 },
  [ET.JAMIE_ASSIST]:        { anonymous: 2, registered: 3, subscriber: 5, admin: -1 },
  [ET.AI_ANALYZE]:          { anonymous: 2, registered: 3, subscriber: 5, admin: -1 },
  [ET.SUBMIT_ON_DEMAND_RUN]:{ anonymous: 2, registered: 3, subscriber: 5, admin: -1 }
};

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

function log(color, msg) {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────────
// MongoDB Connection & Cleanup
// ─────────────────────────────────────────────────────────────────────────────────

async function connectToMongo() {
  const uri = process.env.MONGO_DEBUG_URI || process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('No MongoDB URI found. Set MONGO_DEBUG_URI or MONGODB_URI');
  }
  
  await mongoose.connect(uri);
  log('green', '✓ Connected to MongoDB');
}

async function cleanupTestEntitlements() {
  log('yellow', '\nStep 1: Cleaning up existing test entitlements...');
  
  // Get or create models (avoid "Cannot overwrite model" error)
  const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({}, { strict: false }), 'users');
  const Entitlement = mongoose.models.Entitlement || mongoose.model('Entitlement', new mongoose.Schema({}, { strict: false }), 'entitlements');
  
  // Find test users
  const testEmails = Object.values(TEST_USERS).map(u => u.email);
  const testUsers = await User.find({ email: { $in: testEmails } }).lean();
  
  if (testUsers.length === 0) {
    log('yellow', '  No test users found in database');
    return;
  }
  
  // Get their MongoDB _ids
  const testUserIds = testUsers.map(u => u._id.toString());
  log('cyan', `  Found ${testUsers.length} test users`);
  
  // Delete entitlements for these users (by identifier which is the _id)
  const deleteResult = await Entitlement.deleteMany({
    identifier: { $in: testUserIds }
  });
  
  log('green', `  ✓ Deleted ${deleteResult.deletedCount} entitlement records`);
}

// ─────────────────────────────────────────────────────────────────────────────────
// HTTP Helpers
// ─────────────────────────────────────────────────────────────────────────────────

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  return response.json();
}

async function consumeQuota(jwt, entitlementType) {
  const headers = jwt ? { 'Authorization': `Bearer ${jwt}` } : {};
  return fetchJson(`${BASE_URL}/api/debug/test-consume/${entitlementType}`, {
    method: 'POST',
    headers
  });
}

async function checkEligibility(jwt) {
  const headers = jwt ? { 'Authorization': `Bearer ${jwt}` } : {};
  return fetchJson(`${BASE_URL}/api/on-demand/checkEligibility`, { headers });
}

// ─────────────────────────────────────────────────────────────────────────────────
// Test Functions
// ─────────────────────────────────────────────────────────────────────────────────

async function testEntitlementType(tierName, jwt, entitlementType) {
  const expectedLimit = DEBUG_LIMITS[entitlementType][tierName];
  const isUnlimited = expectedLimit === -1;
  
  log('dim', `    Testing ${entitlementType}...`);
  
  if (isUnlimited) {
    // For admin/unlimited, just verify 3 requests succeed
    for (let i = 1; i <= 3; i++) {
      const response = await consumeQuota(jwt, entitlementType);
      if (response.error) {
        log('red', `    ✗ ${entitlementType}: BLOCKED on request ${i} (should be unlimited)`);
        return false;
      }
    }
    log('green', `    ✓ ${entitlementType}: unlimited access confirmed`);
    return true;
  }
  
  // For limited tiers, burn down and verify limit
  for (let i = 1; i <= expectedLimit + 1; i++) {
    const response = await consumeQuota(jwt, entitlementType);
    
    if (response.error) {
      if (response.error.includes('Quota') || response.error === 'Quota exceeded') {
        if (i === expectedLimit + 1) {
          log('green', `    ✓ ${entitlementType}: correctly limited at ${expectedLimit}`);
          return true;
        } else {
          log('red', `    ✗ ${entitlementType}: blocked too early at request ${i} (expected ${expectedLimit})`);
          return false;
        }
      } else {
        log('red', `    ✗ ${entitlementType}: unexpected error: ${response.error}`);
        return false;
      }
    }
  }
  
  log('red', `    ✗ ${entitlementType}: NOT limited (exceeded ${expectedLimit})`);
  return false;
}

async function testTierAllEntitlements(tierName, jwt) {
  log('blue', `\n───────────────────────────────────────────────────────────────────────────────`);
  log('blue', `Testing: ${tierName.toUpperCase()} tier - All entitlement types`);
  log('blue', `───────────────────────────────────────────────────────────────────────────────`);
  
  const results = {};
  
  for (const entType of ALL_ENTITLEMENT_TYPES) {
    results[entType] = await testEntitlementType(tierName, jwt, entType);
  }
  
  const passed = Object.values(results).filter(r => r).length;
  const total = Object.keys(results).length;
  
  if (passed === total) {
    log('green', `  ✓ ${tierName.toUpperCase()}: All ${total} entitlement types passed`);
  } else {
    log('red', `  ✗ ${tierName.toUpperCase()}: ${total - passed} of ${total} failed`);
  }
  
  return { tierName, passed, total, results };
}

// ─────────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────────

async function main() {
  log('blue', '═══════════════════════════════════════════════════════════════════════════════');
  log('blue', '              QUOTA BURN-DOWN TEST - ALL ENTITLEMENT TYPES');
  log('blue', '═══════════════════════════════════════════════════════════════════════════════');
  console.log('');
  log('yellow', `⚠️  Make sure DEBUG_MODE=true and server is running on ${BASE_URL}`);
  log('yellow', '⚠️  Testing via debug endpoints (/api/debug/test-consume/:type)');
  console.log('');
  
  try {
    // Connect to MongoDB and cleanup
    await connectToMongo();
    await cleanupTestEntitlements();
    
    // Check server is running
    log('yellow', '\nStep 2: Checking server health...');
    try {
      await checkEligibility(null);
      log('green', '✓ Server is running');
    } catch (e) {
      log('red', `✗ Server not responding at ${BASE_URL}`);
      log('yellow', 'Start the server with: DEBUG_MODE=true node server.js');
      process.exit(1);
    }
    
    // Run burn-down tests for each tier
    log('blue', '\n═══════════════════════════════════════════════════════════════════════════════');
    log('blue', '                         BURN-DOWN TESTS');
    log('blue', '═══════════════════════════════════════════════════════════════════════════════');
    
    const tierResults = [];
    
    // Test registered tier
    await cleanupTestEntitlements(); // Reset before each tier
    tierResults.push(await testTierAllEntitlements('registered', TEST_USERS.registered.jwt));
    
    // Test subscriber tier
    await cleanupTestEntitlements();
    tierResults.push(await testTierAllEntitlements('subscriber', TEST_USERS.subscriber.jwt));
    
    // Test admin tier
    await cleanupTestEntitlements();
    tierResults.push(await testTierAllEntitlements('admin', TEST_USERS.admin.jwt));
    
    // Summary
    log('blue', '\n═══════════════════════════════════════════════════════════════════════════════');
    log('blue', '                         TEST SUMMARY');
    log('blue', '═══════════════════════════════════════════════════════════════════════════════');
    
    let totalPassed = 0;
    let totalTests = 0;
    
    for (const result of tierResults) {
      totalPassed += result.passed;
      totalTests += result.total;
      const status = result.passed === result.total 
        ? `${colors.green}✓ ${result.passed}/${result.total} PASSED${colors.reset}` 
        : `${colors.red}✗ ${result.passed}/${result.total} PASSED${colors.reset}`;
      console.log(`  ${result.tierName.toUpperCase()}: ${status}`);
    }
    
    console.log('');
    console.log(`  Total: ${totalPassed}/${totalTests} tests`);
    
    if (totalPassed === totalTests) {
      log('green', `\n✓ All ${totalTests} tests passed!`);
    } else {
      log('red', `\n✗ ${totalTests - totalPassed} of ${totalTests} tests failed`);
    }
    
  } catch (error) {
    log('red', `\n✗ Error: ${error.message}`);
    console.error(error);
  } finally {
    await mongoose.disconnect();
  }
}

main();
