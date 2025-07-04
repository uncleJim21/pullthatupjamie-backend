const jwt = require('jsonwebtoken');
const { User } = require('../models/User');

/**
 * Middleware to authenticate JWT token and extract user information
 * Sets req.user with user data including id, email, and other user fields
 */
async function authenticateToken(req, res, next) {
  try {
    // Check for bypass auth (development only)
    const bypassAuth = process.env.BYPASS_PODCAST_ADMIN_AUTH === 'bypass';
    if (bypassAuth) {
      console.warn('⚠️ WARNING: Bypassing token authentication - FOR DEVELOPMENT ONLY');
      // Set a default user for development
      req.user = {
        id: 'dev_user_id',
        email: 'dev@example.com'
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
    } catch (jwtError) {
      return res.status(401).json({
        error: 'Invalid token',
        details: 'Token verification failed'
      });
    }

    // Get the email from the token
    const email = decoded.email;
    if (!email) {
      return res.status(401).json({
        error: 'Invalid token',
        details: 'Token missing email claim'
      });
    }

    // Find the user in the database
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({
        error: 'User not found',
        details: 'No user found with the provided email'
      });
    }

    // Set user information in request object
    req.user = {
      id: user._id,
      email: user.email,
      username: user.username,
      isPro: user.isPro,
      // Add other user fields as needed
    };

    next();
  } catch (error) {
    console.error('Error in token authentication:', error);
    return res.status(500).json({
      error: 'Authentication error',
      details: 'Error processing authentication'
    });
  }
}

module.exports = {
  authenticateToken
}; 