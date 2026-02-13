#!/usr/bin/env node
/**
 * Twitter OAuth Authentication Test Script
 * 
 * Tests the Twitter auth flow between backend and auth server.
 * 
 * PREREQUISITES:
 *   - Backend running on PORT (default 4132)
 *   - Auth server running on AUTH_SERVER_INTERNAL_URL (default 6111)
 *   - JAMIE_TO_AUTH_SERVER_HMAC_SECRET set in both servers
 *   - Twitter OAuth configured in backend
 * 
 * USAGE:
 *   node test/new-auth/test-twitter-auth.js
 *   
 *   # Test exchange endpoint with a temp code:
 *   node test/new-auth/test-twitter-auth.js --exchange tc_abc123
 */

require('dotenv').config();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4132';
const AUTH_SERVER_URL = process.env.AUTH_SERVER_INTERNAL_URL || 'http://localhost:6111';

// ============================================
// HELPERS
// ============================================

function log(emoji, message, data = null) {
  console.log(`${emoji} ${message}`);
  if (data) {
    console.log('   ', typeof data === 'string' ? data : JSON.stringify(data, null, 2).split('\n').join('\n    '));
  }
}

function header(title) {
  console.log('\n' + '═'.repeat(70));
  console.log(` ${title}`);
  console.log('═'.repeat(70));
}

// ============================================
// TESTS
// ============================================

/**
 * Test 1: Verify auth-initiate endpoint exists and redirects to Twitter
 */
async function testAuthInitiate() {
  header('TEST 1: /api/twitter/auth-initiate');
  
  try {
    const url = `${BACKEND_URL}/api/twitter/auth-initiate?redirect_uri=http://localhost:3000/auth/callback`;
    log('📤', 'GET', url);
    
    // Use fetch with redirect: 'manual' to capture the redirect
    const response = await fetch(url, { 
      redirect: 'manual',
      headers: {
        'User-Agent': 'test-twitter-auth/1.0'
      }
    });
    
    const status = response.status;
    const location = response.headers.get('location');
    
    log('📥', `Status: ${status}`);
    
    if (status === 302 || status === 301) {
      // Twitter rebranded to X - check for both domains
      if (location && (location.includes('twitter.com') || location.includes('x.com'))) {
        log('✅', 'Redirects to Twitter/X OAuth');
        log('🔗', 'Location:', location.substring(0, 100) + '...');
        return true;
      } else {
        log('❌', 'Redirect location does not point to Twitter/X:', location);
        return false;
      }
    } else {
      const body = await response.text();
      log('❌', `Expected redirect (302), got ${status}`);
      log('📄', 'Body:', body.substring(0, 200));
      return false;
    }
    
  } catch (error) {
    log('❌', 'Request failed:', error.message);
    return false;
  }
}

/**
 * Test 2: Verify auth server is reachable
 */
async function testAuthServerHealth() {
  header('TEST 2: Auth Server Health Check');
  
  try {
    // Try a simple request to see if server is up
    // We'll try the exchange endpoint with an invalid code - should get 400, not connection error
    const response = await fetch(`${AUTH_SERVER_URL}/auth/twitter/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'invalid_test_code' })
    });
    
    const status = response.status;
    const data = await response.json().catch(() => ({}));
    
    log('📥', `Status: ${status}`);
    log('📄', 'Response:', data);
    
    if (status === 400 && data.error) {
      log('✅', 'Auth server is responding (returned expected error for invalid code)');
      return true;
    } else if (status === 404) {
      log('❌', 'Endpoint not found - auth server may not have Twitter routes implemented yet');
      return false;
    } else {
      log('⚠️', `Unexpected response, but server is reachable`);
      return true;
    }
    
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      log('❌', `Auth server not reachable at ${AUTH_SERVER_URL}`);
      log('💡', 'Make sure auth server is running');
    } else {
      log('❌', 'Request failed:', error.message);
    }
    return false;
  }
}

/**
 * Test 3: Test temp code exchange (if provided)
 */
async function testExchange(tempCode) {
  header('TEST 3: Exchange Temp Code for JWT');
  
  try {
    log('📤', 'POST', `${AUTH_SERVER_URL}/auth/twitter/exchange`);
    log('📦', 'Body:', { code: tempCode });
    
    const response = await fetch(`${AUTH_SERVER_URL}/auth/twitter/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: tempCode })
    });
    
    const status = response.status;
    const data = await response.json().catch(() => ({}));
    
    log('📥', `Status: ${status}`);
    
    if (status === 200 && data.success && data.token) {
      log('✅', 'Successfully exchanged code for JWT!');
      log('🎫', 'Token:', data.token.substring(0, 50) + '...');
      log('👤', 'User:', {
        twitterUsername: data.user?.twitterUsername,
        isNewUser: data.isNewUser,
        subscriptionValid: data.user?.subscriptionValid
      });
      
      // Test the JWT on the backend
      await testJwtOnBackend(data.token);
      return true;
      
    } else if (status === 400) {
      log('❌', 'Exchange failed:', data.error);
      log('💡', 'Code may be expired or already used');
      return false;
      
    } else {
      log('❌', 'Unexpected response:', data);
      return false;
    }
    
  } catch (error) {
    log('❌', 'Request failed:', error.message);
    return false;
  }
}

