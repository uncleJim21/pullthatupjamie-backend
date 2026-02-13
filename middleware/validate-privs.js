const { getProPodcastByAdmin } = require('../utils/ProPodcastUtils');
const { User } = require('../models/shared/UserSchema');
const jwt = require('jsonwebtoken');

/**
 * Middleware to validate podcast admin privileges using bearer token
 * 
 * Supports both:
 * - New JWT format: { sub, provider, email } → looks up by adminUserId
 * - Legacy JWT format: { email } → looks up by adminEmail
 */
const validatePrivs = async (req, res, next) => {
    try {
        // Get the bearer token from the Authorization header
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ 
                error: 'Not authenticated',
                message: 'Bearer token required'
            });
        }

        const token = authHeader.split(' ')[1];
        
        // Verify the JWT token
        const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
        
        // Resolve user identity (supports both email and provider-based JWTs)
        let dbUser = null;
        let adminUserId = null;
        let adminEmail = decoded.email || null;
        
        // New JWT format: { sub, provider }
        if (decoded.sub && decoded.provider) {
            dbUser = await User.findOne({
                'authProvider.provider': decoded.provider,
                'authProvider.providerId': decoded.sub
            }).select('_id email');
            
            if (dbUser) {
                adminUserId = dbUser._id;
                adminEmail = adminEmail || dbUser.email;
            }
        }
        // Legacy JWT format: { email }
        else if (decoded.email) {
            dbUser = await User.findOne({ email: decoded.email }).select('_id');
            if (dbUser) {
                adminUserId = dbUser._id;
            }
        }
        
        if (!adminUserId && !adminEmail) {
            return res.status(401).json({ 
                error: 'Not authenticated',
                message: 'Could not identify user from token'
            });
        }
        
        // Get the podcast details using the new helper (supports both userId and email)
        const podcast = await getProPodcastByAdmin({ userId: adminUserId, email: adminEmail });
        
        if (!podcast) {
            return res.status(401).json({ 
                error: 'Not authorized',
                message: 'No podcast found for this admin'
            });
        }

        // Add the podcast to the request for use in routes
        req.user = {
            adminUserId,       // NEW: For non-email users
            adminEmail,
            podcast
        };

        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ 
                error: 'Invalid token',
                message: 'The provided token is invalid'
            });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ 
                error: 'Token expired',
                message: 'The provided token has expired'
            });
        }
        
        console.error('Error validating privileges:', error);
        res.status(500).json({ 
            error: 'Failed to validate privileges',
            message: error.message
        });
    }
};

module.exports = {
    validatePrivs
}; 