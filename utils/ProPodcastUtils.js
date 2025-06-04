const { ProPodcastDetails } = require('../models/ProPodcastDetails');

/**
 * Retrieves a podcast by its feedId from the database.
 * @param {string} feedId - The unique ID of the podcast feed.
 * @returns {Promise<Object|null>} - Returns the podcast details or null if not found.
 */
async function getProPodcastByFeedId(feedId) {
  try {
    const podcast = await ProPodcastDetails.findOne({ feedId }).lean();
    return podcast || null;
  } catch (error) {
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
