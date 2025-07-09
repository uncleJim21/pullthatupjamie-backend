const axios = require('axios');

// Quick test for IP-based on-demand runs
async function quickTest() {
  console.log('🚀 Quick IP-based on-demand test...');
  
  const BASE_URL = 'http://localhost:4111';
  
  try {
    // Test IP-based on-demand run
    console.log('\n1. Testing IP-based on-demand run...');
    
    const response = await axios.post(`${BASE_URL}/api/on-demand/submitOnDemandRun`, {
      message: 'Quick IP test',
      parameters: { test: true },
      episodes: [{
        guid: 'test-guid-1',
        feedGuid: 'test-feed-guid-1',
        feedId: 'test-feed-id-1'
      }]
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log('✅ SUCCESS!');
    console.log('   Job ID:', response.data.jobId);
    console.log('   Auth Type:', response.data.authType);
    console.log('   Remaining Runs:', response.data.quotaInfo.remainingRuns);
    
    // Test job status
    console.log('\n2. Testing job status...');
    const statusResponse = await axios.get(`${BASE_URL}/api/on-demand/getOnDemandJobStatus/${response.data.jobId}`);
    
    console.log('✅ Job status retrieved!');
    console.log('   Status:', statusResponse.data.status);
    console.log('   Auth Type:', statusResponse.data.authType);
    console.log('   Client IP:', statusResponse.data.clientIp);
    
    console.log('\n🎉 Quick test completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    console.error('   Status:', error.response?.status);
  }
}

// Run the test
if (require.main === module) {
  quickTest();
}

module.exports = { quickTest }; 