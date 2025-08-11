const express = require('express');
const router = express.Router();
const SocialPost = require('../models/SocialPost');
const { validatePrivs } = require('../middleware/validate-privs');

/**
 * POST /api/social/posts
 * Create new scheduled social post(s)
 * Cross-posting creates separate objects per platform
 */
router.post('/posts', validatePrivs, async (req, res) => {
    try {
        const { 
            text, 
            mediaUrl, 
            scheduledFor, 
            platforms, // ['twitter', 'nostr'] for cross-posting
            timezone = 'America/Chicago'
        } = req.body;

        // Validation - require either text OR media
        const hasText = text && text.trim().length > 0;
        const hasMedia = mediaUrl && mediaUrl.trim().length > 0;
        
        if (!hasText && !hasMedia) {
            return res.status(400).json({
                error: 'Missing content',
                message: 'Either text or media URL is required'
            });
        }

        if (!scheduledFor) {
            return res.status(400).json({
                error: 'Missing scheduledFor',
                message: 'Scheduled date/time is required'
            });
        }

        if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
            return res.status(400).json({
                error: 'Missing platforms',
                message: 'At least one platform must be specified'
            });
        }

        // Validate platforms
        const validPlatforms = SocialPost.getPlatformOptions();
        const invalidPlatforms = platforms.filter(p => !validPlatforms.includes(p));
        if (invalidPlatforms.length > 0) {
            return res.status(400).json({
                error: 'Invalid platforms',
                message: `Invalid platforms: ${invalidPlatforms.join(', ')}. Valid options: ${validPlatforms.join(', ')}`
            });
        }

        // Create separate SocialPost for each platform
        const createdPosts = [];
        const scheduledDate = new Date(scheduledFor);

        for (const platform of platforms) {
            // For Nostr, use the entire platformData object as-is
            const platformData = platform === 'nostr' ? 
                { ...req.body.platformData } : // Use spread to create a new object
                {}; // Empty object for other platforms
            
            // Add Twitter-specific data if needed
            if (platform === 'twitter' && req.body.platformData?.twitterTokens) {
                platformData.twitterTokens = req.body.platformData.twitterTokens;
            }

            const socialPost = new SocialPost({
                adminEmail: req.user.adminEmail,
                platform,
                scheduledFor: scheduledDate,
                timezone,
                content: {
                    text: text.trim(),
                    mediaUrl: mediaUrl || null
                },
                platformData
            });

            await socialPost.save();
            createdPosts.push(socialPost);
        }

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
        console.error('Error creating social post:', error);
        res.status(500).json({
            error: 'Failed to create social post',
            message: error.message
        });
    }
});

/**
 * GET /api/social/posts
 * List all social posts for authenticated user
 */
router.get('/posts', validatePrivs, async (req, res) => {
    try {
        const { 
            status, 
            platform, 
            limit = 20, 
            offset = 0,
            sortBy = 'scheduledFor',
            sortOrder = 'desc'
        } = req.query;

        // Build query
        const query = { adminEmail: req.user.adminEmail };
        
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
            const validPlatforms = SocialPost.getPlatformOptions();
            if (!validPlatforms.includes(platform)) {
                return res.status(400).json({
                    error: 'Invalid platform',
                    message: `Valid platforms: ${validPlatforms.join(', ')}`
                });
            }
            query.platform = platform;
        }

        // Build sort object
        const sort = {};
        sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

        // Execute query
        const posts = await SocialPost.find(query)
            .sort(sort)
            .limit(parseInt(limit))
            .skip(parseInt(offset))
            .lean();

        // Get total count for pagination
        const totalCount = await SocialPost.countDocuments(query);

        res.json({
            success: true,
            posts,
            pagination: {
                total: totalCount,
                limit: parseInt(limit),
                offset: parseInt(offset),
                hasMore: (parseInt(offset) + parseInt(limit)) < totalCount
            },
            metadata: {
                statusOptions: SocialPost.getStatusOptions(),
                platformOptions: SocialPost.getPlatformOptions()
            }
        });

    } catch (error) {
        console.error('Error listing social posts:', error);
        res.status(500).json({
            error: 'Failed to list social posts',
            message: error.message
        });
    }
});

/**
 * GET /api/social/posts/:postId
 * Get specific social post details
 */
router.get('/posts/:postId', validatePrivs, async (req, res) => {
    try {
        const { postId } = req.params;

        const post = await SocialPost.findOne({
            _id: postId,
            adminEmail: req.user.adminEmail
        });

        if (!post) {
            return res.status(404).json({
                error: 'Post not found',
                message: 'Social post not found or you do not have permission to view it'
            });
        }

        res.json({
            success: true,
            post
        });

    } catch (error) {
        console.error('Error getting social post:', error);
        res.status(500).json({
            error: 'Failed to get social post',
            message: error.message
        });
    }
});

/**
 * PUT /api/social/posts/:postId
 * Update social post (only if not yet processed)
 */
