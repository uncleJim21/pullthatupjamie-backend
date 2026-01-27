#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TEST: New Auth Signin Flow
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Tests the full signin flow:
 *   1. Signin on Auth Server → get JWT
 *   2. Decode and display JWT payload
 *   3. Use JWT to access Backend debug endpoint
 *   4. Test identity resolution
 *   5. Test anonymous access
 * 
 * Prerequisites:
 *   - Auth server running on port 6111
 *   - Backend running on port 4132
 *   - User already exists (run test-signup-flow.js first)
 * 
 * Usage:
 *   node test/new-auth/test-signin-flow.js [email] [password]
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

// Use provided credentials or defaults
const email = process.argv[2] || 'jim.carucci+wim@protonmail.com';
const password = process.argv[3] || 'testpass123';

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
  log('blue', '  TEST: New Auth Signin Flow');
  log('blue', '══════════════════════════════════════════════════════════════════');
  console.log('');
  log('cyan', `Auth Server:  ${AUTH_SERVER}`);
  log('cyan', `Backend:      ${BACKEND_SERVER}`);
  log('cyan', `Email:        ${email}`);
  console.log('');

  let token = null;
  let passed = 0;
  let failed = 0;

  // ─────────────────────────────────────────────
  // Step 1: Signin on Auth Server
  // ─────────────────────────────────────────────
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 1: Signin');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  const signinResult = await makeRequest(`${AUTH_SERVER}/auth/signin`, {
    method: 'POST',
    body: JSON.stringify({
      provider: 'email',
      credentials: { email, password }
    }),
  });

  console.log('Response:', JSON.stringify(signinResult.data, null, 2));
  
  if (signinResult.ok && signinResult.data.token) {
    token = signinResult.data.token;
    log('green', `✓ Got JWT token: ${token.substring(0, 50)}...`);
    
    const payload = decodeJWT(token);
    if (payload) {
      console.log('');
      log('cyan', 'JWT Payload:');
      console.log(JSON.stringify(payload, null, 2));
    }
    passed++;
  } else {
    log('red', '✗ Failed to get token from signin');
    console.log('');
    if (signinResult.status === 401) {
      log('yellow', 'Hint: User may not exist. Run test-signup-flow.js first.');
    }
    failed++;
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
  
  if (debugResult.ok) {
    log('green', '✓ Debug endpoint accessible');
    passed++;
  } else if (debugResult.status === 404) {
    log('yellow', '⚠ Debug endpoint not available (may not be in DEBUG_MODE)');
  } else {
    log('yellow', '⚠ Unexpected response from debug endpoint');
  }
  console.log('');

  // ─────────────────────────────────────────────
  // Step 3: Test Identity Resolution
  // ─────────────────────────────────────────────
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 3: Test Identity Resolution (authenticated)');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  const identityResult = await makeRequest(`${BACKEND_SERVER}/api/debug/test-identity`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (identityResult.ok) {
    console.log('Response:', JSON.stringify(identityResult.data, null, 2));
    log('green', '✓ Identity resolved');
    if (identityResult.data.identity?.tier) {
      log('cyan', `  Tier: ${identityResult.data.identity.tier}`);
    }
    passed++;
  } else if (identityResult.status === 404) {
    log('yellow', '⚠ Identity endpoint not available (may not be in DEBUG_MODE)');
  } else {
    log('yellow', '⚠ Unexpected response');
    console.log('Response:', JSON.stringify(identityResult.data, null, 2));
  }
  console.log('');

  // ─────────────────────────────────────────────
  // Step 4: Test Anonymous Access
  // ─────────────────────────────────────────────
  log('yellow', '─────────────────────────────────────────────────────────────────');
  log('yellow', 'Step 4: Test Anonymous Access (no token)');
  log('yellow', '─────────────────────────────────────────────────────────────────');
  
  const anonResult = await makeRequest(`${BACKEND_SERVER}/api/debug/test-identity`);

  if (anonResult.ok) {
    console.log('Response:', JSON.stringify(anonResult.data, null, 2));
    if (anonResult.data.identity?.tier === 'anonymous') {
      log('green', '✓ Anonymous identity resolved correctly');
      passed++;
    } else {
      log('yellow', '⚠ Anonymous tier not detected');
    }
  } else if (anonResult.status === 404) {
    log('yellow', '⚠ Identity endpoint not available (may not be in DEBUG_MODE)');
  } else {
    log('yellow', '⚠ Unexpected response');
    console.log('Response:', JSON.stringify(anonResult.data, null, 2));
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
  log('cyan', 'To use this token in other tests:');
  console.log(`export TEST_TOKEN="${token}"`);
  console.log('');
  log('cyan', 'Example curl command:');
  console.log(`curl -H "Authorization: Bearer $TEST_TOKEN" ${BACKEND_SERVER}/api/debug/user-docs`);
  console.log('');
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  log('red', 'Unexpected error:', err.message);
  process.exit(1);
});
