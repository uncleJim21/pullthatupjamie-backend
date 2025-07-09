const axios = require('axios');

// Test eligibility checking endpoint
async function testEligibility() {
  console.log('🚀 Testing on-demand eligibility endpoint...');
  
  const BASE_URL = 'http://localhost:4111';
  const JWT_TOKEN = process.env.JWT_TOKEN || 'YOUR_JWT_TOKEN_HERE';
  
  try {
    // Test 1: IP-based eligibility (no auth)
    console.log('\n=== Test 1: IP-based eligibility ===');
    console.log('Checking eligibility without authentication...');
    
    const ipResponse = await axios.get(`${BASE_URL}/api/check-ondemand-eligibility`, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (ipResponse.data.success) {
      console.log('✅ IP-based eligibility check successful');
      console.log('   Eligible:', ipResponse.data.eligibility.eligible);
      console.log('   Client IP:', ipResponse.data.clientIp);
      console.log('   Quota Info:', {
        remainingRuns: ipResponse.data.eligibility.remainingRuns,
        usedThisPeriod: ipResponse.data.eligibility.usedThisPeriod,
        totalLimit: ipResponse.data.eligibility.totalLimit,
        daysUntilReset: ipResponse.data.eligibility.daysUntilReset
      });
      console.log('   Message:', ipResponse.data.message);
    } else {
      console.log('❌ IP-based eligibility check failed');
      console.log('   Error:', ipResponse.data.error);
    }
    
    // Test 2: JWT-based eligibility (if token provided)
    if (JWT_TOKEN !== 'YOUR_JWT_TOKEN_HERE') {
      console.log('\n=== Test 2: JWT-based eligibility ===');
      console.log('Checking eligibility with JWT token...');
      
      const jwtResponse = await axios.get(`${BASE_URL}/api/check-ondemand-eligibility`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${JWT_TOKEN}`
        }
      });
      
      if (jwtResponse.data.success) {
        console.log('✅ JWT-based eligibility check successful');
        console.log('   Eligible:', jwtResponse.data.eligibility.eligible);
        console.log('   User Email:', jwtResponse.data.userEmail);
        console.log('   Quota Info:', {
          remainingRuns: jwtResponse.data.eligibility.remainingRuns,
          usedThisPeriod: jwtResponse.data.eligibility.usedThisPeriod,
          totalLimit: jwtResponse.data.eligibility.totalLimit,
          daysUntilReset: jwtResponse.data.eligibility.daysUntilReset
        });
        console.log('   Message:', jwtResponse.data.message);
      } else {
        console.log('❌ JWT-based eligibility check failed');
        console.log('   Error:', jwtResponse.data.error);
      }
    } else {
      console.log('\n=== Test 2: JWT-based eligibility ===');
      console.log('⏭️  SKIPPED: No JWT token provided');
      console.log('Set JWT_TOKEN environment variable to test JWT authentication');
    }
    
    // Test 3: Compare quota between IP and JWT
    if (JWT_TOKEN !== 'YOUR_JWT_TOKEN_HERE') {
      console.log('\n=== Test 3: Quota comparison ===');
      
      const ipEligibility = ipResponse.data;
      const jwtEligibility = jwtResponse.data;
      
      console.log('IP-based quota:');
      console.log(`   Remaining: ${ipEligibility.eligibility.remainingRuns}/${ipEligibility.eligibility.totalLimit}`);
      console.log(`   Used: ${ipEligibility.eligibility.usedThisPeriod}`);
      
      console.log('JWT-based quota:');
      console.log(`   Remaining: ${jwtEligibility.eligibility.remainingRuns}/${jwtEligibility.eligibility.totalLimit}`);
      console.log(`   Used: ${jwtEligibility.eligibility.usedThisPeriod}`);
      
      if (ipEligibility.eligibility.remainingRuns !== jwtEligibility.eligibility.remainingRuns) {
        console.log('✅ Separate quota tracking working correctly');
      } else {
        console.log('⚠️  Quotas are the same - may be expected if both are new');
      }
    }
    
    // Test 4: Error cases
    console.log('\n=== Test 4: Error cases ===');
    
    // Test with invalid JWT token
    console.log('\n4a. Testing with invalid JWT token...');
    try {
      const invalidJwtResponse = await axios.get(`${BASE_URL}/api/check-ondemand-eligibility`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer invalid_token_here'
        }
      });
      
      if (invalidJwtResponse.data.clientIp) {
        console.log('✅ Correctly fell back to IP-based auth with invalid JWT');
      } else {
        console.log('❌ Unexpected response with invalid JWT');
      }
    } catch (error) {
      console.log('❌ Error with invalid JWT:', error.response?.status);
    }
    
    console.log('\n🎉 Eligibility tests completed!');
    
  } catch (error) {
    console.error('❌ Eligibility test failed:', error.response?.data || error.message);
    console.error('   Status:', error.response?.status);
  }
}

// Test eligibility before and after quota consumption
async function testEligibilityWithQuota() {
  console.log('\n🚀 Testing eligibility before and after quota consumption...');
  
  const BASE_URL = 'http://localhost:4111';
  
  try {
    // Check initial eligibility
    console.log('\n1. Checking initial eligibility...');
    const initialResponse = await axios.get(`${BASE_URL}/api/check-ondemand-eligibility`);
    const initialEligibility = initialResponse.data;
    
    console.log('   Initial remaining runs:', initialEligibility.eligibility.remainingRuns);
    
    if (initialEligibility.eligibility.remainingRuns > 0) {
      // Submit a job to consume quota
      console.log('\n2. Submitting job to consume quota...');
      const submitResponse = await axios.post(`${BASE_URL}/api/on-demand/submitOnDemandRun`, {
        message: 'Eligibility test job',
        parameters: { test: true },
        episodes: [{
          guid: 'eligibility-test-guid',
          feedGuid: 'eligibility-test-feed-guid',
          feedId: 'eligibility-test-feed-id'
        }]
      });
      
      console.log('   Job submitted successfully');
      console.log('   Remaining runs after submission:', submitResponse.data.quotaInfo.remainingRuns);
      
      // Check eligibility again
      console.log('\n3. Checking eligibility after quota consumption...');
      const finalResponse = await axios.get(`${BASE_URL}/api/check-ondemand-eligibility`);
      const finalEligibility = finalResponse.data;
      
      console.log('   Final remaining runs:', finalEligibility.eligibility.remainingRuns);
      
      if (finalEligibility.eligibility.remainingRuns === initialEligibility.eligibility.remainingRuns - 1) {
        console.log('✅ Quota consumption tracked correctly');
      } else {
        console.log('❌ Quota consumption not tracked correctly');
      }
    } else {
      console.log('   No remaining runs - skipping quota consumption test');
    }
    
  } catch (error) {
    console.error('❌ Quota consumption test failed:', error.response?.data || error.message);
  }
}

// Run tests
if (require.main === module) {
  testEligibility()
    .then(() => testEligibilityWithQuota())
    .then(() => {
      console.log('\n🎉 All eligibility tests completed!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 Eligibility tests failed:', error);
      process.exit(1);
    });
}

module.exports = {
  testEligibility,
  testEligibilityWithQuota
}; 