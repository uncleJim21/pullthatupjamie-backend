const axios = require('axios');
require('dotenv').config();

/**
 * Test script to submit a single feed to the ingestor API
 * Uses feedId 226249 and feedUrl https://feeds.fountain.fm/ZwwaDULvAj0yZvJ5kdB9
 * with overrideExistence set to TRUE
 */
async function testIngestorCall() {
  const apiKey = process.env.SCHEDULED_INGESTOR_API_KEY;
  
  if (!apiKey) {
    throw new Error('SCHEDULED_INGESTOR_API_KEY is missing from environment variables');
  }

  if (!process.env.SCHEDULED_INGESTOR_API_URL) {
    throw new Error('SCHEDULED_INGESTOR_API_URL is missing from environment variables');
  }

  // Test feed data - TFTC: A Bitcoin Podcast
  const testFeed = {
    feedId: 226249,
    feedUrl: 'https://feeds.fountain.fm/ZwwaDULvAj0yZvJ5kdB9',
    alwaysOverride: true
  };

  const jobId = `test-job-${Date.now()}`;

  console.log(`[Test] Starting test ingestion job ${jobId} for feed ${testFeed.feedId}`);
  console.log(`[Test] Feed URL: ${testFeed.feedUrl}`);
  console.log(`[Test] Override Existence: TRUE`);

  try {
    const response = await axios({
      method: 'POST',
      url: process.env.SCHEDULED_INGESTOR_API_URL,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      data: {
        jobId,
        jobConfig: {
          feeds: [testFeed]
        }
      },
      timeout: 30000 // 30 second timeout
    });

    console.log(`[Test] Job ${jobId} submitted successfully!`);
    console.log(`[Test] Response Status: ${response.status}`);
    console.log(`[Test] Response Data:`, JSON.stringify(response.data, null, 2));
    
    return {
      success: true,
      jobId,
      responseData: response.data,
      feedCount: 1
    };

  } catch (error) {
    console.error(`[Test] Error calling ingestor API:`, error.message);
    
    if (error.response) {
      console.error(`[Test] Status: ${error.response.status}`);
      console.error(`[Test] Response Data:`, JSON.stringify(error.response.data, null, 2));
      console.error(`[Test] Response Headers:`, JSON.stringify(error.response.headers, null, 2));
    }
    
    if (error.request) {
      console.error(`[Test] Request was made but no response received`);
      console.error(`[Test] Request URL:`, error.request.url);
      console.error(`[Test] Request Method:`, error.request.method);
    }
    
    throw new Error(`Failed to call ingestor API: ${error.message}`);
  }
}

// Run the test if this file is executed directly
if (require.main === module) {
  testIngestorCall()
    .then(result => {
      console.log('\n=== TEST COMPLETED SUCCESSFULLY ===');
      console.log('Result:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('\n=== TEST FAILED ===');
      console.error('Error:', error.message);
      process.exit(1);
    });
}

module.exports = testIngestorCall;