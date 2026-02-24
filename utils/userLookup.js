const { User } = require('../models/shared/UserSchema');

/**
 * Find user by req.user (supports email OR provider-based auth).
 * Works with Twitter, Nostr, and email-based users.
 */
async function findUserFromRequest(req, selectFields = '') {
  if (req.user.email) {
    return User.findOne({ email: req.user.email }).select(selectFields);
  } else if (req.user.provider && req.user.providerId) {
    return User.findOne({
      'authProvider.provider': req.user.provider,
      'authProvider.providerId': req.user.providerId
    }).select(selectFields);
  } else if (req.user.id) {
    return User.findById(req.user.id).select(selectFields);
  }
  return null;
}

/**
 * Build a Mongoose query filter from req.user (supports email OR provider-based auth).
 */
function buildUserFilter(req) {
  if (req.user.email) {
    return { email: req.user.email };
  } else if (req.user.provider && req.user.providerId) {
    return {
      'authProvider.provider': req.user.provider,
      'authProvider.providerId': req.user.providerId
    };
  } else if (req.user.id) {
    return { _id: req.user.id };
  }
  return null;
}

module.exports = { findUserFromRequest, buildUserFilter };