/**
 * Test 4: Verify JWT works on backend
 */
async function testJwtOnBackend(token) {
  header('TEST 4: Verify JWT on Backend');
  
  try {
    log('📤', 'GET', `${BACKEND_URL}/api/on-demand/checkEligibility`);
    
    const response = await fetch(`${BACKEND_URL}/api/on-demand/checkEligibility`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    const status = response.status;
    const data = await response.json().catch(() => ({}));
    
    log('📥', `Status: ${status}`);
    
    if (status === 200 && data.success) {
      log('✅', 'JWT is valid on backend!');
      log('👤', 'Identity:', {
        tier: data.tier,
        identifier: data.identifier,
        identifierType: data.identifierType,
        hasUser: data.hasUser
      });
      return true;
    } else {
      log('❌', 'JWT validation failed:', data);
      return false;
    }
    
  } catch (error) {
    log('❌', 'Request failed:', error.message);
    return false;
  }
}

/**
 * Print manual testing instructions
 */
function printManualInstructions() {
  header('MANUAL TESTING INSTRUCTIONS');
  
  console.log(`
Since Twitter OAuth requires browser interaction, follow these steps:

1. OPEN IN BROWSER:
   ${BACKEND_URL}/api/twitter/auth-initiate?redirect_uri=http://localhost:3000/auth/twitter/complete

2. AUTHORIZE ON TWITTER:
   - Log in to Twitter if needed
   - Click "Authorize app"

3. CAPTURE THE TEMP CODE:
   - You'll be redirected to: http://localhost:3000/auth/twitter/complete?code=tc_xxx&isNewUser=true
   - Copy the 'code' parameter value (e.g., tc_abc123def456...)

4. TEST THE EXCHANGE:
   node test/new-auth/test-twitter-auth.js --exchange <your_temp_code>

5. OR TEST WITH CURL:
   curl -X POST ${AUTH_SERVER_URL}/auth/twitter/exchange \\
     -H "Content-Type: application/json" \\
     -d '{"code": "<your_temp_code>"}'
`);
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('\n🐦 TWITTER OAUTH AUTHENTICATION TEST');
  console.log('═'.repeat(70));
  console.log(`Backend URL:     ${BACKEND_URL}`);
  console.log(`Auth Server URL: ${AUTH_SERVER_URL}`);
  
  // Check for --exchange flag
  const exchangeIndex = process.argv.indexOf('--exchange');
  if (exchangeIndex !== -1 && process.argv[exchangeIndex + 1]) {
    const tempCode = process.argv[exchangeIndex + 1];
    console.log(`\nMode: Exchange temp code`);
    await testExchange(tempCode);
    return;
  }
  
  console.log(`\nMode: Full test suite`);
  
  const results = {
    authInitiate: false,
    authServerHealth: false
  };
  
  // Run tests
  results.authInitiate = await testAuthInitiate();
  results.authServerHealth = await testAuthServerHealth();
  
  // Summary
  header('TEST SUMMARY');
  
  const passed = Object.values(results).filter(r => r).length;
  const total = Object.values(results).length;
  
  console.log(`\nPassed: ${passed}/${total}`);
  console.log('');
  
  for (const [test, result] of Object.entries(results)) {
    console.log(`  ${result ? '✅' : '❌'} ${test}`);
  }
  
  if (results.authInitiate && results.authServerHealth) {
    printManualInstructions();
  } else {
    console.log('\n⚠️  Fix the failing tests before proceeding with manual testing.');
    
    if (!results.authInitiate) {
      console.log('\n💡 Backend may not be running or Twitter OAuth not configured.');
    }
    if (!results.authServerHealth) {
      console.log('\n💡 Auth server may not be running or Twitter routes not implemented.');
    }
  }
  
  console.log('');
}

main().catch(console.error);
