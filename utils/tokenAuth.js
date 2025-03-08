const jwt = require('jsonwebtoken');

/**
 * Middleware to verify JWT token and extract email
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 * @returns {Promise<void>}
 */
async function verifyToken(req, res, next) {
    try {
        // Development bypass - MUST be explicitly set to 'bypass'
        const bypassAuth = process.env.BYPASS_PODCAST_ADMIN_AUTH === 'bypass';
        if (bypassAuth) {
            console.warn('⚠️ WARNING: Bypassing token authentication - FOR DEVELOPMENT ONLY');
            // Allow email override in bypass mode via query parameter
            const bypassEmail = req.query.email;
            if (bypassEmail) {
                console.log('Using bypass email:', bypassEmail);
                req.user = { email: bypassEmail };
                return next();
            }
            // Default bypass email if none provided
            req.user = { email: 'dev@bypass.local' };
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

        // Get the email from the token
        const { email } = decoded;
        if (!email) {
            return res.status(401).json({
                error: 'Invalid token',
                details: 'Token missing email claim'
            });
        }

        // Add the verified email to the request object
        req.user = { email };
        next();
    } catch (error) {
        console.error('Error in token authentication:', error);
        return res.status(500).json({
            error: 'Internal server error',
            details: 'Error processing authentication'
        });
    }
}

module.exports = {
    verifyToken
}; 