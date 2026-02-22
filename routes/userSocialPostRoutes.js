const express = require('express');
const router = express.Router();
const SocialPost = require('../models/SocialPost');
const { User } = require('../models/shared/UserSchema');
const { authenticateToken } = require('../middleware/authMiddleware');
const { schedulePosts } = require('../utils/SocialPostService');

/**
 * Find user by req.user (supports email OR provider-based auth)
 * Works with Twitter, Nostr, and email-based users
 */
async function findUserFromRequest(req, selectFields = '') {
  if (req.user.email) {
    return User.findOne({ email: req.user.email }).select(selectFields);
  } else if (req.user.provider && req.user.providerId) {
    return User.findOne({
      'authProvider.provider': req.user.provider,
      'authProvider.providerId': req.user.providerId
    }).select(selectFields);
  } else if (req.user.id) {
    return User.findById(req.user.id).select(selectFields);
  }
  return null;
}

/**
 * Build query filter from req.user (supports email OR provider-based auth)
 */
function buildUserFilter(req) {
  if (req.user.email) {
    return { email: req.user.email };
  } else if (req.user.provider && req.user.providerId) {
    return {
      'authProvider.provider': req.user.provider,
      'authProvider.providerId': req.user.providerId
    };
  } else if (req.user.id) {
    return { _id: req.user.id };
  }
  return null;
}

/**
 * POST /api/user/social/posts
 * Create scheduled posts for authenticated user (no podcast required)
 */
router.post('/posts', authenticateToken, async (req, res) => {
    try {
        const { text, mediaUrl, scheduledFor, platforms, timezone = 'America/Chicago', platformData, scheduledPostSlotId } = req.body;
        
        // Validate content - either text or media required
        const hasText = !!(text && String(text).trim().length > 0);
        const hasMedia = !!(mediaUrl && String(mediaUrl).trim().length > 0);
        
        if (!hasText && !hasMedia) {
            return res.status(400).json({ 
                error: 'Content required',
                message: 'Either text or media URL must be provided' 
            });
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
            scheduledPostSlotId
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
        res.status(500).json({
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
            // Merge platformData (important for adding Nostr signatures to unsigned posts)
            post.platformData = { ...post.platformData, ...platformData };
            
            // If we're adding a Nostr signature to an unsigned post, change status to scheduled
            if (post.status === 'unsigned' && platformData.nostrSignature) {
                post.status = 'scheduled';
            }
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
        res.status(500).json({
            error: 'Failed to update post',
            message: error.message
        });
    }
});

module.exports = router;
