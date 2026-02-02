const jwt = require('jsonwebtoken');
const { User } = require('../models/shared/UserSchema');

/**
 * Resolve the logical owner of a research request.
 * 
 * Returns BOTH userId and clientId when available to support:
 * - Querying by both (user sees anonymous sessions after signup)
 * - Lazy migration of clientId sessions to userId
 *
 * Supports new JWT format with provider/sub for non-email auth (e.g., Nostr):
 *   { sub: "npub1...", provider: "nostr", email: null }
 *
 * Returns:
 *   { userId, clientId, ownerType, buildQuery, isAuthenticated } or null if no owner
 * 
 * ownerType: 'user' (has JWT) | 'client' (anonymous with clientId)
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

  // Accept clientId for anonymous usage (always extract, even with JWT)
  const clientId =
    (req.query && req.query.clientId) ||
    req.headers['x-client-id'] ||
    (req.body && req.body.clientId) ||
    null;

  // Must have at least one identifier
  if (!userId && !clientId) {
    return null;
  }

  const isAuthenticated = !!userId;
  const ownerType = isAuthenticated ? 'user' : 'client';

  return {
    userId,
    clientId,
    ownerType,
    isAuthenticated,
    
    /**
     * Build a MongoDB query to find documents owned by this user.
     * For authenticated users with clientId: queries BOTH to capture anonymous sessions.
     * @param {object} additionalCriteria - Extra query fields (e.g., { _id: sessionId })
     */
    buildQuery(additionalCriteria = {}) {
      if (userId && clientId) {
        // Authenticated user with clientId: query both to find anonymous sessions
        return {
          $or: [{ userId }, { clientId }],
          ...additionalCriteria
        };
      } else if (userId) {
        // Authenticated user without clientId: query by userId only
        return { userId, ...additionalCriteria };
      } else {
        // Anonymous user: query by clientId only
        return { clientId, ...additionalCriteria };
      }
    }
  };
}

/**
 * Lazily migrate documents from clientId ownership to userId ownership.
 * Call this after fetching documents for an authenticated user.
 * 
 * @param {Model} Model - Mongoose model (e.g., ResearchSession)
 * @param {object} owner - Owner object from resolveOwner()
 * @param {Array} docs - Documents that were fetched (to check if any need migration)
 */
async function lazyMigrateOwnership(Model, owner, docs) {
  if (!owner.isAuthenticated || !owner.clientId || !docs?.length) {
    return; // Nothing to migrate
  }

  // Find docs that still have clientId but no userId
  const docsNeedingMigration = docs.filter(doc => 
    doc.clientId === owner.clientId && !doc.userId
  );

  if (docsNeedingMigration.length === 0) {
    return;
  }

  const idsToMigrate = docsNeedingMigration.map(d => d._id);
  
  try {
    const result = await Model.updateMany(
      { _id: { $in: idsToMigrate } },
      { 
        $set: { userId: owner.userId },
        $unset: { clientId: 1 }
      }
    );
    
    console.log(`[resolveOwner] Lazy migrated ${result.modifiedCount} documents from clientId to userId`);
  } catch (err) {
    // Non-fatal: log and continue
    console.error('[resolveOwner] Lazy migration failed:', err.message);
  }
}

module.exports = { resolveOwner, lazyMigrateOwnership };
