const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { WorkProductV2 } = require('../models/WorkProductV2');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const axios = require('axios');
const { checkEntitlementEligibility, consumeEntitlement } = require('../utils/entitlements');
const jwt = require('jsonwebtoken');
const { User } = require('../models/shared/UserSchema');
const { Entitlement } = require('../models/Entitlement');
const { resolveIdentity } = require('../utils/identityResolver');
const { getQuotaConfig, TIERS, createEntitlementMiddleware } = require('../utils/entitlementMiddleware');
const { ENTITLEMENT_TYPES, ALL_ENTITLEMENT_TYPES } = require('../constants/entitlementTypes');
const { serviceHmac } = require('../middleware/hmac');

/**
 * GET /api/on-demand/checkEligibility
 * Check eligibility for ALL entitlement types (uses new identity resolver)
 * 
 * Returns quotas for: search-quotes, search-quotes-3d, make-clip, jamie-assist, ai-analyze, submit-on-demand-run
 */
router.get('/checkEligibility', async (req, res) => {
    try {
        // Use new identity resolver
        const identity = await resolveIdentity(req);
        const { tier, identifier, identifierType, email, user } = identity;
        
        // Fetch all existing entitlements for this user in one query
        const existingEntitlements = await Entitlement.find({
            identifier,
            identifierType
        }).lean();
        
        // Create a map for quick lookup
        const entitlementMap = new Map(
            existingEntitlements.map(e => [e.entitlementType, e])
        );
        
        // Build eligibility for each type
        const entitlements = {};
        
        for (const entitlementType of ALL_ENTITLEMENT_TYPES) {
            const config = getQuotaConfig(entitlementType, tier);
            const existing = entitlementMap.get(entitlementType);
            
            // Check if period expired
            const isExpired = existing ? isPeriodExpired(existing.periodStart, existing.periodLengthDays) : true;
            
            // Calculate values
            let used = 0;
            let max = config.maxUsage;
            let periodStart = new Date();
            let nextResetDate = new Date();
            nextResetDate.setDate(nextResetDate.getDate() + config.periodLengthDays);
            
            if (existing && !isExpired) {
                used = existing.usedCount;
                max = Math.max(existing.maxUsage, config.maxUsage); // Use higher if tier upgraded
                periodStart = existing.periodStart;
                nextResetDate = existing.nextResetDate;
        }

            const isUnlimited = max === -1;
            const remaining = isUnlimited ? Infinity : Math.max(0, max - used);
            const eligible = isUnlimited || remaining > 0;
            
            entitlements[entitlementType] = {
                eligible,
                used,
                max: isUnlimited ? 'unlimited' : max,
                remaining: isUnlimited ? 'unlimited' : remaining,
                isUnlimited,
                periodLengthDays: config.periodLengthDays,
                periodStart,
                nextResetDate,
                daysUntilReset: Math.max(0, Math.ceil((nextResetDate - new Date()) / (1000 * 60 * 60 * 24)))
            };
        }
        
        return res.json({
            success: true,
            tier,
            identifier: email || identifier, // Show email if available, else identifier
            identifierType,
            hasUser: !!user,
            entitlements
        });

    } catch (error) {
        console.error('Error checking eligibility:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

/**
 * Helper: Check if period has expired
 */
function isPeriodExpired(periodStart, periodLengthDays) {
    if (!periodStart) return true;
    
    const now = new Date();
    const periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + periodLengthDays);
    
    return now >= periodEnd;
}

/**
 * POST /api/on-demand/submitOnDemandRun
 * Submit an on-demand run request
 * 
 * Uses new entitlement middleware for authentication and quota management
 */
router.post('/submitOnDemandRun', serviceHmac({ optional: true }), createEntitlementMiddleware(ENTITLEMENT_TYPES.SUBMIT_ON_DEMAND_RUN), async (req, res) => {
    // #swagger.tags = ['On-Demand Transcription']
    // #swagger.summary = 'Submit a podcast episode for transcription, chaptering, and semantic indexing'
    // #swagger.description = 'Submits a podcast episode for full transcription, timestamped chaptering, keyword extraction, and permanent semantic indexing. Returns a pollable job status URL. Once indexed, content is searchable via /api/search-quotes. L402 prepaid access limited to 1 episode per request. Use /api/discover-podcasts to find episode GUIDs.\n\nA metered free tier is available: send the header `X-Free-Tier: true` to use quota-based access without payment. Anonymous users get 2 transcriptions per week; registered users get 5 per month. Omit the header (or use L402 credentials) for paid access.'
    /* #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: {
        message: 'Transcribe latest episode from Bankless',
        parameters: {},
        episodes: [
          {
            guid: 'dd043afd-d7f8-4a96-97aa-a24a743fc219',
            feedGuid: '3d510171-b9ab-517c-bbf3-1fd5542479ad',
            feedId: '357756'
          }
        ]
      }
    } */
    /* #swagger.responses[200] = {
      description: 'Job submitted successfully',
      schema: {
        success: true,
        jobId: '6b2440adae3f806198eb56c0',
        totalEpisodes: 1,
        totalFeeds: 1,
        message: 'On-demand run submitted successfully',
        nextSteps: {
          pollJobStatus: {
            description: 'Poll until status is "complete". Typical transcription takes 30-120 seconds per episode.',
            method: 'POST',
            url: '/api/on-demand/getOnDemandJobStatus',
            body: { jobId: '6b2440adae3f806198eb56c0' },
            pollIntervalSeconds: 15
          },
          searchTranscripts: {
            description: 'Once job is complete, search the transcribed content with semantic queries',
            method: 'POST',
            url: '/api/search-quotes',
            body: { query: '...', feedIds: ['357756'], smartMode: true }
          }
        }
      }
    } */
    /* #swagger.responses[400] = {
      description: 'Validation error or L402 batch limit exceeded',
      schema: { $ref: '#/components/schemas/Error' }
    } */
    /* #swagger.responses[402] = {
      description: 'Payment required — returns Lightning invoice'
    } */
    try {
        const { identity, entitlement } = req;

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

        if (identity.identifierType === 'prepaid' && episodes.length > 1) {
            return res.status(400).json({
                error: 'Batch limit exceeded',
                details: 'L402 prepaid access is limited to 1 episode per request. Submit multiple requests for additional episodes.'
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

        // Entitlement already consumed by middleware

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
            userEmail: identity.email || null,
            clientIp: identity.identifierType === 'ip' ? identity.identifier : null,
            authType: identity.identifierType === 'ip' ? 'ip' : 'user',
            entitlementConsumed: true,
            tier: identity.tier,
            quotaUsed: entitlement.used,
            quotaRemaining: entitlement.remaining
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

        console.log('Try Jamie On Demand URL:', process.env.AWS_INGESTOR_PARALLEL_URL)
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

            const feedIds = [...new Set(episodes.map(ep => ep.feedId))];

            return res.json({
                success: true,
                jobId: lookupHash,
                totalEpisodes: episodes.length,
                totalFeeds: result.totalFeeds,
                message: 'On-demand run submitted successfully',
                entitlementInfo: {
                    remainingRuns: entitlement.remainingUsage,
                    usedThisPeriod: entitlement.usedCount,
                    totalLimit: entitlement.maxUsage
                },
                nextSteps: {
                    pollJobStatus: {
                        description: 'Poll until status is "complete". Typical transcription takes 30-120 seconds per episode.',
                        method: 'POST',
                        url: '/api/on-demand/getOnDemandJobStatus',
                        body: { jobId: lookupHash },
                        pollIntervalSeconds: 15
                    },
                    searchTranscripts: {
                        description: 'Once job is complete, search the transcribed content with semantic queries',
                        method: 'POST',
                        url: '/api/search-quotes',
                        body: {
                            query: '...',
                            feedIds,
                            smartMode: true
                        }
                    }
                }
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

            // Note: We don't refund the entitlement here since the submission was attempted
            // You might want to implement entitlement refunding for AWS failures if desired

            return res.status(awsError.response?.status || 500).json({
                error: 'Failed to submit job to AWS',
                details: awsError.response?.data || awsError.message,
                entitlementNote: 'Your entitlement has been consumed despite the AWS error. Contact support if needed.'
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

function formatChapter(doc) {
    const meta = doc.metadataRaw || {};
    return {
        chapterNumber: meta.chapterNumber ?? meta.chapter_number ?? null,
        headline: meta.headline || null,
        keywords: meta.keywords || [],
        summary: meta.summary || null,
        startTime: meta.startTime ?? meta.start_time ?? doc.start_time ?? null,
        endTime: meta.endTime ?? meta.end_time ?? doc.end_time ?? null,
    };
}

/**
 * POST /api/on-demand/getOnDemandJobStatus
 * Get status of an on-demand job. When complete, includes chapter data and nextSteps.
 */
router.post('/getOnDemandJobStatus', async (req, res) => {
    // #swagger.tags = ['On-Demand Transcription']
    // #swagger.summary = 'Get transcription job status with chapters on completion'
    // #swagger.description = 'Returns job status and per-episode progress. When status is "complete", the response is enriched with chapter headlines, keywords, summaries, and timestamps for each successfully transcribed episode, plus a nextSteps block pointing to /api/search-quotes for semantic search across the newly indexed content. No authentication required — anyone with the jobId can poll.'
    /* #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: {
        jobId: '6b2440adae3f806198eb56c0'
      }
    } */
    /* #swagger.responses[200] = {
      description: 'Job status with optional chapter enrichment',
      schema: {
        success: true,
        jobId: '6b2440adae3f806198eb56c0',
        status: 'complete',
        stats: { totalEpisodes: 1, totalFeeds: 1, episodesProcessed: 1, episodesSkipped: 0, episodesFailed: 0 },
        episodes: [{
          guid: 'dd043afd-d7f8-4a96-97aa-a24a743fc219',
          feedId: '357756',
          status: 'success',
          chapters: [{
            chapterNumber: 1,
            headline: 'SEC and CFTC Developments in Crypto',
            keywords: ['SEC', 'CFTC', 'crypto regulations'],
            summary: 'Discussion on SEC and CFTC actions regarding crypto...',
            startTime: 0,
            endTime: 159.48
          }]
        }],
        nextSteps: {
          searchTranscripts: {
            description: 'Semantic search across the newly transcribed content with timestamped deeplinks',
            method: 'POST',
            url: '/api/search-quotes',
            body: { query: '...', feedIds: ['357756'], smartMode: true }
          }
        }
      }
    } */
    /* #swagger.responses[404] = {
      description: 'Job not found',
      schema: { $ref: '#/components/schemas/Error' }
    } */
    try {
        const { jobId } = req.body;

        if (!jobId) {
            return res.status(400).json({
                error: 'Missing job ID',
                details: 'Please provide a job ID'
            });
        }

        const job = await WorkProductV2.findOne({ lookupHash: jobId });

        if (!job) {
            return res.status(404).json({
                error: 'Job not found',
                details: `No job found with ID ${jobId}`
            });
        }

        const isComplete = job.result.jobStatus === 'complete';
        const episodes = job.result.episodes || [];

        let enrichedEpisodes = episodes;
        if (isComplete) {
            const successGuids = episodes
                .filter(ep => ep.status === 'success')
                .map(ep => ep.guid);

            if (successGuids.length > 0) {
                const chapters = await JamieVectorMetadata.find({
                    type: 'chapter',
                    guid: { $in: successGuids }
                })
                    .select('guid start_time end_time metadataRaw')
                    .sort({ start_time: 1 })
                    .lean();

                const chaptersByGuid = {};
                for (const ch of chapters) {
                    if (!chaptersByGuid[ch.guid]) chaptersByGuid[ch.guid] = [];
                    chaptersByGuid[ch.guid].push(formatChapter(ch));
                }

                enrichedEpisodes = episodes.map(ep => ({
                    ...ep,
                    ...(chaptersByGuid[ep.guid] ? { chapters: chaptersByGuid[ep.guid] } : {})
                }));
            }
        }

        const feedIds = [...new Set(episodes.map(ep => ep.feedId).filter(Boolean))];

        const response = {
            success: true,
            jobId,
            status: job.result.jobStatus,
            stats: {
                totalEpisodes: job.result.totalEpisodes,
                totalFeeds: job.result.totalFeeds,
                episodesProcessed: job.result.episodesProcessed,
                episodesSkipped: job.result.episodesSkipped,
                episodesFailed: job.result.episodesFailed
            },
            episodes: enrichedEpisodes,
            startedAt: job.result.startedAt,
            completedAt: job.result.completedAt,
        };

        if (isComplete && feedIds.length > 0) {
            response.nextSteps = {
                searchTranscripts: {
                    description: 'Semantic search across the newly transcribed content with timestamped deeplinks',
                    method: 'POST',
                    url: '/api/search-quotes',
                    body: {
                        query: '...',
                        feedIds,
                        smartMode: true
                    }
                }
            };
        }

        res.json(response);
    } catch (error) {
        console.error('Error getting job status:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

module.exports = router; 