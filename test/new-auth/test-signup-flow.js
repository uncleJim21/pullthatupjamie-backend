#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TEST: New Auth Signup Flow
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Tests the full signup flow:
 *   1. Signup on Auth Server → get JWT
 *   2. Use JWT to access Backend debug endpoint
 *   3. Test authenticated search endpoint
 * 
 * Prerequisites:
 *   - Auth server running on port 6111
 *   - Backend running on port 4132
 * 
 * Usage:
 *   node test/new-auth/test-signup-flow.js [email]
 */

require('dotenv').config();

const AUTH_SERVER = process.env.AUTH_SERVER || 'http://localhost:6111';
const BACKEND_SERVER = process.env.BACKEND_SERVER || 'http://localhost:4132';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const log = (color, ...args) => console.log(`${colors[color]}${args.join(' ')}${colors.reset}`);

// Generate unique email if not provided
const email = process.argv[2] || `test+${Date.now()}@example.com`;
const password = 'testpass123';

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

async function main() {
  console.log('');
  log('blue', '══════════════════════════════════════════════════════════════════');
  log('blue', '  TEST: New Auth Signup Flow');
  log('blue', '══════════════════════════════════════════════════════════════════');
  console.log('');
  log('cyan', `Auth Server:  ${AUTH_SERVER}`);
  log('cyan', `Backend:      ${BACKEND_SERVER}`);
  log('cyan', `Test Email:   ${email}`);
  console.log('');

  let token = null;
  let passed = 0;
  let failed = 0;

  // ─────────────────────────────────────────────
  // Step 1: Signup on Auth Server
  // ─────────────────────────────────────────────
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 1: Signup');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  const signupResult = await makeRequest(`${AUTH_SERVER}/auth/signup`, {
    method: 'POST',
    body: JSON.stringify({
      provider: 'email',
      credentials: { email, password }
    }),
  });

  console.log('Response:', JSON.stringify(signupResult.data, null, 2));
  
  if (signupResult.ok && signupResult.data.token) {
    token = signupResult.data.token;
    log('green', `✓ Got JWT token: ${token.substring(0, 50)}...`);
    
    const payload = decodeJWT(token);
    if (payload) {
      console.log('JWT Payload:', JSON.stringify(payload, null, 2));
    }
    passed++;
  } else {
    log('red', '✗ Failed to get token from signup');
    failed++;
    console.log('');
    log('red', 'Cannot continue without token. Exiting.');
    process.exit(1);
  }
  console.log('');

  // ─────────────────────────────────────────────
  // Step 2: Test Backend Debug Endpoint
  // ─────────────────────────────────────────────
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 2: Test Backend (debug/user-docs)');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  const debugResult = await makeRequest(`${BACKEND_SERVER}/api/debug/user-docs`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  console.log('Response:', JSON.stringify(debugResult.data, null, 2));
  
  if (debugResult.ok && debugResult.data.count >= 1) {
    log('green', '✓ User found in backend');
    passed++;
  } else if (debugResult.status === 404) {
    log('yellow', '⚠ Debug endpoint not available (may not be in DEBUG_MODE)');
  } else {
    log('yellow', '⚠ User might not be found (check response)');
  }
  console.log('');

  // ─────────────────────────────────────────────
  // Step 3: Test Search Quotes (with entitlement)
  // ─────────────────────────────────────────────
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 3: Test Search Quotes Endpoint');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  const searchResult = await makeRequest(`${BACKEND_SERVER}/api/search-quotes-3d`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      query: 'test query',
      limit: 5
    }),
  });

  console.log(`Status: ${searchResult.status}`);
  if (searchResult.data.results) {
    console.log(`Results: ${searchResult.data.results.length} items`);
    log('green', '✓ Search endpoint accessible');
    passed++;
  } else if (searchResult.status === 429) {
    log('yellow', '⚠ Quota exceeded (expected if limits are low)');
    console.log('Response:', JSON.stringify(searchResult.data, null, 2));
  } else {
    log('yellow', '⚠ Search returned unexpected response');
    console.log('Response:', JSON.stringify(searchResult.data, null, 2).substring(0, 500));
  }
  console.log('');

  // ─────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────
  log('blue', '══════════════════════════════════════════════════════════════════');
  log('blue', '  Summary');
  log('blue', '══════════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Email:    ${email}`);
  console.log(`Password: ${password}`);
  console.log(`Token:    ${token.substring(0, 80)}...`);
  console.log('');
  log('green', `Passed: ${passed}`);
  if (failed > 0) log('red', `Failed: ${failed}`);
  console.log('');
  log('cyan', 'To use this token in other tests:');
  console.log(`export TEST_TOKEN="${token}"`);
  console.log('');
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  log('red', 'Unexpected error:', err.message);
  process.exit(1);
});
