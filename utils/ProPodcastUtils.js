const { ProPodcastDetails } = require('../models/ProPodcastDetails');

/**
 * Retrieves a podcast by its feedId from the database.
 * @param {string} feedId - The unique ID of the podcast feed.
 * @returns {Promise<Object|null>} - Returns the podcast details or null if not found.
 */
async function getProPodcastByFeedId(feedId) {
  const { printLog } = require('../constants');
  const dbQueryStartTime = Date.now();
  
  printLog(`🔍 [TIMING] Starting database query for feedId: ${feedId}`);
  
  try {
    const podcast = await ProPodcastDetails.findOne({ feedId }).lean();
    
    const dbQueryEndTime = Date.now();
    const queryTime = dbQueryEndTime - dbQueryStartTime;
    
    if (podcast) {
      printLog(`✅ [TIMING] Database query successful in ${queryTime}ms - Found: ${podcast.title}`);
    } else {
      printLog(`❌ [TIMING] Database query completed in ${queryTime}ms - No podcast found`);
    }
    
    return podcast || null;
  } catch (error) {
    const dbErrorTime = Date.now() - dbQueryStartTime;
    printLog(`❌ [TIMING] Database query failed after ${dbErrorTime}ms: ${error.message}`);
    console.error(`Error fetching podcast with feedId ${feedId}:`, error);
    throw new Error('Database query failed');
  }
}

async function getProPodcastByAdminEmail(adminEmail) {
  try {
    const podcast = await ProPodcastDetails.findOne({ adminEmail }).lean();
    return podcast || null;
  } catch (error) {
    console.error(`Error fetching podcast with adminEmail ${adminEmail}:`, error);
    throw new Error('Database query failed');
  }
}

/**
 * Updates Twitter tokens for a podcast
 * @param {string} adminEmail - The admin email of the podcast
 * @param {Object} tokens - The Twitter tokens to store
 * @returns {Promise<Object>} - Returns the updated podcast details
 */
async function updateTwitterTokens(adminEmail, tokens) {
  try {
    const podcast = await ProPodcastDetails.findOneAndUpdate(
      { adminEmail },
      { 
        twitterTokens: {
          ...tokens,
          lastUpdated: new Date()
        }
      },
      { new: true }
    ).lean();
    
    if (!podcast) {
      throw new Error('Podcast not found');
    }
    
    return podcast;
  } catch (error) {
    console.error(`Error updating Twitter tokens for ${adminEmail}:`, error);
    throw new Error('Failed to update Twitter tokens');
  }
}

/**
 * Gets Twitter tokens for a podcast
 * @param {string} adminEmail - The admin email of the podcast
 * @returns {Promise<Object|null>} - Returns the Twitter tokens or null if not found
 */
async function getTwitterTokens(adminEmail) {
  try {
    const podcast = await ProPodcastDetails.findOne({ adminEmail })
      .select('twitterTokens')
      .lean();
    
    return podcast?.twitterTokens || null;
  } catch (error) {
    console.error(`Error fetching Twitter tokens for ${adminEmail}:`, error);
    throw new Error('Failed to fetch Twitter tokens');
  }
}

module.exports = {
  getProPodcastByFeedId,
  getProPodcastByAdminEmail,
  updateTwitterTokens,
  getTwitterTokens
};
