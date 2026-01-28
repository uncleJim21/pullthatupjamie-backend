const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { WorkProductV2 } = require('../models/WorkProductV2');
const axios = require('axios');
const { checkEntitlementEligibility, consumeEntitlement } = require('../utils/entitlements');
const jwt = require('jsonwebtoken');
const { User } = require('../models/User');
const { Entitlement } = require('../models/Entitlement');
const { resolveIdentity } = require('../utils/identityResolver');
const { getQuotaConfig, TIERS, createEntitlementMiddleware } = require('../utils/entitlementMiddleware');
const { ENTITLEMENT_TYPES, ALL_ENTITLEMENT_TYPES } = require('../constants/entitlementTypes');

/**
 * GET /api/on-demand/checkEligibility
 * Check eligibility for ALL entitlement types (uses new identity resolver)
 * 
 * Returns quotas for: search-quotes, search-quotes-3d, make-clip, jamie-assist, analyze, submitOnDemandRun
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
router.post('/submitOnDemandRun', createEntitlementMiddleware(ENTITLEMENT_TYPES.SUBMIT_ON_DEMAND_RUN), async (req, res) => {
    try {
        // Identity and entitlement already resolved by middleware
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

            // Return success response with the lookupHash and AWS response
            return res.json({
                success: true,
                jobId: lookupHash,
                totalEpisodes: episodes.length,
                totalFeeds: result.totalFeeds,
                message: 'On-demand run submitted successfully',
                authType: req.authType,
                entitlementInfo: {
                    remainingRuns: entitlementResult.remainingUsage,
                    usedThisPeriod: entitlementResult.usedCount,
                    totalLimit: entitlementResult.maxUsage
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
            userEmail: job.result.userEmail || null, // Include user email if available
            clientIp: job.result.clientIp || null, // Include client IP if available
            authType: job.result.authType || null // Include auth type if available
        });
    } catch (error) {
        console.error('Error getting job status:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

/**
 * POST /api/on-demand/update-ondemand-quota
 * Update on-demand quota for jamie-pro users
 */
router.post('/update-ondemand-quota', async (req, res) => {
    try {
        // 0. Extract and verify JWT token
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Authentication required',
                details: 'Bearer token required'
            });
        }

        const token = authHeader.split(' ')[1];
        let decoded;
        
        try {
            decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
        } catch (jwtError) {
            return res.status(401).json({
                error: 'Invalid token',
                details: 'Token verification failed'
            });
        }

        const email = decoded.email;
        if (!email) {
            return res.status(401).json({
                error: 'Invalid token',
                details: 'Token missing email claim'
            });
        }

        // 1. Delay 2.5 seconds to ensure other processes complete
        await new Promise(resolve => setTimeout(resolve, 2500));

        // 2. Check User.js by looking up email
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({
                error: 'User not found',
                details: 'No user found with the provided email'
            });
        }

        // 3. Verify whether the user has jamie-pro subscription
        let hasJamiePro = false;
        try {
            // Validate with auth server using the provided token
            const authResponse = await axios.get(`${process.env.CASCDR_AUTH_SERVER_URL}/validate-subscription`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            const authData = authResponse.data;
            
            // Check if subscription is valid and specifically for jamie-pro
            if (authData.subscriptionValid && authData.subscriptionType === 'jamie-pro') {
                hasJamiePro = true;
            }
        } catch (authError) {
            console.error('Auth server validation failed:', authError);
            return res.status(403).json({
                error: 'Subscription validation failed',
                details: 'Could not validate jamie-pro subscription'
            });
        }

        // 4. If they have jamie-pro, update entitlement to 8 on-demand runs per month
        if (hasJamiePro) {
            try {
                // Find or create entitlement for this user
                let entitlement = await Entitlement.findOne({
                    identifier: email,
                    identifierType: 'jwt',
                    entitlementType: 'submitOnDemandRun'
                });

                if (entitlement) {
                    // Update existing entitlement - don't reset usedCount unless period expired
                    const periodExpired = entitlement.nextResetDate && new Date() >= entitlement.nextResetDate;
                    
                    entitlement.maxUsage = parseInt(process.env.JAMIE_PRO_ON_DEMAND_QUOTA) || 8;
                    
                    // Only reset usedCount if period has expired
                    if (periodExpired) {
                        entitlement.usedCount = 0;
                        const now = new Date();
                        entitlement.periodStart = now;
                        const nextResetDate = new Date(now);
                        nextResetDate.setDate(nextResetDate.getDate() + 30);
                        entitlement.nextResetDate = nextResetDate;
                    }
                    
                    entitlement.status = 'active';
                    entitlement.lastUsed = new Date();
                    await entitlement.save();
                } else {
                    // Create new entitlement
                    const now = new Date();
                    const nextResetDate = new Date(now);
                    nextResetDate.setDate(nextResetDate.getDate() + 30); // 30 days from now
                    
                    entitlement = new Entitlement({
                        identifier: email,
                        identifierType: 'jwt',
                        entitlementType: 'submitOnDemandRun',
                        usedCount: 0,
                        maxUsage: 8,
                        periodStart: now,
                        periodLengthDays: 30,
                        nextResetDate,
                        lastUsed: now,
                        status: 'active'
                    });
                    await entitlement.save();
                }

                return res.json({
                    success: true,
                    message: 'On-demand quota updated for jamie-pro user',
                    userEmail: email,
                    entitlement: {
                        maxUsage: entitlement.maxUsage,
                        usedCount: entitlement.usedCount,
                        remainingUsage: entitlement.maxUsage - entitlement.usedCount,
                        periodStart: entitlement.periodStart,
                        nextResetDate: entitlement.nextResetDate,
                        status: entitlement.status
                    }
                });
            } catch (entitlementError) {
                console.error('Error updating entitlement:', entitlementError);
                return res.status(500).json({
                    error: 'Failed to update entitlement',
                    details: entitlementError.message
                });
            }
        } else {
            return res.status(403).json({
                error: 'Not authorized',
                details: 'User does not have jamie-pro subscription'
            });
        }

    } catch (error) {
        console.error('Error in update-ondemand-quota:', error);
        return res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

module.exports = router; 