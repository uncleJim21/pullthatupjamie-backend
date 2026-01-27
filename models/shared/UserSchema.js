/**
 * UNIFIED USER SCHEMA
 * 
 * This file is the single source of truth for the User model.
 * It should be kept in sync between:
 *   - pullthatupjamie-backend (this repo)
 *   - cascdr-backend (auth server)
 * 
 * When modifying this schema, update BOTH repositories.
 * 
 * Collection: 'users' (Mongoose auto-pluralizes 'User' → 'users')
 */

const mongoose = require('mongoose');

// ============================================
// SUB-SCHEMAS
// ============================================

/**
 * Auth Provider Schema
 * Tracks which authentication methods a user has linked.
 * Each user can have ONE provider (no commingling).
 */
const AuthProviderSchema = new mongoose.Schema({
  provider: {
    type: String,
    required: true,
    enum: [
      'email',      // Traditional email/password (current "cascdr" auth)
      'google',     // Google OAuth
      'twitter',    // Twitter/X OAuth
      'nostr',      // Nostr NIP-07 (stores npub)
      // Future:
      // 'facebook',
      // 'github',
      // 'lightning', // LNURL-auth
    ]
  },
  providerId: {
    type: String,
    required: true
    // For 'email': the email address
    // For 'google': Google user ID
    // For 'twitter': Twitter user ID
    // For 'nostr': npub
  },
  linkedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

/**
 * Pinned Mention Schema (Backend feature)
 * Used for cross-posting mention preferences.
 */
const PinnedMentionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  label: { type: String },
  twitter_profile: { type: Object },
  nostr_profile: { type: Object, default: null },
  is_cross_platform: { type: Boolean, default: false },
  source_mapping_id: { type: String, default: null },
  mapping_confidence: { type: Number, default: null },
  usage_count: { type: Number, default: 0 },
  is_adopted: { type: Boolean, default: false }
}, { _id: false });

// ============================================
// MAIN USER SCHEMA
// ============================================

const UserSchema = new mongoose.Schema({
  // ─────────────────────────────────────────
  // IDENTITY (Auth Server manages these)
  // ─────────────────────────────────────────
  email: {
    type: String,
    sparse: true,  // Allows null/undefined while still being unique
    unique: true,
    index: true
    // NOT required - Nostr/Lightning users may not have email
  },
  password: {
    type: String
    // NOT required - OAuth users don't have passwords
  },
  
  /**
   * Authentication provider info.
   * Only ONE provider per user (no account linking/commingling).
   * 
   * For existing email/password users:
   *   authProvider: { provider: 'email', providerId: '<email>' }
   * 
   * For OAuth users:
   *   authProvider: { provider: 'google', providerId: '<google_user_id>' }
   */
  authProvider: {
    type: AuthProviderSchema,
    default: null
  },
  
  // ─────────────────────────────────────────
  // SQUARE/SUBSCRIPTION (Auth Server manages)
  // ─────────────────────────────────────────
  squareCustomerId: {
    type: String,
    default: null
  },
  subscriptionId: {
    type: String,
    default: null
  },
  subscriptionType: {
    type: String,
    enum: ['amber', 'jamie-pro', null],
    default: null
  },
  
  // ─────────────────────────────────────────
  // APP PREFERENCES (Backend manages)
  // ─────────────────────────────────────────
  app_preferences: {
    type: new mongoose.Schema({
      data: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
      },
      schemaVersion: {
        type: Number,
        default: 20240320001
      }
    }, { _id: false }),
    select: false,
    default: () => ({
      data: {},
      schemaVersion: 20240320001
    })
  },
  
  // ─────────────────────────────────────────
  // MENTION PREFERENCES (Backend manages)
  // ─────────────────────────────────────────
  mention_preferences: {
    type: new mongoose.Schema({
      pinned_mentions: { type: [PinnedMentionSchema], default: [] }
    }, { _id: false }),
    select: false,
    default: () => ({ pinned_mentions: [] })
  }
  
}, {
  timestamps: false,
  versionKey: '__v'
});

// ============================================
// INDEXES
// ============================================

// Lookup by auth provider (for OAuth signin)
UserSchema.index(
  { 'authProvider.provider': 1, 'authProvider.providerId': 1 },
  { 
    unique: true, 
    sparse: true,
    partialFilterExpression: { 'authProvider': { $exists: true, $ne: null } }
  }
);

// ============================================
// VIRTUALS
// ============================================

/**
 * Determine user tier based on subscription status.
 * Used by entitlement system.
 */
UserSchema.virtual('tier').get(function() {
  if (this.subscriptionType === 'jamie-pro') {
    return 'subscriber';  // Paid tier
  }
  if (this.subscriptionType === 'amber') {
    return 'subscriber';  // Also paid
  }
  // If they have a User document, they're registered (regardless of email)
  if (this.authProvider) {
    return 'registered';
  }
  // Legacy users without authProvider but with email
  if (this.email) {
    return 'registered';
  }
  return 'anonymous';     // Should not happen for a User doc
});

/**
 * Check if user is a podcast admin.
 * Note: This requires checking ProPodcast collection separately.
 */
UserSchema.virtual('isPodcastAdmin').get(function() {
  // This is a placeholder - actual check requires ProPodcast lookup
  return false;
});

// ============================================
// STATIC METHODS
// ============================================

/**
 * Find user by auth provider credentials.
 * Used during OAuth signin to find existing user.
 * 
 * @param {string} provider - 'email', 'google', 'twitter', 'nostr'
 * @param {string} providerId - Provider-specific user ID
 * @returns {Promise<User|null>}
 */
UserSchema.statics.findByAuthProvider = function(provider, providerId) {
  return this.findOne({
    'authProvider.provider': provider,
    'authProvider.providerId': providerId
  });
};

/**
 * Find user by email (backwards compatible).
 * 
 * @param {string} email
 * @returns {Promise<User|null>}
 */
UserSchema.statics.findByEmail = function(email) {
  return this.findOne({ email: email });
};

/**
 * Find user by provider ID directly (useful for Nostr/Lightning without email).
 * 
 * @param {string} providerId - The provider-specific identifier
 * @returns {Promise<User|null>}
 */
UserSchema.statics.findByProviderId = function(providerId) {
  return this.findOne({ 'authProvider.providerId': providerId });
};

// ============================================
// INSTANCE METHODS
// ============================================

/**
 * Get the canonical identifier for this user.
 * Used by entitlement system.
 * 
 * @returns {string} The user's MongoDB _id as string
 */
UserSchema.methods.getCanonicalId = function() {
  return this._id.toString();
};

// ============================================
// MODEL EXPORT
// ============================================

// Use 'User' which Mongoose pluralizes to 'users' collection
const User = mongoose.model('User', UserSchema);

module.exports = { 
  User, 
  UserSchema,
  AuthProviderSchema,
  PinnedMentionSchema
};
