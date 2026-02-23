const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { postTweetCore } = require('../utils/twitterPostingService');
const { TwitterApi } = require('twitter-api-v2');
const crypto = require('crypto');

// Get the port from environment variables
const PORT = process.env.PORT || 4132;

// Temporary in-memory store for OAuth state (shared with twitterRoutes)
const oauthStateStore = new Map();

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
 * Manual token verification (for routes that accept token in body)
 * Pattern from twitterRoutes.js /x-oauth
 */
async function verifyTokenManually(req) {
  const jwt = require('jsonwebtoken');
  const { User } = require('../models/shared/UserSchema');
  
  // Get token from either Authorization header or request body
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') 
    ? authHeader.split(' ')[1]
    : req.body?.token;

  if (!token) {
    throw new Error('Bearer token required');
  }

  // Verify the JWT token
  const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
  
  let dbUser = null;
  
  // New JWT format: { sub, provider }
  if (decoded.sub && decoded.provider) {
    dbUser = await User.findOne({
      'authProvider.provider': decoded.provider,
      'authProvider.providerId': decoded.sub
    }).select('_id email');
  }
  // Legacy JWT format: { email }
  else if (decoded.email) {
    dbUser = await User.findOne({ email: decoded.email }).select('_id email');
  }
  
  if (!dbUser) {
    throw new Error('User not found');
  }
  
  return dbUser;
}

/**
 * GET/POST /api/user/twitter/oauth/start
 * Start Twitter OAuth for authenticated user (no podcast required)
 * Pattern from twitterRoutes.js /x-oauth - accepts token in body OR header
 */
router.all('/oauth/start', async (req, res) => {
    try {
        // Verify token manually (accepts from body or header)
        const user = await verifyTokenManually(req);
        if (!user) {
            return res.status(401).json({ 
                error: 'Not authenticated',
                message: 'Could not identify user from token'
            });
        }

        const adminUserId = user._id;
        const adminEmail = user.email;

        console.log('Starting Twitter OAuth for user:', { adminUserId, adminEmail });

        const client = new TwitterApi({
            clientId: process.env.TWITTER_CLIENT_ID,
            clientSecret: process.env.TWITTER_CLIENT_SECRET,
        });

        // Use same callback URL as podcast flow (callback handler is unified)
        const callbackUrl = process.env.TWITTER_CALLBACK_URL || `http://localhost:${PORT}/api/twitter/callback`;
        console.log('Using callback URL:', callbackUrl);

        const { url, codeVerifier, state } = await client.generateOAuth2AuthLink(
            callbackUrl,
            { 
                scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'],
                codeChallengeMethod: 'S256'
            }
        );

        // Store OAuth state in temporary store (same pattern as podcast flow)
        const oauthData = {
            state,
            codeVerifier,
            adminUserId,
            adminEmail,
            flowType: 'userAuth' // Flag to indicate this is user auth (not podcast)
        };

        oauthStateStore.set(state, oauthData);
        
        // Clean up old states (>10 minutes)
        setTimeout(() => {
            oauthStateStore.delete(state);
        }, 10 * 60 * 1000);

        console.log('OAuth URL generated, state stored');
        
        res.json({ 
            authUrl: url,
            state
        });

    } catch (error) {
        console.error('Error starting Twitter OAuth:', error);
        res.status(500).json({
            error: 'Failed to start OAuth',
            message: error.message
        });
    }
});

/**
 * POST /api/user/twitter/tokens
 * Get Twitter token status for authenticated user (no podcast required)
 * Pattern from twitterRoutes.js /tokens but uses authenticateToken
 */
router.post('/tokens', authenticateToken, async (req, res) => {
    try {
        const user = await findUserFromRequest(req, 'twitterTokens');
        if (!user) {
            return res.status(400).json({ error: 'User not found' });
        }
        
        const userTokens = user?.twitterTokens;
        
        // Determine OAuth 2.0 status from User.twitterTokens
        const hasOAuth2 = !!(userTokens?.accessToken);
        const oauth2Expired = userTokens?.expiresAt && Date.now() > new Date(userTokens.expiresAt).getTime();
        const hasRefreshToken = !!(userTokens?.refreshToken);
        
        // Determine OAuth 1.0a status
        const hasOAuth1 = !!(userTokens?.oauth1AccessToken && userTokens?.oauth1AccessSecret);
        
        // Get metadata
        const twitterId = userTokens?.twitterId;
        const twitterUsername = userTokens?.twitterUsername;
        const expiresAt = userTokens?.expiresAt;

        // Not authenticated if missing OAuth 2.0 entirely
        if (!hasOAuth2) {
            return res.json({ 
                authenticated: false,
                capabilities: {
                    canPostText: false,
                    canUploadMedia: false,
                    canRefreshTokens: false
                },
                oauth2Status: 'missing',
                oauth1Status: hasOAuth1 ? 'valid' : 'missing',
                message: 'Please connect your Twitter account to enable posting.'
            });
        }

        res.json({ 
            authenticated: true,
            twitterId,
            twitterUsername,
            capabilities: {
                canPostText: hasOAuth2 && !oauth2Expired,
                canUploadMedia: hasOAuth1,
                canRefreshTokens: hasRefreshToken
            },
            oauth2Status: oauth2Expired ? 'expired' : 'valid',
            oauth1Status: hasOAuth1 ? 'valid' : 'missing',
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            // Helpful messages for frontend
            ...(oauth2Expired && !hasRefreshToken && {
                requiresReauth: true,
                message: 'Your Twitter access has expired. Please re-authenticate.'
            }),
            ...(!hasOAuth1 && {
                requiresMediaAuth: true,
                mediaAuthUrl: '/api/user/twitter/oauth1-auth',
                mediaAuthMessage: 'Media uploads require additional authorization.'
            })
        });
    } catch (error) {
        console.error('Error getting Twitter tokens:', error);
        res.status(500).json({ error: 'Failed to get Twitter tokens' });
    }
});

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
