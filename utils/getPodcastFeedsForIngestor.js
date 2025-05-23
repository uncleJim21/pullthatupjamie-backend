const mongoose = require('mongoose');
const ScheduledPodcastFeed = require('../models/ScheduledPodcastFeed');

/**
 * Gets podcast feeds from the database for use with the ingestor
 * @param {boolean} enabledOnly - Whether to only return enabled feeds
 * @returns {Promise<Array>} - Array of feed objects with feedUrl and feedId
 */
async function getPodcastFeedsForIngestor(enabledOnly = true) {
  try {
    // Build query based on whether we want only enabled feeds
    const query = enabledOnly ? { isEnabled: true } : {};
    
    // Fetch feeds from the database
    const feeds = await ScheduledPodcastFeed.find(query);
    
    console.log(`[PodcastFeeds] Found ${feeds.length} ${enabledOnly ? 'enabled ' : ''}podcast feeds in database`);
    
    // Format the feeds for the ingestor (include only necessary fields)
    const formattedFeeds = feeds.map(feed => ({
      feedUrl: feed.feedUrl,
      feedId: feed.feedId
    }));
    
    return formattedFeeds;
  } catch (error) {
    console.error('[PodcastFeeds] Error fetching podcast feeds:', error.message);
    throw error;
  }
}

/**
 * Updates the lastProcessed timestamp for a feed
 * @param {number} feedId - The ID of the feed to update
 * @returns {Promise<Object>} - The updated feed
 */
async function updateFeedProcessedTime(feedId) {
  try {
    const feed = await ScheduledPodcastFeed.findOneAndUpdate(
      { feedId },
      { lastProcessed: new Date() },
      { new: true }
    );
    
    if (!feed) {
      console.warn(`[PodcastFeeds] Warning: Feed with ID ${feedId} not found when updating lastProcessed`);
    }
    
    return feed;
  } catch (error) {
    console.error(`[PodcastFeeds] Error updating lastProcessed for feed ${feedId}:`, error.message);
    throw error;
  }
}

module.exports = {
  getPodcastFeedsForIngestor,
  updateFeedProcessedTime
}; 