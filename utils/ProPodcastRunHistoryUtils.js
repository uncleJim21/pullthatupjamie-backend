const ProPodcastRunHistory = require('../models/ProPodcastRunHistory');

/**
 * Get the last N runs for a specific feed ID
 * 
 * @param {string} feedId - The podcast feed ID to query
 * @param {number} limit - Maximum number of runs to return (default: 10)
 * @returns {Promise<Array>} Array of run history documents
 */
async function getLastNRuns(feedId, limit = 10) {
    try {
        const runs = await ProPodcastRunHistory
            .find({ feed_id: feedId })
            .sort({ run_date: -1 })
            .limit(limit)
            .lean()
            .exec();

        return runs;
    } catch (error) {
        console.error('Error fetching run history:', error);
        throw error;
    }
}

/**
 * Get a specific run by its MongoDB ObjectId
 * 
 * @param {string} runId - The MongoDB ObjectId of the run
 * @returns {Promise<Object|null>} The run document or null if not found
 */
async function getRunById(runId) {
    try {
        const run = await ProPodcastRunHistory
            .findById(runId)
            .lean()
            .exec();

        return run;
    } catch (error) {
        console.error('Error fetching run by ID:', error);
        throw error;
    }
}

/**
 * Get the most recent run for a specific feed ID
 * 
 * @param {string} feedId - The podcast feed ID to query
 * @returns {Promise<Object|null>} The most recent run document or null if none exists
 */
async function getMostRecentRun(feedId) {
    try {
        const run = await ProPodcastRunHistory
            .findOne({ feed_id: feedId })
            .sort({ run_date: -1 })
            .lean()
            .exec();

        return run;
    } catch (error) {
        console.error('Error fetching most recent run:', error);
        throw error;
    }
}

/**
 * Get runs within a specific date range for a feed
 * 
 * @param {string} feedId - The podcast feed ID to query
 * @param {Date} startDate - Start date of the range
 * @param {Date} endDate - End date of the range
 * @returns {Promise<Array>} Array of run history documents
 */
async function getRunsByDateRange(feedId, startDate, endDate) {
    try {
        const runs = await ProPodcastRunHistory
            .find({
                feed_id: feedId,
                run_date: {
                    $gte: startDate,
                    $lte: endDate
                }
            })
            .sort({ run_date: -1 })
            .lean()
            .exec();

        return runs;
    } catch (error) {
        console.error('Error fetching runs by date range:', error);
        throw error;
    }
}

module.exports = {
    getLastNRuns,
    getRunById,
    getMostRecentRun,
    getRunsByDateRange
}; 