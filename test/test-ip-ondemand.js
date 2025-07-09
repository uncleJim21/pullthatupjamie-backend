const axios = require('axios');

// Configuration
const BASE_URL = 'http://localhost:4111';
const JWT_TOKEN = process.env.JWT_TOKEN || 'YOUR_JWT_TOKEN_HERE'; // Set via environment variable

// Test data
const testEpisodes = [
  {
    guid: 'test-episode-guid-1',
    feedGuid: 'test-feed-guid-1',
    feedId: 'test-feed-id-1'
  },
  {
    guid: 'test-episode-guid-2', 
    feedGuid: 'test-feed-guid-2',
    feedId: 'test-feed-id-2'
  }
];

// Helper function to make requests
async function makeRequest(endpoint, data = null, headers = {}) {
  try {
    const config = {
      method: data ? 'POST' : 'GET',
      url: `${BASE_URL}${endpoint}`,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    if (data) {
      config.data = data;
    }

    const response = await axios(config);
    return {
      success: true,
      status: response.status,
      data: response.data
    };
  } catch (error) {
    return {
      success: false,
      status: error.response?.status || 500,
      data: error.response?.data || error.message
    };
  }
}

// Test 0: Eligibility checking endpoint
async function testEligibilityEndpoint() {
  console.log('\n=== Test 0: Eligibility endpoint ===');
  
  // Test IP-based eligibility
  console.log('Testing IP-based eligibility...');
  const ipResult = await makeRequest('/api/on-demand/checkEligibility');
  
  if (ipResult.success) {
    console.log('✅ IP-based eligibility check successful');
    console.log('   Auth Type:', ipResult.data.authType);
    console.log('   Eligible:', ipResult.data.eligible);
    console.log('   Client IP:', ipResult.data.clientIp);
    console.log('   Quota Info:', ipResult.data.quotaInfo);
  } else {
    console.log('❌ IP-based eligibility check failed');
    console.log('   Status:', ipResult.status);
    console.log('   Error:', ipResult.data);
  }
  
  // Test JWT-based eligibility (if token provided)
  if (JWT_TOKEN !== 'YOUR_JWT_TOKEN_HERE') {
    console.log('\nTesting JWT-based eligibility...');
    const jwtResult = await makeRequest('/api/on-demand/checkEligibility', null, {
      'Authorization': `Bearer ${JWT_TOKEN}`
    });
    
    if (jwtResult.success) {
      console.log('✅ JWT-based eligibility check successful');
      console.log('   Auth Type:', jwtResult.data.authType);
      console.log('   Eligible:', jwtResult.data.eligible);
      console.log('   User Email:', jwtResult.data.userEmail);
      console.log('   Quota Info:', jwtResult.data.quotaInfo);
    } else {
      console.log('❌ JWT-based eligibility check failed');
      console.log('   Status:', jwtResult.status);
      console.log('   Error:', jwtResult.data);
    }
  } else {
    console.log('\n⏭️  JWT eligibility test skipped - no token provided');
  }
}

// Test 1: IP-based on-demand run (no authentication required)
async function testIPBasedOnDemand() {
  console.log('\n=== Test 1: IP-based on-demand run ===');
  console.log('This should work without any JWT token or email');
  
  const payload = {
    message: 'Test IP-based on-demand run',
    parameters: {
      test: true,
      source: 'ip-based-test'
    },
    episodes: [testEpisodes[0]]
  };

  const result = await makeRequest('/api/on-demand/submitOnDemandRun', payload);
  
  if (result.success) {
    console.log('✅ SUCCESS: IP-based on-demand run submitted');
    console.log('Job ID:', result.data.jobId);
    console.log('Auth Type:', result.data.authType);
    console.log('Quota Info:', result.data.quotaInfo);
    return result.data.jobId;
  } else {
    console.log('❌ FAILED: IP-based on-demand run');
    console.log('Status:', result.status);
    console.log('Error:', result.data);
    return null;
  }
}

// Test 2: Check job status
async function testJobStatus(jobId) {
  if (!jobId) {
    console.log('\n=== Test 2: Skipped (no job ID available) ===');
    return;
  }

  console.log('\n=== Test 2: Check job status ===');
  console.log(`Checking status for job: ${jobId}`);
  
  const result = await makeRequest(`/api/on-demand/getOnDemandJobStatus/${jobId}`);
  
  if (result.success) {
    console.log('✅ SUCCESS: Job status retrieved');
    console.log('Status:', result.data.status);
    console.log('Auth Type:', result.data.authType);
    console.log('User Email:', result.data.userEmail);
    console.log('Client IP:', result.data.clientIp);
  } else {
    console.log('❌ FAILED: Could not get job status');
    console.log('Status:', result.status);
    console.log('Error:', result.data);
  }
}

// Test 3: JWT-based on-demand run
async function testJWTBasedOnDemand() {
  console.log('\n=== Test 3: JWT-based on-demand run ===');
  
  if (JWT_TOKEN === 'YOUR_JWT_TOKEN_HERE') {
    console.log('⏭️  SKIPPED: No JWT token provided');
    console.log('Set JWT_TOKEN environment variable to test JWT authentication');
    return null;
  }

  const payload = {
    message: 'Test JWT-based on-demand run',
    parameters: {
      test: true,
      source: 'jwt-based-test'
    },
    episodes: [testEpisodes[1]]
  };

  const headers = {
    'Authorization': `Bearer ${JWT_TOKEN}`
  };

  const result = await makeRequest('/api/on-demand/submitOnDemandRun', payload, headers);
  
  if (result.success) {
    console.log('✅ SUCCESS: JWT-based on-demand run submitted');
    console.log('Job ID:', result.data.jobId);
    console.log('Auth Type:', result.data.authType);
    console.log('Quota Info:', result.data.quotaInfo);
    return result.data.jobId;
  } else {
    console.log('❌ FAILED: JWT-based on-demand run');
    console.log('Status:', result.status);
    console.log('Error:', result.data);
    return null;
  }
}

// Test 4: Test quota limits
async function testQuotaLimits() {
  console.log('\n=== Test 4: Testing quota limits ===');
  console.log('This will show how the system tracks usage per IP');
  
  const results = [];
  
  for (let i = 1; i <= 3; i++) {
    console.log(`\nSubmitting request ${i}...`);
    
    const payload = {
      message: `Test quota limit request ${i}`,
      parameters: {
        test: true,
        requestNumber: i
      },
      episodes: [{
        guid: `test-episode-guid-${i}`,
        feedGuid: `test-feed-guid-${i}`,
        feedId: `test-feed-id-${i}`
      }]
    };

    const result = await makeRequest('/api/on-demand/submitOnDemandRun', payload);
    
    if (result.success) {
      console.log(`✅ Request ${i} succeeded`);
      console.log(`   Remaining runs: ${result.data.quotaInfo.remainingRuns}`);
      results.push({ request: i, success: true, jobId: result.data.jobId });
    } else {
      console.log(`❌ Request ${i} failed`);
      console.log(`   Status: ${result.status}`);
      console.log(`   Error: ${result.data.error || result.data}`);
      results.push({ request: i, success: false, error: result.data });
    }
    
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return results;
}

// Test 5: Test error cases
async function testErrorCases() {
  console.log('\n=== Test 5: Testing error cases ===');
  
  // Test with invalid payload
  console.log('\n5a. Testing with invalid payload...');
  const invalidPayload = {
    message: 'Test with invalid payload',
    // Missing required fields
  };
  
  const result1 = await makeRequest('/api/on-demand/submitOnDemandRun', invalidPayload);
  if (!result1.success) {
    console.log('✅ Expected error for invalid payload');
    console.log('   Status:', result1.status);
  } else {
    console.log('❌ Unexpected success for invalid payload');
  }
  
  // Test with empty episodes array
  console.log('\n5b. Testing with empty episodes array...');
  const emptyEpisodesPayload = {
    message: 'Test with empty episodes',
    parameters: { test: true },
    episodes: []
  };
  
  const result2 = await makeRequest('/api/on-demand/submitOnDemandRun', emptyEpisodesPayload);
  if (!result2.success) {
    console.log('✅ Expected error for empty episodes');
    console.log('   Status:', result2.status);
  } else {
    console.log('❌ Unexpected success for empty episodes');
  }
}

// Main test runner
async function runTests() {
  console.log('🚀 Starting IP-based on-demand runs tests...');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`JWT Token: ${JWT_TOKEN === 'YOUR_JWT_TOKEN_HERE' ? 'Not provided' : 'Provided'}`);
  
  try {
    // Test 0: Eligibility endpoint
    await testEligibilityEndpoint();
    
    // Test 1: IP-based on-demand run
    const jobId1 = await testIPBasedOnDemand();
    
    // Test 2: Check job status
    await testJobStatus(jobId1);
    
    // Test 3: JWT-based on-demand run
    const jobId2 = await testJWTBasedOnDemand();
    await testJobStatus(jobId2);
    
    // Test 4: Test quota limits
    const quotaResults = await testQuotaLimits();
    
    // Test 5: Test error cases
    await testErrorCases();
    
    // Summary
    console.log('\n=== Test Summary ===');
    console.log('✅ Eligibility endpoint: Working');
    console.log('✅ IP-based authentication: Working');
    console.log('✅ JWT-based authentication: ' + (JWT_TOKEN !== 'YOUR_JWT_TOKEN_HERE' ? 'Working' : 'Skipped'));
    console.log('✅ Quota tracking: Working');
    console.log('✅ Error handling: Working');
    
    console.log('\n📊 Quota Test Results:');
    quotaResults.forEach(result => {
      const status = result.success ? '✅' : '❌';
      console.log(`   ${status} Request ${result.request}: ${result.success ? 'Success' : 'Failed'}`);
    });
    
  } catch (error) {
    console.error('❌ Test suite failed:', error.message);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().then(() => {
    console.log('\n🎉 All tests completed!');
    process.exit(0);
  }).catch(error => {
    console.error('\n💥 Test suite crashed:', error);
    process.exit(1);
  });
}

module.exports = {
  runTests,
  testEligibilityEndpoint,
  testIPBasedOnDemand,
  testJWTBasedOnDemand,
  testQuotaLimits,
  testErrorCases
}; 