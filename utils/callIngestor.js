const axios = require('axios');
require('dotenv').config();
const { getPodcastFeedsForIngestor, updateFeedProcessedTime } = require('./getPodcastFeedsForIngestor');

/**
 * Calls the Jamie Ingestor API to process podcast feeds
 * @param {string} jobId - Unique identifier for this ingestion job
 * @param {Array} feeds - Optional array of feed objects with feedUrl and feedId
 * @returns {Promise<Object>} - Response from the ingestor API
 */
async function callIngestor(jobId = `job-${Date.now()}`, feeds = null) {
  const apiKey = process.env.SCHEDULED_INGESTOR_API_KEY;
  
  if (!apiKey) {
    throw new Error('INGESTOR_API_KEY is missing from environment variables');
  }

  try {
    // Use the provided feeds or fetch from database if none provided
    let feedsToProcess = feeds;
    
    if (!feedsToProcess) {
      feedsToProcess = await getPodcastFeedsForIngestor(true);
      console.log(`[Ingestor] Fetched ${feedsToProcess.length} enabled feeds from database`);
      
      if (!feedsToProcess || feedsToProcess.length === 0) {
        throw new Error('No enabled podcast feeds found in the database');
      }
    }

    console.log(`[Ingestor] Starting ingestion job ${jobId} with ${feedsToProcess.length} feeds`);
    
    const response = await axios({
      method: 'POST',
      url: `${process.env.SCHEDULED_INGESTOR_API_URL}`,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      data: {
        jobId,
        jobConfig: {
          feeds: feedsToProcess
        }
      },
      timeout: 30000 // 30 second timeout
    });

    console.log(`[Ingestor] Job ${jobId} submitted successfully`);
    
    // Update lastProcessed timestamp for each feed
    for (const feed of feedsToProcess) {
      try {
        await updateFeedProcessedTime(feed.feedId);
      } catch (error) {
        console.error(`[Ingestor] Failed to update lastProcessed for feed ${feed.feedId}:`, error.message);
      }
    }
    
    return {
      success: true,
      jobId,
      responseData: response.data,
      feedCount: feedsToProcess.length
    };
  } catch (error) {
    console.error(`[Ingestor] Error calling ingestor API:`, error.message);
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error(`Status: ${error.response.status}`);
      console.error(`Response: ${JSON.stringify(error.response.data)}`);
    }
    
    throw new Error(`Failed to call ingestor API: ${error.message}`);
  }
}

module.exports = callIngestor; 