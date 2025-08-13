const mongoose = require('mongoose');

const PinnedMentionSchema = new mongoose.Schema({
  id: { type: String, required: true }, // pinId or cross_*
  label: { type: String },
  twitter_profile: { type: Object }, // { username, id, ... }
  nostr_profile: { type: Object, default: null }, // { npub, ... } or null
  is_cross_platform: { type: Boolean, default: false },
  source_mapping_id: { type: String, default: null }, // mappingId if adopted
  mapping_confidence: { type: Number, default: null },
  usage_count: { type: Number, default: 0 },
  is_adopted: { type: Boolean, default: false }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  app_preferences: {
    type: new mongoose.Schema({
      data: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
      },
      schemaVersion: {
        type: Number,
        default: 20240320001 // YYYYMMDDXXX format
      }
    }, { _id: false }),
    select: false,
    default: () => ({
      data: {},
      schemaVersion: 20240320001
    })
  },
  password: {
    type: String,
    required: true
  },
  squareCustomerId: {
    type: String,
    required: false
  },
  subscriptionId: {
    type: String,
    required: false
  },
  mention_preferences: {
    type: new mongoose.Schema({
      pinned_mentions: { type: [PinnedMentionSchema], default: [] }
    }, { _id: false }),
    select: false,
    default: () => ({ pinned_mentions: [] })
  }
}, {
  timestamps: false, // Don't add createdAt/updatedAt to match existing structure
  versionKey: '__v' // Keep the __v field to match existing structure
});

const User = mongoose.model('User', UserSchema);

module.exports = { User }; 