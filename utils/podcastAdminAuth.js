const jwt = require('jsonwebtoken');
const { ProPodcastDetails } = require('../models/ProPodcastDetails');

/**
 * Middleware to verify if the user is authorized to access podcast admin features
 * Checks if the user has a valid JWT token and is the admin of the specified feed
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 * @param {string} feedId - Optional feedId to check against. If not provided, will be taken from req.params
 * @returns {Promise<void>}
 */
async function verifyPodcastAdmin(req, res, next, feedId = null) {
    try {
        // Get the authorization header
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

        // Get the admin email from the token
        const { email } = decoded;
        if (!email) {
            return res.status(401).json({
                error: 'Invalid token',
                details: 'Token missing email claim'
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

        // Check if the user is the admin of the podcast
        const podcast = await ProPodcastDetails.findOne({
            feedId: targetFeedId,
            adminEmail: email
        }).lean();

        if (!podcast) {
            return res.status(403).json({
                error: 'Unauthorized',
                details: 'You are not authorized to access this podcast\'s data'
            });
        }

        // Add the verified admin info to the request object
        req.admin = {
            email,
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