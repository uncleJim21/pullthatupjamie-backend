/**
 * User Model
 * 
 * Re-exports from shared/UserSchema.js for backwards compatibility.
 * See shared/UserSchema.js for the full schema definition.
 * 
 * IMPORTANT: When modifying the User schema, edit shared/UserSchema.js
 * and sync it to the auth server (cascdr-backend).
 */

const { User, UserSchema, AuthProviderSchema, PinnedMentionSchema } = require('./shared/UserSchema');

module.exports = { 
  User, 
  UserSchema, 
  AuthProviderSchema, 
  PinnedMentionSchema 
};
