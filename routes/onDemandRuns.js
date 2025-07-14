const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { WorkProductV2 } = require('../models/WorkProductV2');
const axios = require('axios');
const { checkEntitlementEligibility, consumeEntitlement } = require('../utils/entitlements');
const jwt = require('jsonwebtoken');
const { User } = require('../models/User');
const { Entitlement } = require('../models/Entitlement');

/**
 * GET /api/on-demand/checkEligibility
 * Check eligibility for on-demand runs (supports both IP and JWT auth)
 */
router.get('/checkEligibility', async (req, res) => {
    try {
        // Extract user email from JWT token if provided
        let userEmail = null;
        const authHeader = req.headers.authorization;
        
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const jwt = require('jsonwebtoken');
            try {
                const token = authHeader.substring(7);
                const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
                userEmail = decoded.email;
            } catch (jwtError) {
                console.error('JWT verification failed:', jwtError.message);
            }
        }

        // If we have a user email, check JWT-based eligibility
        if (userEmail) {
            const eligibility = await checkEntitlementEligibility(userEmail, 'jwt', 'onDemandRun');
            
            return res.json({
                success: true,
                userEmail: userEmail,
                eligibility: {
                    eligible: eligibility.eligible,
                    remainingRuns: eligibility.remainingUsage,
                    totalLimit: eligibility.maxUsage,
                    usedThisPeriod: eligibility.usedCount,
                    periodStart: eligibility.periodStart,
                    nextResetDate: eligibility.nextResetDate,
                    daysUntilReset: eligibility.daysUntilReset
                },
                message: eligibility.eligible 
                    ? `You have ${eligibility.remainingUsage} on-demand runs remaining this period.`
                    : `You have reached your limit of ${eligibility.maxUsage} on-demand runs. Next reset: ${eligibility.nextResetDate?.toLocaleDateString()}`
            });
        }

        // If no user email, check IP-based eligibility
        const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 
                         req.headers['x-real-ip'] || 
                         req.ip ||
                         req.connection.remoteAddress;

        if (!clientIp) {
            return res.status(400).json({
                success: false,
                error: 'Could not determine client IP address',
                details: 'IP address is required for eligibility check'
            });
        }

        const ipEligibility = await checkEntitlementEligibility(clientIp, 'ip', 'onDemandRun');
        
        return res.json({
            success: true,
            clientIp: clientIp,
            eligibility: {
                eligible: ipEligibility.eligible,
                remainingRuns: ipEligibility.remainingUsage,
                totalLimit: ipEligibility.maxUsage,
                usedThisPeriod: ipEligibility.usedCount,
                periodStart: ipEligibility.periodStart,
                nextResetDate: ipEligibility.nextResetDate,
                daysUntilReset: ipEligibility.daysUntilReset
            },
            message: ipEligibility.eligible 
                ? `You have ${ipEligibility.remainingUsage} on-demand runs remaining this period.`
                : `You have reached your limit of ${ipEligibility.maxUsage} on-demand runs. Next reset: ${ipEligibility.nextResetDate?.toLocaleDateString()}`
        });

    } catch (error) {
        console.error('Error checking on-demand eligibility:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

/**
 * POST /api/on-demand/submitOnDemandRun
 * Submit an on-demand run request
 */
router.post('/submitOnDemandRun', async (req, res) => {
    try {
        // Extract user email from JWT token if provided
        let userEmail = null;
        let authType = 'ip';
        const authHeader = req.headers.authorization;
        
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const jwt = require('jsonwebtoken');
            try {
                const token = authHeader.substring(7);
                const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
                userEmail = decoded.email;
                authType = 'user';
            } catch (jwtError) {
                console.error('JWT verification failed:', jwtError.message);
            }
        }

        // If no user email, use IP-based auth
        if (!userEmail) {
            const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 
                             req.headers['x-real-ip'] || 
                             req.ip ||
                             req.connection.remoteAddress;
            
            if (!clientIp) {
                return res.status(400).json({
                    error: 'Could not determine client IP address',
                    details: 'IP address is required for authentication'
                });
            }
            
            req.clientIp = clientIp;
        } else {
            req.userEmail = userEmail;
        }
        
        req.authType = authType;

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

        // Consume user entitlement based on auth type
        let entitlementResult;
        if (req.authType === 'user') {
            entitlementResult = await consumeEntitlement(req.userEmail, 'jwt', 'onDemandRun');
        } else {
            entitlementResult = await consumeEntitlement(req.clientIp, 'ip', 'onDemandRun');
        }
        
        if (!entitlementResult.success) {
            return res.status(403).json({
                error: 'Failed to consume entitlement',
                details: entitlementResult.error,
                remainingRuns: entitlementResult.remainingUsage,
                nextResetDate: entitlementResult.nextResetDate
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
            userEmail: req.authType === 'user' ? req.userEmail : null,
            clientIp: req.authType === 'ip' ? req.clientIp : null,
            authType: req.authType,
            entitlementConsumed: true
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
                    entitlementType: 'onDemandRun'
                });

                if (entitlement) {
                    // Update existing entitlement and reset count to 0
                    entitlement.maxUsage = process.env.JAMIE_PRO_ON_DEMAND_QUOTA || 4;
                    entitlement.usedCount = 0;
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
                        entitlementType: 'onDemandRun',
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