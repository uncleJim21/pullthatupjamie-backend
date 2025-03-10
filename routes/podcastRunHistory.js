const express = require('express');
const router = express.Router();
const { verifyPodcastAdmin } = require('../utils/podcastAdminAuth');
const { 
    getLastNRuns, 
    getRunById, 
    getMostRecentRun 
} = require('../utils/ProPodcastRunHistoryUtils');

/**
 * GET /api/podcast-runs/:feedId/recent
 * Get the last N runs for a podcast feed
 * Requires admin authentication
 */
router.get('/:feedId/recent', verifyPodcastAdmin, async (req, res) => {
    try {
        const { feedId } = req.params;
        const limit = parseInt(req.query.limit) || 10;

        const runs = await getLastNRuns(feedId, limit);
        res.json({
            success: true,
            data: runs
        });
    } catch (error) {
        console.error('Error fetching recent runs:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: 'Error fetching run history'
        });
    }
});

/**
 * GET /api/podcast-runs/:feedId/run/:runId
 * Get a specific run by ID
 * Requires admin authentication
 */
router.get('/:feedId/run/:runId', verifyPodcastAdmin, async (req, res) => {
    try {
        const { runId } = req.params;
        
        const run = await getRunById(runId);
        if (!run) {
            return res.status(404).json({
                error: 'Not found',
                details: 'Run not found'
            });
        }

        // Double check that this run belongs to the authenticated feed
        if (run.feed_id !== req.admin.feedId) {
            return res.status(403).json({
                error: 'Unauthorized',
                details: 'This run does not belong to the authenticated podcast'
            });
        }

        res.json({
            success: true,
            data: run
        });
    } catch (error) {
        console.error('Error fetching run:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: 'Error fetching run data'
        });
    }
});

/**
 * GET /api/podcast-runs/:feedId/latest
 * Get the most recent run for a podcast feed
 * Requires admin authentication
 */
router.get('/:feedId/latest', verifyPodcastAdmin, async (req, res) => {
    try {
        const { feedId } = req.params;
        
        const run = await getMostRecentRun(feedId);
        if (!run) {
            return res.status(404).json({
                error: 'Not found',
                details: 'No runs found for this podcast'
            });
        }

        res.json({
            success: true,
            data: run
        });
    } catch (error) {
        console.error('Error fetching latest run:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: 'Error fetching latest run data'
        });
    }
});

module.exports = router; 