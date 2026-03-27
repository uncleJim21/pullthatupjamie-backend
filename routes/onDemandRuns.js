const express = require('express');
const crypto = require('crypto');
const { WorkProductV2 } = require('../models/WorkProductV2');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const axios = require('axios');
const { checkEntitlementEligibility, consumeEntitlement } = require('../utils/entitlements');
const jwt = require('jsonwebtoken');
const { User } = require('../models/shared/UserSchema');
const { Entitlement } = require('../models/Entitlement');
const { resolveIdentity } = require('../utils/identityResolver');
const { parseL402Header, verifyMacaroon } = require('../utils/macaroon-utils');
const { validatePreimage } = require('../utils/lightning-utils');
const { getQuotaConfig, TIERS, createEntitlementMiddleware } = require('../utils/entitlementMiddleware');
const { ENTITLEMENT_TYPES, ALL_ENTITLEMENT_TYPES } = require('../constants/entitlementTypes');
const { serviceHmac } = require('../middleware/hmac');

/**
 * Factory to create on-demand run routes.
 *
 * @param {Object} deps
 * @param {Object} [deps.transcriptSpacesManager] - DigitalOceanSpacesManager for transcript bucket
 * @returns {express.Router}
 */
function createOnDemandRoutes({ transcriptSpacesManager } = {}) {
const router = express.Router();

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
        const wpDoc = {
            type: 'on-demand-jamie-episodes',
            lookupHash,
            result
        };
        if (identity.identifierType === 'prepaid') {
            wpDoc.paymentHash = identity.identifier;
        }
        await WorkProductV2.create(wpDoc);

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
                overrideExistence: false
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
                        description: 'Poll until status is "complete". Typical transcription takes 30-120 seconds per episode. If you paid via L402, include the same Authorization header when polling to receive transcript download URLs in the response.',
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

/**
 * Best-effort extraction of the caller's paymentHash from an L402 Authorization header.
 * Returns null if the header is absent, malformed, or verification fails.
 */
function extractCallerPaymentHash(req) {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader) return null;

    const l402 = parseL402Header(authHeader);
    if (!l402) return null;

    try {
        const { macaroonBase64, preimage } = l402;
        const macResult = verifyMacaroon(macaroonBase64);
        if (!macResult.valid) return null;

        if (!validatePreimage(preimage, macResult.paymentHash)) return null;

        return macResult.paymentHash;
    } catch {
        return null;
    }
}

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
    // #swagger.description = 'Returns job status and per-episode progress. When status is "complete", the response is enriched with chapter headlines, keywords, summaries, and timestamps for each successfully transcribed episode, plus a nextSteps block pointing to /api/search-quotes for semantic search across the newly indexed content. No authentication required for basic polling — anyone with the jobId can poll.\n\nOptional: if the caller includes an Authorization header with the same L402 credential used to pay for the job, each completed episode will also include a `transcriptUrl` — a relative path to GET /api/on-demand/transcript/{jobId}/{guid} that streams the full transcript JSON through an authenticated proxy. The same L402 credential must be presented to that endpoint.'
    /* #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: {
        jobId: '6b2440adae3f806198eb56c0'
      }
    } */
    /* #swagger.parameters['Authorization'] = { in: 'header', required: false, type: 'string', description: 'Optional L402 credential (L402 <macaroon>:<preimage>). When present and matching the credential that paid for the job, transcript download URLs are included.' } */
    /* #swagger.responses[200] = {
      description: 'Job status with optional chapter enrichment and transcript URLs',
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
          }],
          transcriptUrl: '/api/on-demand/transcript/6b2440adae3f806198eb56c0/dd043afd-d7f8-4a96-97aa-a24a743fc219'
        }],
        nextSteps: {
          downloadTranscript: {
            description: 'Download the full transcript JSON for each completed episode. Requires the same L402 credential that paid for the job. The transcriptUrl for each episode is included above when a valid L402 credential is presented.',
            method: 'GET',
            url: '/api/on-demand/transcript/{jobId}/{guid}',
            headers: { Authorization: 'L402 <macaroon>:<preimage>' }
          },
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
        const enrichableStatuses = ['success', 'all_skipped', 'skipped'];
        if (isComplete) {
            const enrichableGuids = episodes
                .filter(ep => enrichableStatuses.includes(ep.status))
                .map(ep => ep.guid);

            if (enrichableGuids.length > 0) {
                const chapters = await JamieVectorMetadata.find({
                    type: 'chapter',
                    guid: { $in: enrichableGuids }
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

            // If caller presents the L402 credential that paid for this job,
            // include proxied transcript download URLs for each enrichable episode.
            const storedPaymentHash = job.paymentHash;
            if (storedPaymentHash) {
                const callerPaymentHash = extractCallerPaymentHash(req);
                if (callerPaymentHash && callerPaymentHash === storedPaymentHash) {
                    for (const ep of enrichedEpisodes) {
                        if (!enrichableStatuses.includes(ep.status)) continue;
                        ep.transcriptUrl = `/api/on-demand/transcript/${jobId}/${ep.guid}`;
                    }
                }
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

            const hasTranscriptUrls = enrichedEpisodes.some(ep => ep.transcriptUrl);
            if (hasTranscriptUrls) {
                response.nextSteps.downloadTranscript = {
                    description: 'Download the full transcript JSON for each completed episode. Use the transcriptUrl from each episode above. Requires the same L402 credential.',
                    method: 'GET',
                    headers: { Authorization: 'L402 <macaroon>:<preimage>' }
                };
            }
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

/**
 * GET /api/on-demand/transcript/:jobId/:guid
 * Proxy-stream a transcript JSON from Spaces, gated by L402 credential match.
 */
