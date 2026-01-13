const jwt = require('jsonwebtoken');
const { User } = require('../models/User');

/**
 * Resolve the logical owner of a research request.
 * - Prefer authenticated User (via JWT Bearer token)
 * - Fallback to anonymous clientId (from query, header, or body)
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
      const email = decoded?.email;
      if (email) {
        const user = await User.findOne({ email }).select('_id');
        if (user) {
          userId = user._id;
        }
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

