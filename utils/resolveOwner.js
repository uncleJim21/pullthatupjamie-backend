const jwt = require('jsonwebtoken');
const { User } = require('../models/User');

/**
 * Resolve the logical owner of a research request.
 * - Prefer authenticated User (via JWT Bearer token)
 * - Fallback to anonymous clientId (from query, header, or body)
 *
 * Supports new JWT format with provider/sub for non-email auth (e.g., Nostr):
 *   { sub: "npub1...", provider: "nostr", email: null }
 *
 * Returns:
 *   { userId, clientId, ownerType } or null if no owner can be resolved
 */
async function resolveOwner(req) {
  let userId = null;

  // Try to resolve authenticated user from JWT (if provided)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
      
      // Try multiple strategies to find the user:
      // 1. By email (traditional auth)
      // 2. By provider + providerId (Nostr, Twitter/X, etc.)
      
      const email = decoded?.email;
      const provider = decoded?.provider;
      const providerId = decoded?.sub;
      
      let user = null;
      
      // Strategy 1: Find by email (if present)
      if (email) {
        user = await User.findOne({ email }).select('_id');
      }
      
      // Strategy 2: Find by authProvider (for Nostr, Twitter/X, etc.)
      if (!user && provider && providerId) {
        user = await User.findOne({
          'authProvider.provider': provider,
          'authProvider.providerId': providerId
        }).select('_id');
      }
      
      if (user) {
        userId = user._id;
      }
    } catch (err) {
      console.warn('[resolveOwner] Failed to verify JWT, treating as anonymous:', err.message);
    }
  }

  // Accept clientId for anonymous usage
  const clientId =
    (req.query && req.query.clientId) ||
    req.headers['x-client-id'] ||
    (req.body && req.body.clientId) ||
    null;

  if (userId) {
    return { userId, clientId: null, ownerType: 'user' };
  }
  if (clientId) {
    return { userId: null, clientId, ownerType: 'client' };
  }

  return null;
}

module.exports = { resolveOwner };

