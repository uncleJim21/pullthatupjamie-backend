const mongoose = require('mongoose');

const ProPodcastDetailsSchema = new mongoose.Schema({
  feedId: {
    type: String,
    required: true,
    unique: true, // Ensures uniqueness of the podcast feed
    index: true,  // Optimizes query performance
  },
  lookupHash: {
    type: String,
    required: false, // No longer required
  },
  // Primary link to User (preferred for new records, supports all auth types)
  adminUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    required: false, // Optional for backwards compatibility
  },
  // Legacy link (kept for backwards compatibility with existing records)
  adminEmail: {
    type: String,
    required: false, // Changed from true - no longer required for non-email users
    index: true,     // Add index for query performance
  },
  headerColor: {
    type: String,
    required: false,
  },
  logoUrl: {
    type: String,
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  creator: {
    type: String,
    required: true,
  },
  lightningAddress: {
    type: String,
    required: false,
  },
  description: {
    type: String,
    required: true,
  },
  feedUrl: {
    type: String,
    required: true,
  },
  listenLink: {
    type: String,
    required: false,
  },
  subscribeLinks: {
    appleLink: { type: String, required: false },
    spotifyLink: { type: String, required: false },
    youtubeLink: { type: String, required: false },
  },
  // Add Twitter token fields
  twitterTokens: {
    // OAuth 2.0 tokens (for tweets and basic API calls)
    oauthToken: { type: String, required: false },           // OAuth 2.0 access token
    oauthTokenSecret: { type: String, required: false },     // OAuth 2.0 refresh token
    twitterId: { type: String, required: false },
    twitterUsername: { type: String, required: false },
    
    // OAuth 1.0a tokens (for media uploads)
    oauth1AccessToken: { type: String, required: false },    // OAuth 1.0a access token
    oauth1AccessSecret: { type: String, required: false },   // OAuth 1.0a access secret
    oauth1TwitterId: { type: String, required: false },
    oauth1TwitterUsername: { type: String, required: false },
    
    expiresAt: { type: Date, required: false },              // Token expiration timestamp
    lastUpdated: { type: Date, default: Date.now }
  }
});

const ProPodcastDetails = mongoose.model("ProPodcastDetails", ProPodcastDetailsSchema);

module.exports = {
  ProPodcastDetails
};
