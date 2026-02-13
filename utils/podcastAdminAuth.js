const jwt = require('jsonwebtoken');
const { ProPodcastDetails } = require('../models/ProPodcastDetails');
const { User } = require('../models/shared/UserSchema');

/**
 * Core podcast admin verification logic.
 * 
 * Supports both:
 * - New JWT format: { sub, provider, email } → looks up by adminUserId
 * - Legacy JWT format: { email } → looks up by adminEmail
 * 
 * Two modes:
 * 1. With feedId (from URL params): Verifies user is admin of THAT specific podcast
 * 2. Without feedId: Finds ANY podcast the user is admin of (for routes like /list-uploads)
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 * @param {Object} options - Configuration options
 * @param {string} options.feedId - Optional feedId to check against (overrides req.params.feedId)
 * @param {boolean} options.requireFeedId - If true, requires feedId in URL (default: false)
 * @returns {Promise<void>}
 */
async function verifyPodcastAdminCore(req, res, next, options = {}) {
    try {
        const { feedId: explicitFeedId, requireFeedId = false } = options;
        
        // Development bypass - MUST be explicitly set to 'bypass'
        const bypassAuth = process.env.BYPASS_PODCAST_ADMIN_AUTH === 'bypass';
        if (bypassAuth) {
            console.warn('⚠️ WARNING: Bypassing podcast admin authentication - FOR DEVELOPMENT ONLY');
            const targetFeedId = explicitFeedId || req.params.feedId || 'bypass-feed';
            req.admin = {
                email: 'dev@bypass.local',
                userId: null,
                feedId: targetFeedId,
                podcast: { feedId: targetFeedId }
            };
            req.podcastAdmin = req.admin; // Alias for compatibility
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

        // Get the feedId from params if not explicitly provided
        const targetFeedId = explicitFeedId || req.params.feedId || null;
        
        // If feedId is required but not present, error
        if (requireFeedId && !targetFeedId) {
            return res.status(400).json({
                error: 'Missing feed ID',
                details: 'Feed ID is required in URL'
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

        // Build the query for ProPodcastDetails
        // Supports both adminUserId and adminEmail
        const query = { $or: [] };
        
        if (userId) {
            query.$or.push({ adminUserId: userId });
        }
        if (email) {
            query.$or.push({ adminEmail: email });
        }
        
        // If feedId is specified, also filter by it
        if (targetFeedId) {
            query.feedId = targetFeedId;
        }

        const podcast = await ProPodcastDetails.findOne(query).lean();

        if (!podcast) {
            return res.status(403).json({
                error: 'Unauthorized',
                details: targetFeedId 
                    ? 'You are not authorized to access this podcast\'s data'
                    : 'You are not registered as a podcast admin'
            });
        }

        // Add the verified admin info to the request object
        const adminInfo = {
            userId,
            email,
            provider,
            feedId: podcast.feedId,
            podcast
        };
        
        req.admin = adminInfo;
        req.podcastAdmin = adminInfo; // Alias for compatibility with existing routes

        next();
    } catch (error) {
        console.error('Error in podcast admin authentication:', error);
        return res.status(500).json({
            error: 'Internal server error',
            details: 'Error processing authentication'
        });
    }
}

/**
 * Standard middleware for routes WITH feedId in URL params.
 * Use this for routes like: /:feedId/recent, /:feedId/run/:runId
 * 
 * Usage: router.get('/:feedId/recent', verifyPodcastAdmin, handler)
 */
function verifyPodcastAdmin(req, res, next) {
    return verifyPodcastAdminCore(req, res, next, { requireFeedId: true });
}

/**
 * Standard middleware for routes WITHOUT feedId in URL.
 * Finds any podcast the user is admin of.
 * Use this for routes like: /list-uploads, /automation-settings
 * 
 * Usage: router.get('/list-uploads', verifyPodcastAdminAuto, handler)
 */
function verifyPodcastAdminAuto(req, res, next) {
    return verifyPodcastAdminCore(req, res, next, { requireFeedId: false });
}

/**
 * Factory function to create middleware with custom options.
 * 
 * Usage: router.get('/route', createPodcastAdminMiddleware({ feedId: 'custom' }), handler)
 */
function createPodcastAdminMiddleware(options = {}) {
    return (req, res, next) => verifyPodcastAdminCore(req, res, next, options);
}

module.exports = {
    verifyPodcastAdmin,           // For routes WITH :feedId in URL
    verifyPodcastAdminAuto,       // For routes WITHOUT feedId (auto-detect)
    createPodcastAdminMiddleware, // Factory for custom options
    verifyPodcastAdminCore        // Core function (for advanced use)
};
