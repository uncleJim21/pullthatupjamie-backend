// User social posts API routes - handles cross-posting to Twitter and Nostr
// Handles user social posts for Twitter and Nostr cross-posting
const express = require('express');
const router = express.Router();
const SocialPost = require('../models/SocialPost');
const { authenticateToken } = require('../middleware/authMiddleware');
const { schedulePosts, validateSignedEvent, DEFAULT_POST_RELAYS } = require('../utils/SocialPostService');
const { findUserFromRequest, buildUserFilter } = require('../utils/userLookup');
const { getOrCreateEntitlement, getQuotaConfig, TIERS } = require('../utils/entitlementMiddleware');
const { resolveIdentity } = require('../utils/identityResolver');
const { ENTITLEMENT_TYPES } = require('../constants/entitlementTypes');
const { emitServerEvent } = require('../utils/analyticsEmitter');
const { SERVER_EVENT_TYPES } = require('../constants/analyticsTypes');

/**
 * POST /api/user/social/posts
 * Create scheduled posts for authenticated user (no podcast required)
 */
router.post('/posts', authenticateToken, async (req, res) => {
    try {
        const { text, mediaUrl, scheduledFor, platforms, timezone = 'America/Chicago', platformData, scheduledPostSlotId, status } = req.body;
        
        // Validate content - either text or media required
        const hasText = !!(text && String(text).trim().length > 0);
        const hasMedia = !!(mediaUrl && String(mediaUrl).trim().length > 0);
        
        if (!hasText && !hasMedia) {
            return res.status(400).json({ 
                error: 'Content required',
                message: 'Either text or media URL must be provided' 
            });
        }
        
        const requestsTwitter = Array.isArray(platforms) && platforms.includes('twitter');

        if (requestsTwitter) {
            const identity = await resolveIdentity(req);
            const analyticsSessionId = req.headers['x-pulse-session'] || req.headers['x-analytics-session'] || null;

            if (identity.tier === TIERS.anonymous) {
                return res.status(401).json({
                    error: 'Authentication required',
                    code: 'AUTH_REQUIRED',
                    message: 'An account is required to post to Twitter. Nostr posting is unlimited and does not require an account.'
                });
            }

            const entitlement = await getOrCreateEntitlement(
                identity.identifier,
                identity.identifierType,
                ENTITLEMENT_TYPES.TWITTER_POST,
                identity.tier
            );

            const isUnlimited = entitlement.maxUsage === -1;

            if (!isUnlimited && entitlement.usedCount >= entitlement.maxUsage) {
                emitServerEvent(
                    SERVER_EVENT_TYPES.ENTITLEMENT_DENIED,
                    analyticsSessionId,
                    identity.tier,
                    { entitlement_type: ENTITLEMENT_TYPES.TWITTER_POST, used: entitlement.usedCount, max: entitlement.maxUsage }
                );

                return res.status(429).json({
                    error: 'Twitter post quota exceeded',
                    code: 'QUOTA_EXCEEDED',
                    message: `You've used all ${entitlement.maxUsage} Twitter posts this period (resets in ${Math.ceil((entitlement.nextResetDate - new Date()) / (1000 * 60 * 60 * 24))} days). Nostr posting is unlimited and unaffected — remove Twitter from platforms to post to Nostr only.`,
                    used: entitlement.usedCount,
                    max: entitlement.maxUsage,
                    resetDate: entitlement.nextResetDate,
                    daysUntilReset: Math.ceil((entitlement.nextResetDate - new Date()) / (1000 * 60 * 60 * 24)),
                    tier: identity.tier
                });
            }

            if (!isUnlimited) {
                entitlement.usedCount += 1;
                entitlement.lastUsed = new Date();
                await entitlement.save();

                emitServerEvent(
                    SERVER_EVENT_TYPES.ENTITLEMENT_CONSUMED,
                    analyticsSessionId,
                    identity.tier,
                    {
                        entitlement_type: ENTITLEMENT_TYPES.TWITTER_POST,
                        used: entitlement.usedCount,
                        remaining: entitlement.maxUsage - entitlement.usedCount,
                        max: entitlement.maxUsage
                    }
                );
            }

            res.setHeader('X-Twitter-Quota-Used', entitlement.usedCount);
            res.setHeader('X-Twitter-Quota-Max', isUnlimited ? 'unlimited' : entitlement.maxUsage);
            res.setHeader('X-Twitter-Quota-Remaining', isUnlimited ? 'unlimited' : Math.max(0, entitlement.maxUsage - entitlement.usedCount));
            res.setHeader('X-Twitter-Quota-Reset', entitlement.nextResetDate.toISOString());
        }

        // Get user ID
        const user = await findUserFromRequest(req, '_id email');
        if (!user) {
            return res.status(400).json({ error: 'User not found' });
        }
        
        const createdPosts = await schedulePosts({
            adminUserId: user._id,
            adminEmail: user.email,
            text,
            mediaUrl,
            scheduledFor,
            platforms,
            timezone,
            platformData,
            scheduledPostSlotId,
            status
        });
        
        res.json({
            success: true,
            message: `Created ${createdPosts.length} scheduled post(s)`,
            posts: createdPosts.map(post => ({
                _id: post._id,
                platform: post.platform,
                scheduledFor: post.scheduledFor,
                status: post.status,
                content: post.content,
                platformData: post.platformData
            }))
        });
    } catch (error) {
        console.error('Error creating user social post:', error);
        res.status(error.status || 500).json({
            error: 'Failed to create social post',
            message: error.message
        });
    }
});

/**
 * GET /api/user/social/posts
 * List scheduled posts for authenticated user
 */