router.get('/transcript/:jobId/:guid', async (req, res) => {
    // #swagger.tags = ['On-Demand Transcription']
    // #swagger.summary = 'Download full transcript JSON for a transcribed episode'
    // #swagger.description = 'Streams the full transcript JSON for the given episode. Requires the same L402 credential that was used to pay for the transcription job.'
    /* #swagger.parameters['jobId'] = { in: 'path', required: true, type: 'string', description: 'Job ID returned by submitOnDemandRun' } */
    /* #swagger.parameters['guid'] = { in: 'path', required: true, type: 'string', description: 'Episode GUID' } */
    /* #swagger.parameters['Authorization'] = { in: 'header', required: true, type: 'string', description: 'L402 credential (L402 <macaroon>:<preimage>) matching the one that paid for the job' } */
    try {
        const { jobId, guid } = req.params;

        const job = await WorkProductV2.findOne({ lookupHash: jobId }).lean();
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        if (!job.paymentHash) {
            return res.status(403).json({ error: 'No L402 credential associated with this job' });
        }

        const callerPaymentHash = extractCallerPaymentHash(req);
        if (!callerPaymentHash || callerPaymentHash !== job.paymentHash) {
            return res.status(401).json({ error: 'Unauthorized', message: 'Valid matching L402 credential required' });
        }

        const enrichableStatuses = ['success', 'all_skipped', 'skipped'];
        const episode = (job.result.episodes || []).find(ep => ep.guid === guid);
        if (!episode || !enrichableStatuses.includes(episode.status)) {
            return res.status(404).json({ error: 'Episode not found or not yet transcribed' });
        }

        if (!transcriptSpacesManager) {
            return res.status(503).json({ error: 'Transcript storage not available' });
        }

        const bucket = process.env.TRANSCRIPT_SPACES_BUCKET_NAME;
        const { stream, contentLength } = await transcriptSpacesManager.getFileStream(bucket, `${guid}.json`);

        const sizeMB = contentLength ? (contentLength / 1024 / 1024).toFixed(2) : 'unknown';
        console.log(`[transcript-proxy] Streaming ${guid}.json (${sizeMB} MB) for job ${jobId}`);

        const STREAM_TIMEOUT_MS = 60_000;
        let lastActivity = Date.now();
        const timeoutCheck = setInterval(() => {
            if (Date.now() - lastActivity > STREAM_TIMEOUT_MS) {
                console.error(`[transcript-proxy] Stream stalled for ${guid}.json — aborting`);
                stream.destroy();
                clearInterval(timeoutCheck);
                if (!res.headersSent) {
                    res.status(504).json({ error: 'Stream timed out' });
                } else {
                    res.end();
                }
            }
        }, 10_000);

        stream.on('data', () => { lastActivity = Date.now(); });

        stream.on('error', (err) => {
            clearInterval(timeoutCheck);
            console.error(`[transcript-proxy] Stream error for ${guid}.json:`, err.message);
            if (!res.headersSent) {
                res.status(502).json({ error: 'Upstream storage error' });
            } else {
                res.end();
            }
        });

        res.on('close', () => { clearInterval(timeoutCheck); stream.destroy(); });

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${guid}.json"`);
        if (contentLength) res.setHeader('Content-Length', contentLength);
        stream.pipe(res);
    } catch (error) {
        if (error.message && error.message.includes('not found')) {
            return res.status(404).json({ error: 'Transcript file not found' });
        }
        console.error('[transcript-proxy] Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

return router;
}

module.exports = createOnDemandRoutes;