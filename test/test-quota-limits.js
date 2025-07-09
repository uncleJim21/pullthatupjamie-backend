const axios = require('axios');

// Test quota limits for IP-based on-demand runs
async function testQuotaLimits() {
  console.log('🚀 Testing IP-based on-demand quota limits...');
  
  const BASE_URL = 'http://localhost:4111';
  const results = [];
  
  try {
    // Submit multiple requests to test quota tracking
    for (let i = 1; i <= 5; i++) {
      console.log(`\n--- Request ${i} ---`);
      
      try {
        const response = await axios.post(`${BASE_URL}/api/on-demand/submitOnDemandRun`, {
          message: `Quota test request ${i}`,
          parameters: { 
            test: true,
            requestNumber: i 
          },
          episodes: [{
            guid: `test-guid-${i}`,
            feedGuid: `test-feed-guid-${i}`,
            feedId: `test-feed-id-${i}`
          }]
        }, {
          headers: { 'Content-Type': 'application/json' }
        });
        
        console.log('✅ SUCCESS');
        console.log(`   Job ID: ${response.data.jobId}`);
        console.log(`   Auth Type: ${response.data.authType}`);
        console.log(`   Remaining Runs: ${response.data.quotaInfo.remainingRuns}`);
        console.log(`   Used This Period: ${response.data.quotaInfo.usedThisPeriod}`);
        console.log(`   Total Limit: ${response.data.quotaInfo.totalLimit}`);
        
        results.push({
          request: i,
          success: true,
          jobId: response.data.jobId,
          remainingRuns: response.data.quotaInfo.remainingRuns,
          usedThisPeriod: response.data.quotaInfo.usedThisPeriod
        });
        
      } catch (error) {
        console.log('❌ FAILED');
        console.log(`   Status: ${error.response?.status}`);
        console.log(`   Error: ${error.response?.data?.error || error.message}`);
        
        results.push({
          request: i,
          success: false,
          status: error.response?.status,
          error: error.response?.data?.error || error.message
        });
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Summary
    console.log('\n=== QUOTA TEST SUMMARY ===');
    console.log(`Total Requests: ${results.length}`);
    console.log(`Successful: ${results.filter(r => r.success).length}`);
    console.log(`Failed: ${results.filter(r => !r.success).length}`);
    
    console.log('\n📊 Results:');
    results.forEach(result => {
      const status = result.success ? '✅' : '❌';
      const details = result.success 
        ? `(Remaining: ${result.remainingRuns}, Used: ${result.usedThisPeriod})`
        : `(Status: ${result.status}, Error: ${result.error})`;
      
      console.log(`   ${status} Request ${result.request}: ${result.success ? 'Success' : 'Failed'} ${details}`);
    });
    
    // Check if quota was enforced
    const successfulRequests = results.filter(r => r.success);
    const failedRequests = results.filter(r => !r.success);
    
    if (successfulRequests.length > 0 && failedRequests.length > 0) {
      console.log('\n🎯 Quota enforcement working correctly!');
      console.log('   Some requests succeeded, some failed due to quota limits');
    } else if (successfulRequests.length === results.length) {
      console.log('\n⚠️  All requests succeeded - quota limit may be higher than expected');
    } else if (failedRequests.length === results.length) {
      console.log('\n⚠️  All requests failed - check if quota is set too low');
    }
    
  } catch (error) {
    console.error('💥 Test suite failed:', error.message);
  }
}

// Test quota reset functionality
async function testQuotaReset() {
  console.log('\n🚀 Testing quota reset functionality...');
  console.log('This test checks if quota resets after period expiration');
  
  const BASE_URL = 'http://localhost:4131';
  
  try {
    // Get current quota info
    console.log('\n1. Getting current quota status...');
    
    const response = await axios.post(`${BASE_URL}/api/on-demand/submitOnDemandRun`, {
      message: 'Quota reset test',
      parameters: { test: true },
      episodes: [{
        guid: 'reset-test-guid',
        feedGuid: 'reset-test-feed-guid',
        feedId: 'reset-test-feed-id'
      }]
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log('✅ Current quota status:');
    console.log(`   Remaining Runs: ${response.data.quotaInfo.remainingRuns}`);
    console.log(`   Used This Period: ${response.data.quotaInfo.usedThisPeriod}`);
    console.log(`   Total Limit: ${response.data.quotaInfo.totalLimit}`);
    
    console.log('\n📝 Note: To test quota reset, you would need to:');
    console.log('   1. Wait for the quota period to expire (default: 30 days)');
    console.log('   2. Or manually reset the quota in the database');
    console.log('   3. Then run this test again to see the quota reset');
    
  } catch (error) {
    console.error('❌ Quota reset test failed:', error.response?.data || error.message);
  }
}

// Run tests
if (require.main === module) {
  testQuotaLimits()
    .then(() => testQuotaReset())
    .then(() => {
      console.log('\n🎉 All quota tests completed!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 Quota tests failed:', error);
      process.exit(1);
    });
}

module.exports = {
  testQuotaLimits,
  testQuotaReset
}; 