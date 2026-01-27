#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * REAL ENDPOINT TEST SCRIPT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Tests actual metered endpoints (not debug endpoints) to verify quota enforcement
 * works end-to-end. Uses anonymous tier with low limits for quick testing.
 * 
 * Usage:
 *   node test/new-auth/test-real-endpoints.js
 * 
 * Requirements:
 *   - Server running with DEBUG_MODE=true on localhost:4132
 *   - MONGO_DEBUG_URI env var set
 */

require('dotenv').config();
const mongoose = require('mongoose');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4132';

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

async function cleanupAnonymousEntitlements() {
  log('yellow', '\nCleaning up anonymous (IP-based) entitlements...');
  
  // Get or create model (avoid "Cannot overwrite model" error)
  const Entitlement = mongoose.models.Entitlement || mongoose.model('Entitlement', new mongoose.Schema({}, { strict: false }), 'entitlements');
  
  // Delete IP-based entitlements (anonymous users)
  const deleteResult = await Entitlement.deleteMany({
    identifierType: 'ip'
  });
  
  log('green', `  ✓ Deleted ${deleteResult.deletedCount} anonymous entitlement records`);
}

// ─────────────────────────────────────────────────────────────────────────────────
// HTTP Helpers
// ─────────────────────────────────────────────────────────────────────────────────

