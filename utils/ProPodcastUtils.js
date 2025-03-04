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

module.exports = {
  getProPodcastByFeedId
};
