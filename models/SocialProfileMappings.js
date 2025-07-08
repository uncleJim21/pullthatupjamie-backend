const mongoose = require('mongoose');

const SocialProfileMappingSchema = new mongoose.Schema({
  mapping_key: { type: String, required: true, unique: true }, // twitter_username|nostr_npub
  twitter_profile: { type: Object, required: true }, // { username, id, ... }
  nostr_profile: { type: Object, required: true }, // { npub, ... }
  is_public: { type: Boolean, default: true },
  confidence_score: { type: Number, default: 0.5 },
  created_by: { type: String, required: true }, // email or user id
  usage_count: { type: Number, default: 0 },
  verification_method: { type: String, enum: ['verified_link', 'cross_post', 'community', 'manual'], default: 'manual' },
  upvotes: { type: Number, default: 0 },
  downvotes: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

SocialProfileMappingSchema.index({ mapping_key: 1 }, { unique: true });

const SocialProfileMapping = mongoose.model('SocialProfileMapping', SocialProfileMappingSchema);

module.exports = { SocialProfileMapping }; 