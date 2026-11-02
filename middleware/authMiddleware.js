const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { User } = require('../models/shared/UserSchema');

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

    // Find user by email OR by provider/sub (for Twitter, Nostr, etc.)
    const { email, provider, sub } = decoded;
    
    let user;
    
    if (email) {
      // Traditional email-based lookup
      user = await User.findOne({ email });
    } else if (provider && sub) {
      // Provider-based lookup (Twitter, Nostr, etc.)
      user = await User.findOne({
        'authProvider.provider': provider,
        'authProvider.providerId': sub
      });
    } else {
      return res.status(401).json({
        error: 'Invalid token',
        details: 'Token missing required claims (email or provider/sub)'
      });
    }

    if (!user) {
      return res.status(401).json({
        error: 'User not found',
        details: email 
          ? 'No user found with the provided email'
          : `No user found for provider ${provider}`
      });
    }

    // Set user information in request object
    req.user = {
      id: user._id,
      email: user.email,  // May be null for Nostr/Twitter users
      username: user.username,
      isPro: user.isPro,
      provider: user.authProvider?.provider,
      providerId: user.authProvider?.providerId,
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

/**
 * Shared-secret gate for admin/debug routes. Compares the `x-admin-key` header
 * (or `?adminKey=` for quick curl checks) against ADMIN_API_KEY in constant
 * time. Fails closed: if ADMIN_API_KEY is unset the routes are unreachable,
 * so a stray DEBUG_MODE=true in production exposes nothing.
 */
function requireAdminKey(req, res, next) {
  const expected = process.env.ADMIN_API_KEY || '';
  if (!expected) {
    return res.status(503).json({ error: 'Admin routes disabled: ADMIN_API_KEY is not configured' });
  }
  const provided = String(req.headers['x-admin-key'] || req.query.adminKey || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

module.exports = {
  authenticateToken,
  requireAdminKey
};
