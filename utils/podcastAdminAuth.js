const jwt = require('jsonwebtoken');
const { ProPodcastDetails } = require('../models/ProPodcastDetails');
const { User } = require('../models/shared/UserSchema');

/**
 * Middleware to verify if the user is authorized to access podcast admin features
 * Checks if the user has a valid JWT token and is the admin of the specified feed
 * 
 * Supports both:
 * - New JWT format: { sub, provider, email } → looks up by adminUserId
 * - Legacy JWT format: { email } → looks up by adminEmail
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 * @param {string} feedId - Optional feedId to check against. If not provided, will be taken from req.params
 * @returns {Promise<void>}
 */
async function verifyPodcastAdmin(req, res, next, feedId = null) {
    try {
        // Development bypass - MUST be explicitly set to 'bypass'
        const bypassAuth = process.env.BYPASS_PODCAST_ADMIN_AUTH === 'bypass';
        if (bypassAuth) {
            console.warn('⚠️ WARNING: Bypassing podcast admin authentication - FOR DEVELOPMENT ONLY');
            // Still require feedId for proper routing
            const targetFeedId = feedId || req.params.feedId;
            if (!targetFeedId) {
                return res.status(400).json({
                    error: 'Missing feed ID',
                    details: 'Feed ID is required even in bypass mode'
                });
            }
            // Add mock admin info
            req.admin = {
                email: 'dev@bypass.local',
                feedId: targetFeedId,
                podcast: { feedId: targetFeedId }
            };
            return next();
        }

        // Normal authentication flow
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Authentication required',
                details: 'Missing or invalid authorization header'
            });
        }

        // Extract and verify the JWT token
        const token = authHeader.split(' ')[1];
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
        } catch (err) {
            return res.status(401).json({
                error: 'Invalid token',
                details: 'Token verification failed'
            });
        }

        // Get the feedId from params if not provided
        const targetFeedId = feedId || req.params.feedId;
        if (!targetFeedId) {
            return res.status(400).json({
                error: 'Missing feed ID',
                details: 'Feed ID is required'
            });
        }

        // Build identity from JWT (supports both new and legacy formats)
        let userId = null;
        let email = decoded.email || null;
        const provider = decoded.provider || null;
        const sub = decoded.sub || null;

        // New JWT format: { sub, provider, email }
        if (sub && provider) {
            // Look up User to get MongoDB _id
            const user = await User.findOne({
                'authProvider.provider': provider,
                'authProvider.providerId': sub
            }).select('_id email').lean();
            
            if (user) {
                userId = user._id;
                email = email || user.email; // Use email from user if not in JWT
            }
        }
        // Legacy JWT format: { email } - also get userId if possible
        else if (email) {
            const user = await User.findOne({ email }).select('_id').lean();
            if (user) {
                userId = user._id;
            }
        }

        // Must have at least one identifier
        if (!userId && !email) {
            return res.status(401).json({
                error: 'Invalid token',
                details: 'Token missing user identifier'
            });
        }

        // Check if the user is the admin of the podcast (supports both adminUserId and adminEmail)
        const query = {
            feedId: targetFeedId,
            $or: []
        };
        
        if (userId) {
            query.$or.push({ adminUserId: userId });
        }
        if (email) {
            query.$or.push({ adminEmail: email });
        }

        const podcast = await ProPodcastDetails.findOne(query).lean();

        if (!podcast) {
            return res.status(403).json({
                error: 'Unauthorized',
                details: 'You are not authorized to access this podcast\'s data'
            });
        }

        // Add the verified admin info to the request object
        req.admin = {
            userId,
            email,
            provider,
            feedId: targetFeedId,
            podcast
        };

        next();
    } catch (error) {
        console.error('Error in podcast admin authentication:', error);
        return res.status(500).json({
            error: 'Internal server error',
            details: 'Error processing authentication'
        });
    }
}

module.exports = {
    verifyPodcastAdmin
}; 