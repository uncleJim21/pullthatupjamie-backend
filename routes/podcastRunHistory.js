const express = require('express');
const router = express.Router();
const { verifyPodcastAdmin } = require('../utils/podcastAdminAuth');
const { 
    getLastNRuns, 
    getRunById, 
    getMostRecentRun 
} = require('../utils/ProPodcastRunHistoryUtils');
const { WorkProductV2, calculateLookupHash } = require('../models/WorkProductV2');
const { getClipById } = require('../agent-tools/pineconeTools.js');

/**
 * Helper function to check if a clip recommendation is shareable
 * Uses the EXACT same logic as /api/make-clip to avoid inconsistencies
 * @param {Object} recommendation - The recommendation object from the run
 * @returns {Promise<Object>} Object with shareable flag and optional details
 */
async function checkClipShareability(recommendation) {
    try {
        // Use the first paragraph_id as the clipId (same as user would click)
        const clipId = recommendation.paragraph_ids?.[0];
        if (!clipId) {
            return {
                shareable: false,
                reason: 'invalid_data',
                error: 'No paragraph_ids found'
            };
        }

        // Use the EXACT same function that /api/make-clip uses
        const clipData = await getClipById(clipId);
        if (!clipData) {
            return {
                shareable: false,
                reason: 'clip_not_found',
                clipId
            };
        }

        // Use the EXACT same timestamps approach as /api/make-clip
        const timestamps = [recommendation.start_time, recommendation.end_time];
        
        // Use the EXACT same hash calculation as /api/make-clip
        const lookupHash = calculateLookupHash(clipData, timestamps);
        
        // Check if this clip exists in WorkProductV2 (same as /api/make-clip)
        const existingClip = await WorkProductV2.findOne({ lookupHash }).lean();
        
        if (!existingClip) {
            return {
                shareable: false,
                reason: 'not_created',
                lookupHash,
                clipId
            };
        }
        
        // Same completion check as /api/make-clip
        if (existingClip.cdnFileId) {
            return {
                shareable: true,
                reason: 'ready',
                lookupHash,
                clipId,
                cdnUrl: existingClip.cdnFileId
            };
        }
        
        // Same processing check as /api/make-clip  
        if (existingClip.status === 'failed') {
            return {
                shareable: false,
                reason: 'failed',
                lookupHash,
                clipId,
                cdnUrl: null
            };
        }
        
        // Still processing
        return {
            shareable: false,
            reason: 'processing',
            lookupHash,
            clipId,
            cdnUrl: null
        };
        
    } catch (error) {
        console.error('Error checking clip shareability:', error);
        return {
            shareable: false,
            reason: 'error',
            error: error.message
        };
    }
}

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
 * Get a specific run by ID with shareable flags for each recommendation
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

        // Add shareable flags to each recommendation
        const enhancedRun = { ...run };
        
        if (run.recommendations && Array.isArray(run.recommendations)) {
            console.log(`[INFO] Checking shareability for ${run.recommendations.length} recommendations in run ${runId}`);
            
            // Check shareability for all recommendations in parallel
            const shareabilityPromises = run.recommendations.map(async (recommendation, index) => {
                try {
                    const shareabilityInfo = await checkClipShareability(recommendation);
                    return {
                        index,
                        shareabilityInfo
                    };
                } catch (error) {
                    console.error(`Error checking shareability for recommendation ${index}:`, error);
                    return {
                        index,
                        shareabilityInfo: {
                            shareable: false,
                            reason: 'error',
                            error: error.message
                        }
                    };
                }
            });
            
            const shareabilityResults = await Promise.all(shareabilityPromises);
            
            // Enhance each recommendation with shareable information
            enhancedRun.recommendations = run.recommendations.map((recommendation, index) => {
                const result = shareabilityResults.find(r => r.index === index);
                const shareabilityInfo = result ? result.shareabilityInfo : {
                    shareable: false,
                    reason: 'unknown'
                };
                
                return {
                    ...recommendation,
                    // Add shareable flag and related information
                    shareable: shareabilityInfo.shareable,
                    shareableReason: shareabilityInfo.reason,
                    lookupHash: shareabilityInfo.lookupHash,
                    clipId: shareabilityInfo.clipId,
                    cdnUrl: shareabilityInfo.cdnUrl || null
                };
            });
            
            // Add summary statistics
            const shareableCount = enhancedRun.recommendations.filter(r => r.shareable).length;
            const processingCount = enhancedRun.recommendations.filter(r => r.shareableReason === 'processing').length;
            const failedCount = enhancedRun.recommendations.filter(r => r.shareableReason === 'failed').length;
            const notCreatedCount = enhancedRun.recommendations.filter(r => r.shareableReason === 'not_created').length;
            
            enhancedRun.shareabilityStats = {
                total: run.recommendations.length,
                shareable: shareableCount,
                processing: processingCount,
                failed: failedCount,
                not_created: notCreatedCount
            };
            
            console.log(`[INFO] Shareability stats for run ${runId}:`, enhancedRun.shareabilityStats);
        } else {
            enhancedRun.shareabilityStats = {
                total: 0,
                shareable: 0,
                processing: 0,
                failed: 0,
                not_created: 0
            };
        }

        res.json({
            success: true,
            data: enhancedRun
        });
    } catch (error) {
        console.error('Error fetching run with shareability info:', error);
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