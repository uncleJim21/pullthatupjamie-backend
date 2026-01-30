const mongoose = require('mongoose');

const SocialPostSchema = new mongoose.Schema({
  // Basic identification - using MongoDB _id
  
  // Ownership (links to existing User model)
  // Supports both new userId-based and legacy email-based ownership
  adminUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    required: false // Optional for backward compatibility
  },
  adminEmail: {
    type: String,
    required: false, // Changed: no longer required (Twitter/Nostr users may not have email)
    index: true // Links to User.email and ProPodcastDetails.adminEmail
  },
  
  // Platform - one post per platform
  platform: {
    type: String,
    enum: ['twitter', 'nostr'],
    required: true,
    index: true
  },
  
  // Scheduling
  scheduledFor: {
    type: Date,
    required: true,
    index: true // For efficient queue processing
  },
  timezone: {
    type: String,
    default: 'America/Chicago' // Your existing timezone standard
  },

  // Optional external scheduler slot identifier (for mapping from upstream systems)
  scheduledPostSlotId: {
    type: String,
    required: false,
    index: true
  },
  
  // Content (simplified)
  content: {
    text: {
      type: String,
      required: false,
      maxlength: 2000 // Allow for longer Nostr posts
    },
    mediaUrl: {
      type: String, // Single CDN URL from DigitalOcean Spaces
      required: false
    }
  },
  
  // Platform-specific data
  platformData: {
    // Twitter specific
    twitterPostId: { type: String, required: false },
    twitterPostUrl: { type: String, required: false },
    
    // Nostr specific  
    nostrEventId: { type: String, required: false },
    nostrSignature: { type: String, required: false },
    nostrPubkey: { type: String, required: false },
    nostrCreatedAt: { type: Number, required: false }, // Unix timestamp used for signing
    nostrRelays: [{ type: String }],
    nostrPostUrl: { type: String, required: false } // URL for viewing on Primal
  },
  
  // Status tracking
  status: {
    type: String,
    enum: ['scheduled', 'processing', 'posted', 'failed', 'cancelled', 'unsigned'],
    default: 'scheduled',
    index: true
  },
  
  // Error tracking
  error: {
    type: String,
    required: false
  },
  
  // Retry logic
  attemptCount: {
    type: Number,
    default: 0
  },
  maxAttempts: {
    type: Number,
    default: 3
  },
  nextRetryAt: {
    type: Date,
    required: false
  },
  
  // Processing timestamps
  processedAt: { type: Date },
  postedAt: { type: Date },
  failedAt: { type: Date }
}, {
  timestamps: true // createdAt, updatedAt
});

// Compound indexes for efficient querying
SocialPostSchema.index({ scheduledFor: 1, status: 1 });
SocialPostSchema.index({ adminEmail: 1, status: 1 });
SocialPostSchema.index({ adminUserId: 1, status: 1 }); // NEW: For non-email users
SocialPostSchema.index({ platform: 1, status: 1 });
SocialPostSchema.index({ status: 1, nextRetryAt: 1 });

/**
 * Helper to build owner query (supports both userId and email)
 * @param {Object} identity - { userId, email }
 * @returns {Object} MongoDB query
 */
SocialPostSchema.statics.buildOwnerQuery = function(identity) {
  const { userId, email } = identity || {};
  const query = { $or: [] };
  
  if (userId) {
    query.$or.push({ adminUserId: userId });
  }
  if (email) {
    query.$or.push({ adminEmail: email });
  }
  
  // If neither provided, return impossible query
  if (query.$or.length === 0) {
    return { _id: null }; // Will match nothing
  }
  
  return query;
};

// Static method to get all status options
SocialPostSchema.statics.getStatusOptions = function() {
  return ['scheduled', 'processing', 'posted', 'failed', 'cancelled', 'unsigned'];
};

// Static method to get all platform options
SocialPostSchema.statics.getPlatformOptions = function() {
  return ['twitter', 'nostr'];
};

module.exports = mongoose.model('SocialPost', SocialPostSchema);
