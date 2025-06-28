const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { WorkProductV2 } = require('../models/WorkProductV2');
const axios = require('axios');
const { checkOnDemandPermissions, consumeOnDemandQuota, checkOnDemandEligibility } = require('../utils/userPermissions');

/**
 * POST /api/on-demand/submitOnDemandRun
 * Submit an on-demand run request
 */
router.post('/submitOnDemandRun', checkOnDemandPermissions, async (req, res) => {
    try {
        const { message, parameters, episodes } = req.body;

        // Validate request body
        if (!message || typeof message !== 'string') {
            return res.status(400).json({
                error: 'Invalid message',
                details: 'Message must be a string'
            });
        }

        if (!parameters || typeof parameters !== 'object') {
            return res.status(400).json({
                error: 'Invalid parameters',
                details: 'Parameters must be an object'
            });
        }

        // Validate episodes array
        if (!episodes || !Array.isArray(episodes) || episodes.length === 0) {
            return res.status(400).json({
                error: 'Invalid episodes',
                details: 'Episodes must be a non-empty array'
            });
        }

        // Validate each episode has required fields
        for (const episode of episodes) {
            if (!episode.guid || !episode.feedGuid || !episode.feedId) {
                return res.status(400).json({
                    error: 'Invalid episode data',
                    details: 'Each episode must have guid, feedGuid, and feedId'
                });
            }
        }

        // Consume user quota first (this will increment their usage)
        const quotaResult = await consumeOnDemandQuota(req.userEmail);
        if (!quotaResult.success) {
            return res.status(403).json({
                error: 'Failed to consume quota',
                details: quotaResult.error,
                remainingRuns: quotaResult.remainingRuns,
                nextResetDate: quotaResult.nextResetDate
            });
        }

        // Generate a random lookupHash using crypto
        const lookupHash = crypto.randomBytes(12).toString('hex');

        // Create result structure
        const result = {
            jobStatus: 'pending',
            totalFeeds: 0, // Will be calculated later
            totalEpisodes: episodes.length,
            episodesProcessed: 0,
            episodesSkipped: 0,
            episodesFailed: 0,
            episodes: episodes.map(ep => ({
                ...ep,
                status: 'pending'
            })),
            startedAt: new Date().toISOString(),
            completedAt: null,
            userEmail: req.userEmail, // Track which user submitted this
            quotaConsumed: true
        };

        // Calculate unique feeds count
        const uniqueFeedIds = new Set(episodes.map(ep => ep.feedId));
        result.totalFeeds = uniqueFeedIds.size;

        // Create a new WorkProductV2 document
        await WorkProductV2.create({
            type: 'on-demand-jamie-episodes',
            lookupHash,
            result
        });

        // Prepare the AWS API payload
        const feedGuids = {};
        episodes.forEach(episode => {
            if (!feedGuids[episode.feedGuid]) {
                feedGuids[episode.feedGuid] = {
                    feedId: episode.feedId,
                    episodes: []
                };
            }
            feedGuids[episode.feedGuid].episodes.push(episode.guid);
        });

        const awsPayload = {
            jobId: lookupHash,
            jobConfig: {
                onDemand: true,
                feedGuids,
                workProductV2LookupHash: lookupHash,
                overrideExistence: true
            }
        };

        console.log('awsPayload:', JSON.stringify(awsPayload, null, 2));

        // Call the AWS API
        try {
            const awsResponse = await axios.post(
                process.env.AWS_INGESTOR_PARALLEL_URL,
                awsPayload,
                {
                    headers: {
                        'x-api-key': process.env.AWS_INGESTOR_PARALLEL_API_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            // Return success response with the lookupHash and AWS response
            return res.json({
                success: true,
                jobId: lookupHash,
                totalEpisodes: episodes.length,
                totalFeeds: result.totalFeeds,
                message: 'On-demand run submitted successfully',
                quotaInfo: {
                    remainingRuns: quotaResult.remainingRuns,
                    usedThisPeriod: quotaResult.usedThisPeriod,
                    totalLimit: quotaResult.totalLimit
                },
                awsResponse: awsResponse.data
            });
        } catch (awsError) {
            console.error('=== AWS API ERROR DETAILS ===');
            console.error('Error Message:', awsError.message);
            console.error('Error Code:', awsError.code);
            console.error('Error Stack:', awsError.stack);
            
            if (awsError.response) {
                console.error('Response Status:', awsError.response.status);
                console.error('Response Status Text:', awsError.response.statusText);
                console.error('Response Headers:', JSON.stringify(awsError.response.headers, null, 2));
                console.error('Response Data:', JSON.stringify(awsError.response.data, null, 2));
            }
            
            if (awsError.request) {
                console.error('Request Method:', awsError.request.method);
                console.error('Request URL:', awsError.request.url);
                console.error('Request Headers:', JSON.stringify(awsError.request.headers, null, 2));
            }
            
            console.error('Full Error Object:', JSON.stringify(awsError, null, 2));
            console.error('=== END AWS API ERROR DETAILS ===');
            
            // Update WorkProductV2 with error status
            await WorkProductV2.findOneAndUpdate(
                { lookupHash },
                { 
                    'result.jobStatus': 'failed',
                    'result.error': awsError.response?.data?.message || awsError.message
                }
            );

            // Note: We don't refund the quota here since the submission was attempted
            // You might want to implement quota refunding for AWS failures if desired

            return res.status(awsError.response?.status || 500).json({
                error: 'Failed to submit job to AWS',
                details: awsError.response?.data || awsError.message,
                quotaNote: 'Your quota has been consumed despite the AWS error. Contact support if needed.'
            });
        }
    } catch (error) {
        console.error('Error submitting on-demand run:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

/**
 * GET /api/on-demand/getOnDemandJobStatus/:jobId
 * Get status of an on-demand job
 */
router.get('/getOnDemandJobStatus/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;

        // Validate job ID
        if (!jobId) {
            return res.status(400).json({
                error: 'Missing job ID',
                details: 'Please provide a job ID'
            });
        }

        // Look up the job in WorkProductV2
        const job = await WorkProductV2.findOne({ lookupHash: jobId });

        if (!job) {
            return res.status(404).json({
                error: 'Job not found',
                details: `No job found with ID ${jobId}`
            });
        }

        // Return the job status
        res.json({
            success: true,
            jobId: jobId,
            status: job.result.jobStatus,
            stats: {
                totalEpisodes: job.result.totalEpisodes,
                totalFeeds: job.result.totalFeeds,
                episodesProcessed: job.result.episodesProcessed,
                episodesSkipped: job.result.episodesSkipped,
                episodesFailed: job.result.episodesFailed
            },
            episodes: job.result.episodes,
            startedAt: job.result.startedAt,
            completedAt: job.result.completedAt,
            userEmail: job.result.userEmail || null // Include user email if available
        });
    } catch (error) {
        console.error('Error getting job status:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

module.exports = router; 