router.get('/posts', authenticateToken, async (req, res) => {
    try {
        const { 
            status, 
            platform, 
            limit = 20, 
            offset = 0,
            sortBy = 'scheduledFor',
            sortOrder = 'desc'
        } = req.query;

        const user = await findUserFromRequest(req, '_id email');
        if (!user) {
            return res.status(400).json({ error: 'User not found' });
        }

        // Build query - user owns these posts
        const query = SocialPost.buildOwnerQuery({
            userId: user._id,
            email: user.email
        });
        
        if (status) {
            const validStatuses = SocialPost.getStatusOptions();
            if (!validStatuses.includes(status)) {
                return res.status(400).json({
                    error: 'Invalid status',
                    message: `Valid statuses: ${validStatuses.join(', ')}`
                });
            }
            query.status = status;
        }
        
        if (platform) {
            if (!['twitter', 'nostr'].includes(platform)) {
                return res.status(400).json({
                    error: 'Invalid platform',
                    message: 'Valid platforms: twitter, nostr'
                });
            }
            query.platform = platform;
        }

        const posts = await SocialPost.find(query)
            .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
            .limit(parseInt(limit))
            .skip(parseInt(offset))
            .lean();

        const total = await SocialPost.countDocuments(query);

        res.json({
            posts,
            pagination: {
                total,
                limit: parseInt(limit),
                offset: parseInt(offset),
                hasMore: total > (parseInt(offset) + posts.length)
            }
        });
    } catch (error) {
        console.error('Error fetching user social posts:', error);
        res.status(500).json({
            error: 'Failed to fetch posts',
            message: error.message
        });
    }
});

/**
 * DELETE /api/user/social/posts/:postId
 * Delete/cancel a scheduled post
 */
router.delete('/posts/:postId', authenticateToken, async (req, res) => {
    try {
        const { postId } = req.params;
        
        const user = await findUserFromRequest(req, '_id email');
        if (!user) {
            return res.status(400).json({ error: 'User not found' });
        }

        const ownerQuery = SocialPost.buildOwnerQuery({
            userId: user._id,
            email: user.email
        });

        const post = await SocialPost.findOne({ 
            _id: postId,
            ...ownerQuery 
        });

        if (!post) {
            return res.status(404).json({ 
                error: 'Not found',
                message: 'Post not found or you do not have permission to delete it'
            });
        }

        // Only allow deletion of scheduled/unsigned/failed posts
        if (!['scheduled', 'unsigned', 'failed'].includes(post.status)) {
            return res.status(400).json({
                error: 'Cannot delete',
                message: `Cannot delete posts with status: ${post.status}`
            });
        }

        await SocialPost.findByIdAndDelete(postId);

        res.json({
            success: true,
            message: 'Post deleted successfully',
            deletedId: postId
        });
    } catch (error) {
        console.error('Error deleting user social post:', error);
        res.status(500).json({
            error: 'Failed to delete post',
            message: error.message
        });
    }
});

/**
 * PUT /api/user/social/posts/:postId
 * Update a scheduled post (reschedule, edit content, add Nostr signature)
 */
router.put('/posts/:postId', authenticateToken, async (req, res) => {
    try {
        const { postId } = req.params;
        const { scheduledFor, text, mediaUrl, platformData } = req.body;
        
        const user = await findUserFromRequest(req, '_id email');
        if (!user) {
            return res.status(400).json({ error: 'User not found' });
        }

        const ownerQuery = SocialPost.buildOwnerQuery({
            userId: user._id,
            email: user.email
        });

        const post = await SocialPost.findOne({ 
            _id: postId,
            ...ownerQuery 
        });

        if (!post) {
            return res.status(404).json({ 
                error: 'Not found',
                message: 'Post not found or you do not have permission to update it'
            });
        }

        // Only allow updates to scheduled/unsigned posts
        if (!['scheduled', 'unsigned', 'failed'].includes(post.status)) {
            return res.status(400).json({
                error: 'Cannot update',
                message: `Cannot update posts with status: ${post.status}`
            });
        }

        // Update fields if provided
        if (scheduledFor) {
            post.scheduledFor = new Date(scheduledFor);
        }
        
        if (text !== undefined) {
            post.content.text = text;
        }
        
        if (mediaUrl !== undefined) {
            post.content.mediaUrl = mediaUrl;
        }
        
        if (platformData) {
            const mergedPlatformData = { ...(post.platformData || {}), ...platformData };

            if (post.platform === 'nostr') {
                if (mergedPlatformData.signedEvent) {
                    validateSignedEvent(mergedPlatformData.signedEvent);
                }

                if (!mergedPlatformData.nostrRelays || mergedPlatformData.nostrRelays.length === 0) {
                    mergedPlatformData.nostrRelays = [...DEFAULT_POST_RELAYS];
                }

                // Promote unsigned -> scheduled when signing data is provided
                if (post.status === 'unsigned' && (platformData.nostrSignature || platformData.signedEvent)) {
                    post.status = 'scheduled';
                }
            }

            post.platformData = mergedPlatformData;
            post.markModified('platformData');
        }

        await post.save();

        res.json({
            success: true,
            message: 'Post updated successfully',
            post: {
                _id: post._id,
                platform: post.platform,
                scheduledFor: post.scheduledFor,
                status: post.status,
                content: post.content,
                platformData: post.platformData
            }
        });
    } catch (error) {
        console.error('Error updating user social post:', error);
        res.status(error.status || 500).json({
            error: 'Failed to update post',
            message: error.message
        });
    }
});

module.exports = router;
