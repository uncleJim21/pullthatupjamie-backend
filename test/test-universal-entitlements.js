const axios = require('axios');

const BASE_URL = 'http://localhost:4111/api/on-demand';

// Test data
const testEpisodes = [
    {
        guid: 'test-episode-1',
        feedGuid: 'test-feed-1',
        feedId: 'feed-1'
    },
    {
        guid: 'test-episode-2',
        feedGuid: 'test-feed-1',
        feedId: 'feed-1'
    }
];

const testMessage = 'Test on-demand run for universal entitlements';
const testParameters = { test: true };

async function testEligibilityCheck() {
    console.log('\n=== Testing Eligibility Check ===');
    
    try {
        const response = await axios.get(`${BASE_URL}/checkEligibility`);
        console.log('✅ Eligibility check successful');
        console.log('Response:', JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (error) {
        console.error('❌ Eligibility check failed:', error.response?.data || error.message);
        return null;
    }
}

async function testOnDemandSubmission() {
    console.log('\n=== Testing On-Demand Submission ===');
    
    try {
        const payload = {
            message: testMessage,
            parameters: testParameters,
            episodes: testEpisodes
        };
        
        const response = await axios.post(`${BASE_URL}/submitOnDemandRun`, payload);
        console.log('✅ On-demand submission successful');
        console.log('Job ID:', response.data.jobId);
        console.log('Entitlement Info:', JSON.stringify(response.data.entitlementInfo, null, 2));
        return response.data;
    } catch (error) {
        console.error('❌ On-demand submission failed:', error.response?.data || error.message);
        return null;
    }
}

async function testMultipleSubmissions() {
    console.log('\n=== Testing Multiple Submissions (to test entitlement consumption) ===');
    
    for (let i = 1; i <= 3; i++) {
        console.log(`\n--- Submission ${i} ---`);
        
        // Check eligibility first
        const eligibility = await testEligibilityCheck();
        if (!eligibility) {
            console.log('❌ Skipping submission due to eligibility check failure');
            continue;
        }
        
        // Submit on-demand run
        const result = await testOnDemandSubmission();
        if (!result) {
            console.log('❌ Skipping further submissions due to submission failure');
            break;
        }
        
        // Wait a bit between submissions
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function testJWTSubmission() {
    console.log('\n=== Testing JWT-based Submission ===');
    
    // This would require a valid JWT token
    // For now, we'll just test the IP-based flow
    console.log('Note: JWT testing requires a valid token. Testing IP-based flow only.');
    
    const eligibility = await testEligibilityCheck();
    if (eligibility) {
        console.log('✅ IP-based eligibility working correctly');
    }
}

async function runAllTests() {
    console.log('🚀 Starting Universal Entitlements Tests');
    console.log('==========================================');
    
    // Test 1: Basic eligibility check
    await testEligibilityCheck();
    
    // Test 2: Single on-demand submission
    await testOnDemandSubmission();
    
    // Test 3: Multiple submissions to test entitlement consumption
    await testMultipleSubmissions();
    
    // Test 4: JWT-based submission (placeholder)
    await testJWTSubmission();
    
    console.log('\n🎉 All tests completed!');
    console.log('\nNote: Check the server logs for any entitlement-related messages.');
}

// Run the tests
runAllTests().catch(console.error); 