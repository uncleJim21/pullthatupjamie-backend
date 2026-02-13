/**
 * Identity Resolver
 * 
 * Resolves incoming requests to a user identity and tier.
 * Handles both new JWT format (sub, provider, email) and legacy (email only).
 */

const jwt = require('jsonwebtoken');
const { User } = require('../models/shared/UserSchema');
// NOTE: ProPodcastDetails is NOT used for tier/quota determination
// Subscription type (User.subscriptionType) is the sole source of truth for quotas

/**
 * Tier definitions with quota multipliers
 */
const TIERS = {
  anonymous: 'anonymous',     // No auth, IP-based tracking
  registered: 'registered',   // Has account, no subscription
  subscriber: 'subscriber',   // Paid subscription (amber, jamie-pro)
  admin: 'admin'              // Podcast admin (virtually unlimited)
};

/**
 * Resolve identity from request
 * 
 * @param {Request} req - Express request object
 * @returns {Promise<{
 *   tier: string,
 *   identifier: string,
 *   identifierType: 'user' | 'ip',
 *   user: User | null,
 *   provider: string | null,
 *   email: string | null
 * }>}
 */
async function resolveIdentity(req) {
  const authHeader = req.headers.authorization;
  
  // No auth header → anonymous (IP-based)
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      tier: TIERS.anonymous,
      identifier: getClientIp(req),
      identifierType: 'ip',
      user: null,
      provider: null,
      email: null
    };
  }
  
  const token = authHeader.split(' ')[1];
  
  // Special case: explicit no-token
  if (token === 'no-token') {
    return {
      tier: TIERS.anonymous,
      identifier: getClientIp(req),
      identifierType: 'ip',
      user: null,
      provider: null,
      email: null
    };
  }
  
  try {
    // Verify JWT
    const payload = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
    
    // Try to find user
    let user = null;
    let provider = null;
    let email = null;
    
    // New JWT format: { sub, provider, email }
    if (payload.sub && payload.provider) {
      provider = payload.provider;
      email = payload.email || null;
      
      // Look up by authProvider
      user = await User.findByAuthProvider(payload.provider, payload.sub);
      
      // Fallback: if not found by provider, try email (migration period)
      if (!user && payload.email) {
        user = await User.findByEmail(payload.email);
      }
    }
    // Legacy JWT format: { email }
    else if (payload.email) {
      email = payload.email;
      provider = 'email'; // Assume email provider for legacy
      user = await User.findByEmail(payload.email);
    }
    
    // No user found
    if (!user) {
      console.warn(`[IDENTITY] JWT valid but user not found: ${JSON.stringify(payload)}`);
      return {
        tier: TIERS.anonymous,
        identifier: getClientIp(req),
        identifierType: 'ip',
        user: null,
        provider: provider,
        email: email
      };
    }
    
    // Determine tier from user
    const tier = await determineTier(user);
    
    return {
      tier,
      identifier: user._id.toString(),
      identifierType: 'mongoUserId',
      user,
      provider: user.authProvider?.provider || provider,
      email: user.email || email
    };
    
  } catch (error) {
    // JWT verification failed
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      console.warn(`[IDENTITY] JWT error: ${error.message}`);
    } else {
      console.error(`[IDENTITY] Unexpected error:`, error);
    }
    
    return {
      tier: TIERS.anonymous,
      identifier: getClientIp(req),
      identifierType: 'ip',
      user: null,
      provider: null,
      email: null
    };
  }
}

/**
 * Determine user tier based on subscription status
 * 
 * NOTE: Being in ProPodcastDetails does NOT grant admin tier for quotas.
 * The subscription type is the source of truth for quota limits.
 * ProPodcastDetails association only determines access to podcast admin features.
 * 
 * @param {User} user
 * @returns {Promise<string>}
 */
async function determineTier(user) {
  // Check subscription type - this is the source of truth for quota limits
  if (user.subscriptionType === 'jamie-pro') {
    // jamie-pro is the $50 podcast admin tier → unlimited quotas
    return TIERS.admin;
  }
  
  if (user.subscriptionType === 'amber') {
    // amber is the $9.99 subscriber tier → elevated quotas
    return TIERS.subscriber;
  }
  
  // Has account but no subscription → registered tier quotas
  return TIERS.registered;
}

/**
 * Get client IP address from request
 * 
 * @param {Request} req
 * @returns {string}
 */
function getClientIp(req) {
  // Check various headers for proxied requests
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for can be comma-separated list
    return forwarded.split(',')[0].trim();
  }
  
  return req.headers['x-real-ip'] || 
         req.connection?.remoteAddress || 
         req.socket?.remoteAddress ||
         req.ip ||
         'unknown';
}

/**
 * Quick check if request has valid auth (doesn't resolve full identity)
 * 
 * @param {Request} req
 * @returns {boolean}
 */
function hasValidAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  
  const token = authHeader.split(' ')[1];
  if (token === 'no-token') {
    return false;
  }
  
  try {
    jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  resolveIdentity,
  determineTier,
  getClientIp,
  hasValidAuth,
  TIERS
};
