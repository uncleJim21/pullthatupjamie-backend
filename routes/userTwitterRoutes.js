const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { postTweetCore } = require('../utils/twitterPostingService');

/**
 * Find user by req.user (supports email OR provider-based auth)
 * Pattern from userSocialPostRoutes.js
 */
async function findUserFromRequest(req, selectFields = '') {
  const { User } = require('../models/shared/UserSchema');
  
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
 * POST /api/user/twitter/tweet
 * Post tweet for authenticated user (no podcast required)
 */
router.post('/tweet', authenticateToken, async (req, res) => {
    try {
        const { text, mediaUrl } = req.body;
        
        // Get user
        const user = await findUserFromRequest(req, '_id email');
        if (!user) {
            return res.status(400).json({ error: 'User not found' });
        }
        
        const identity = {
            userId: user._id,
            email: user.email
        };
        
        const result = await postTweetCore(identity, { text, mediaUrl });
        res.json(result);

    } catch (error) {
        console.error('Error posting tweet:', error);
        
        // Handle Twitter auth expiration
        if (error.code === 'TWITTER_AUTH_EXPIRED' || error.requiresReauth) {
            return res.status(401).json({
                error: 'TWITTER_AUTH_EXPIRED',
                requiresReauth: true,
                message: error.message || 'Twitter authentication expired'
            });
        }
        
        res.status(500).json({
            error: 'Failed to post tweet',
            message: error.message
        });
    }
});

module.exports = router;
