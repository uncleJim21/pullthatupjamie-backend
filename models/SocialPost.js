const mongoose = require('mongoose');

const SocialPostSchema = new mongoose.Schema({
  // Basic identification - using MongoDB _id
  
  // Ownership (links to existing User model)
  adminEmail: {
    type: String,
    required: true,
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
    nostrRelays: [{ type: String }]
  },
  
  // Status tracking
  status: {
    type: String,
    enum: ['scheduled', 'processing', 'posted', 'failed', 'cancelled'],
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
SocialPostSchema.index({ platform: 1, status: 1 });
SocialPostSchema.index({ status: 1, nextRetryAt: 1 });

// Static method to get all status options
SocialPostSchema.statics.getStatusOptions = function() {
  return ['scheduled', 'processing', 'posted', 'failed', 'cancelled'];
};

// Static method to get all platform options
SocialPostSchema.statics.getPlatformOptions = function() {
  return ['twitter', 'nostr'];
};

module.exports = mongoose.model('SocialPost', SocialPostSchema);
