const axios = require('axios');
require('dotenv').config();
const { getPodcastFeedsForIngestor, updateFeedProcessedTime } = require('./getPodcastFeedsForIngestor');
const ingestorSemaphore = require('./ingestorSemaphore');

/**
 * Calls the Jamie Ingestor API to process podcast feeds
 * @param {string} jobId - Unique identifier for this ingestion job
 * @param {Array} feeds - Optional array of feed objects with feedUrl and feedId
 * @returns {Promise<Object>} - Response from the ingestor API
 */
async function callIngestor(jobId = `job-${Date.now()}`, feeds = null, { force = false } = {}) {
  const apiKey = process.env.SCHEDULED_INGESTOR_API_KEY;
  if (!apiKey) {
    throw new Error('INGESTOR_API_KEY is missing from environment variables');
  }
  // One trigger per window, enforced in Mongo so it holds across containers
  // (see utils/ingestorSemaphore.js). `force` is for deliberate manual re-runs.
  if (!force) {
    const lock = await ingestorSemaphore.acquire({ jobId });
    if (!lock.acquired) {
      const iso = d => (d && d.toISOString ? d.toISOString() : d);
      console.warn(`[Ingestor] SKIPPED job ${jobId} — a trigger already ran within the last ${ingestorSemaphore.WINDOW_MINUTES} min (job ${lock.jobId} on ${lock.heldBy} at ${iso(lock.since)}, window ends ${iso(lock.until)})`);
      return { success: false, skipped: true, reason: 'ingestor-trigger-window', jobId, lock };
    }
  }
  let submitted = false;
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
    submitted = true;
    
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
    if (!force && !submitted) {
      // The ingestor never received the job: free the window for the next trigger.
      try { await ingestorSemaphore.release(); } catch (_) { /* best effort */ }
    }
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