async function fetchWithStatus(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  
  const data = await response.json().catch(() => ({}));
  
  return {
    status: response.status,
    data,
    headers: {
      quotaUsed: response.headers.get('X-Quota-Used'),
      quotaMax: response.headers.get('X-Quota-Max'),
      quotaRemaining: response.headers.get('X-Quota-Remaining')
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────────
// Real Endpoint Tests
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Test /api/search-quotes-3d with real query
 * Anonymous limit: 3 in debug mode
 */
async function testSearch3D() {
  log('blue', '\n───────────────────────────────────────────────────────────────────────────────');
  log('blue', 'Testing: POST /api/search-quotes-3d (Anonymous, limit: 3)');
  log('blue', '───────────────────────────────────────────────────────────────────────────────');
  
  const testQueries = [
    'bitcoin and economics',
    'artificial intelligence future',
    'health and nutrition',
    'space exploration' // This should be blocked (4th request)
  ];
  
  for (let i = 0; i < testQueries.length; i++) {
    const query = testQueries[i];
    log('dim', `  Request ${i + 1}: "${query}"`);
    
    const result = await fetchWithStatus(`${BASE_URL}/api/search-quotes-3d`, {
      method: 'POST',
      body: JSON.stringify({
        query,
        limit: 5,
        fastMode: true // Use fast mode to speed up test
      })
    });
    
    if (result.status === 429) {
      if (i === 3) { // 4th request (index 3)
        log('green', `    ✓ Request ${i + 1}: BLOCKED with 429 (quota exceeded as expected)`);
        log('green', '\n✓ /api/search-quotes-3d correctly enforces quota limit');
        return true;
      } else {
        log('red', `    ✗ Request ${i + 1}: Blocked too early!`);
        return false;
      }
    } else if (result.status === 200) {
      const resultCount = result.data.results?.length || 0;
      log('green', `    ✓ Request ${i + 1}: OK (${resultCount} results, quota: ${result.headers.quotaUsed}/${result.headers.quotaMax})`);
    } else {
      log('yellow', `    ⚠ Request ${i + 1}: Status ${result.status} - ${result.data.error || 'Unknown error'}`);
      // Don't fail on non-quota errors (might be missing data, etc.)
    }
  }
  
  log('red', '\n✗ /api/search-quotes-3d did NOT enforce quota limit');
  return false;
}

/**
 * Test /api/search-quotes with real query
 * Anonymous limit: 3 in debug mode
 */
async function testSearchQuotes() {
  log('blue', '\n───────────────────────────────────────────────────────────────────────────────');
  log('blue', 'Testing: POST /api/search-quotes (Anonymous, limit: 3)');
  log('blue', '───────────────────────────────────────────────────────────────────────────────');
  
  const testQueries = [
    'money and freedom',
    'technology innovation',
    'climate change',
    'meditation benefits' // This should be blocked (4th request)
  ];
  
  for (let i = 0; i < testQueries.length; i++) {
    const query = testQueries[i];
    log('dim', `  Request ${i + 1}: "${query}"`);
    
    const result = await fetchWithStatus(`${BASE_URL}/api/search-quotes`, {
      method: 'POST',
      body: JSON.stringify({
        query,
        limit: 3
      })
    });
    
    if (result.status === 429) {
      if (i === 3) { // 4th request
        log('green', `    ✓ Request ${i + 1}: BLOCKED with 429 (quota exceeded as expected)`);
        log('green', '\n✓ /api/search-quotes correctly enforces quota limit');
        return true;
      } else {
        log('red', `    ✗ Request ${i + 1}: Blocked too early!`);
        return false;
      }
    } else if (result.status === 200) {
      const resultCount = result.data.results?.length || 0;
      log('green', `    ✓ Request ${i + 1}: OK (${resultCount} results, quota: ${result.headers.quotaUsed}/${result.headers.quotaMax})`);
    } else {
      log('yellow', `    ⚠ Request ${i + 1}: Status ${result.status} - ${result.data.error || 'Unknown error'}`);
    }
  }
  
  log('red', '\n✗ /api/search-quotes did NOT enforce quota limit');
  return false;
}

/**
 * Test checkEligibility endpoint shows correct quotas
 */
async function testCheckEligibility() {
  log('blue', '\n───────────────────────────────────────────────────────────────────────────────');
  log('blue', 'Testing: GET /api/on-demand/checkEligibility (Anonymous)');
  log('blue', '───────────────────────────────────────────────────────────────────────────────');
  
  const result = await fetchWithStatus(`${BASE_URL}/api/on-demand/checkEligibility`);
  
  if (result.status !== 200) {
    log('red', `  ✗ Unexpected status: ${result.status}`);
    return false;
  }
  
  const { tier, entitlements } = result.data;
  
  if (tier !== 'anonymous') {
    log('red', `  ✗ Expected tier 'anonymous', got '${tier}'`);
    return false;
  }
  
  log('green', `  ✓ Tier: ${tier}`);
  
  // Check all entitlement types are present
  const expectedTypes = ['searchQuotes', 'search3D', 'makeClip', 'jamieAssist', 'researchAnalyze', 'onDemandRun'];
  const missingTypes = expectedTypes.filter(t => !entitlements[t]);
  
  if (missingTypes.length > 0) {
    log('red', `  ✗ Missing entitlement types: ${missingTypes.join(', ')}`);
    return false;
  }
  
  log('green', '  ✓ All entitlement types present:');
  for (const type of expectedTypes) {
    const ent = entitlements[type];
    console.log(`      ${type}: ${ent.used}/${ent.max} (remaining: ${ent.remaining})`);
  }
  
  log('green', '\n✓ checkEligibility returns correct data');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────────

async function main() {
  log('blue', '═══════════════════════════════════════════════════════════════════════════════');
  log('blue', '                    REAL ENDPOINT TEST SCRIPT');
  log('blue', '═══════════════════════════════════════════════════════════════════════════════');
  console.log('');
  log('yellow', `⚠️  Make sure DEBUG_MODE=true and server is running on ${BASE_URL}`);
  log('yellow', '⚠️  Tests actual endpoints with real queries (anonymous tier)');
  log('yellow', '⚠️  Anonymous debug limits: searchQuotes=3, search3D=3');
  console.log('');
  
  try {
    // Connect to MongoDB and cleanup
    await connectToMongo();
    await cleanupAnonymousEntitlements();
    
    // Check server is running
    log('yellow', '\nChecking server health...');
    try {
      const health = await fetchWithStatus(`${BASE_URL}/api/on-demand/checkEligibility`);
      if (health.status !== 200) throw new Error('Bad status');
      log('green', '✓ Server is running');
    } catch (e) {
      log('red', `✗ Server not responding at ${BASE_URL}`);
      log('yellow', 'Start the server with: DEBUG_MODE=true node server.js');
      process.exit(1);
    }
    
    // Run tests
    log('blue', '\n═══════════════════════════════════════════════════════════════════════════════');
    log('blue', '                         REAL ENDPOINT TESTS');
    log('blue', '═══════════════════════════════════════════════════════════════════════════════');
    
    const results = {};
    
    // Test checkEligibility first
    results.checkEligibility = await testCheckEligibility();
    
    // Reset and test search-quotes-3d
    await cleanupAnonymousEntitlements();
    results.search3D = await testSearch3D();
    
    // Reset and test search-quotes
    await cleanupAnonymousEntitlements();
    results.searchQuotes = await testSearchQuotes();
    
    // Summary
    log('blue', '\n═══════════════════════════════════════════════════════════════════════════════');
    log('blue', '                         TEST SUMMARY');
    log('blue', '═══════════════════════════════════════════════════════════════════════════════');
    
    const passed = Object.values(results).filter(r => r).length;
    const total = Object.keys(results).length;
    
    for (const [name, passed] of Object.entries(results)) {
      const status = passed 
        ? `${colors.green}✓ PASSED${colors.reset}` 
        : `${colors.red}✗ FAILED${colors.reset}`;
      console.log(`  ${name}: ${status}`);
    }
    
    console.log('');
    if (passed === total) {
      log('green', `✓ All ${total} tests passed!`);
    } else {
      log('red', `✗ ${total - passed} of ${total} tests failed`);
    }
    
  } catch (error) {
    log('red', `\n✗ Error: ${error.message}`);
    console.error(error);
  } finally {
    await mongoose.disconnect();
  }
}

main();
