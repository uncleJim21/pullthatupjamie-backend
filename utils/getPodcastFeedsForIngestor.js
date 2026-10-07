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
    
    // Dead-feed guard: an enabled feed that has been on the schedule for a
    // while yet has zero episodes in the corpus is one the ingestor cannot
    // transcribe (observed: two feeds re-submitted twice a day for months,
    // re-queued into the pro analyzer every pass, never producing anything).
    // Skip those with a warning instead of resubmitting them forever.
    const graceDays = parseInt(process.env.INGEST_DEAD_FEED_GRACE_DAYS || '7', 10);
    const cutoff = new Date(Date.now() - graceDays * 86400 * 1000);
    const JamieVectorMetadata = require('../models/JamieVectorMetadata');
    const live = [];
    for (const feed of feeds) {
      const createdAt = feed.createdAt ? new Date(feed.createdAt) : null;
      const oldEnough = !createdAt || createdAt < cutoff;
      if (enabledOnly && oldEnough) {
        const episodes = await JamieVectorMetadata.countDocuments({ type: 'episode', feedId: { $in: [String(feed.feedId), Number(feed.feedId)] } });
        if (episodes === 0) {
          console.warn(`[PodcastFeeds] SKIPPING feed ${feed.feedId} (${feed.feedUrl}): enabled since ${createdAt ? createdAt.toISOString().slice(0, 10) : 'unknown'} but 0 episodes in the corpus — disable it or fix ingestion (INGEST_DEAD_FEED_GRACE_DAYS=${graceDays})`);
          continue;
        }
      }
      live.push(feed);
    }

    // Format the feeds for the ingestor (include only necessary fields)
    const formattedFeeds = live.map(feed => ({
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