router.put('/posts/:postId', validatePrivs, async (req, res) => {
    try {
        const { postId } = req.params;
        const { text, mediaUrl, scheduledFor, timezone } = req.body;

        // Find the post
        const post = await SocialPost.findOne({
            _id: postId,
            adminEmail: req.user.adminEmail
        });

        if (!post) {
            return res.status(404).json({
                error: 'Post not found',
                message: 'Social post not found or you do not have permission to edit it'
            });
        }

        // Check if post can be edited
        if (post.status !== 'scheduled') {
            return res.status(400).json({
                error: 'Cannot edit post',
                message: `Posts with status '${post.status}' cannot be edited. Only 'scheduled' posts can be modified.`
            });
        }

        // Prepare updates and validate content
        const updates = {};
        
        // Determine final content state after updates
        let finalText = post.content.text; // Start with existing values
        let finalMediaUrl = post.content.mediaUrl;
        
        if (text !== undefined) {
            finalText = text ? text.trim() : ''; // Allow empty string, validation happens later
            updates['content.text'] = finalText;
        }

        if (mediaUrl !== undefined) {
            finalMediaUrl = mediaUrl && mediaUrl.trim().length > 0 ? mediaUrl.trim() : null;
            updates['content.mediaUrl'] = finalMediaUrl;
        }

        // Validation - require either text OR media in final state
        const hasText = finalText && finalText.length > 0;
        const hasMedia = finalMediaUrl && finalMediaUrl.length > 0;
        
        if (!hasText && !hasMedia) {
            return res.status(400).json({
                error: 'Missing content',
                message: 'Either text or media URL is required'
            });
        }

        if (scheduledFor !== undefined) {
            updates.scheduledFor = new Date(scheduledFor);
        }

        if (timezone !== undefined) {
            updates.timezone = timezone;
        }

        // Update the post
        const updatedPost = await SocialPost.findByIdAndUpdate(
            post._id,
            { $set: updates },
            { new: true }
        );

        res.json({
            success: true,
            message: 'Social post updated successfully',
            post: updatedPost
        });

    } catch (error) {
        console.error('Error updating social post:', error);
        res.status(500).json({
            error: 'Failed to update social post',
            message: error.message
        });
    }
});

/**
 * DELETE /api/social/posts/:postId
 * Cancel/delete social post
 */
router.delete('/posts/:postId', validatePrivs, async (req, res) => {
    try {
        const { postId } = req.params;

        const post = await SocialPost.findOne({
            _id: postId,
            adminEmail: req.user.adminEmail
        });

        if (!post) {
            return res.status(404).json({
                error: 'Post not found',
                message: 'Social post not found or you do not have permission to delete it'
            });
        }

        // Check if post can be deleted/cancelled
        if (post.status === 'posted') {
            return res.status(400).json({
                error: 'Cannot delete posted content',
                message: 'Posts that have already been posted cannot be deleted'
            });
        }

        // If processing, mark as cancelled, otherwise delete
        if (post.status === 'processing') {
            await SocialPost.findByIdAndUpdate(post._id, {
                status: 'cancelled',
                error: 'Cancelled by user'
            });

            res.json({
                success: true,
                message: 'Social post cancelled successfully'
            });
        } else {
            await SocialPost.findByIdAndDelete(post._id);
            
            res.json({
                success: true,
                message: 'Social post deleted successfully'
            });
        }

    } catch (error) {
        console.error('Error deleting social post:', error);
        res.status(500).json({
            error: 'Failed to delete social post',
            message: error.message
        });
    }
});

/**
 * POST /api/social/posts/:postId/retry
 * Retry failed social post
 */
router.post('/posts/:postId/retry', validatePrivs, async (req, res) => {
    try {
        const { postId } = req.params;

        const post = await SocialPost.findOne({
            _id: postId,
            adminEmail: req.user.adminEmail
        });

        if (!post) {
            return res.status(404).json({
                error: 'Post not found',
                message: 'Social post not found or you do not have permission to retry it'
            });
        }

        // Check if post can be retried
        if (post.status !== 'failed') {
            return res.status(400).json({
                error: 'Cannot retry post',
                message: `Posts with status '${post.status}' cannot be retried. Only 'failed' posts can be retried.`
            });
        }

        // Check retry limit
        if (post.attemptCount >= post.maxAttempts) {
            return res.status(400).json({
                error: 'Max retries exceeded',
                message: `Post has already been attempted ${post.attemptCount} times (max: ${post.maxAttempts})`
            });
        }

        // Reset for retry
        await SocialPost.findByIdAndUpdate(post._id, {
            status: 'scheduled',
            error: null,
            nextRetryAt: null,
            scheduledFor: new Date() // Schedule for immediate processing
        });

        res.json({
            success: true,
            message: 'Social post queued for retry'
        });

    } catch (error) {
        console.error('Error retrying social post:', error);
        res.status(500).json({
            error: 'Failed to retry social post',
            message: error.message
        });
    }
});

/**
 * GET /api/social/stats
 * Get social posting statistics for user
 */
router.get('/stats', validatePrivs, async (req, res) => {
    try {
        const pipeline = [
            { $match: { adminEmail: req.user.adminEmail } },
            {
                $group: {
                    _id: { status: '$status', platform: '$platform' },
                    count: { $sum: 1 }
                }
            },
            {
                $group: {
                    _id: '$_id.status',
                    platforms: {
                        $push: {
                            platform: '$_id.platform',
                            count: '$count'
                        }
                    },
                    total: { $sum: '$count' }
                }
            }
        ];

        const stats = await SocialPost.aggregate(pipeline);

        // Format the response
        const formattedStats = {};
        stats.forEach(stat => {
            formattedStats[stat._id] = {
                total: stat.total,
                platforms: {}
            };
            stat.platforms.forEach(p => {
                formattedStats[stat._id].platforms[p.platform] = p.count;
            });
        });

        res.json({
            success: true,
            stats: formattedStats
        });

    } catch (error) {
        console.error('Error getting social post stats:', error);
        res.status(500).json({
            error: 'Failed to get social post stats',
            message: error.message
        });
    }
});

module.exports = router;
