const { getProPodcastByAdminEmail } = require('../utils/ProPodcastUtils');
const jwt = require('jsonwebtoken');

/**
 * Middleware to validate podcast admin privileges using bearer token
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
        
        // Get the podcast details using the email from the token
        const podcast = await getProPodcastByAdminEmail(decoded.email);
        
        if (!podcast) {
            return res.status(401).json({ 
                error: 'Not authorized',
                message: 'No podcast found for this admin email'
            });
        }

        // Add the podcast to the request for use in routes
        req.user = {
            adminEmail: decoded.email,
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