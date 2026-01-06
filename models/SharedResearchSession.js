const mongoose = require('mongoose');

const SharedResearchSessionSchema = new mongoose.Schema({
  // Base research session this snapshot is derived from
  researchSessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ResearchSession',
    required: true,
    index: true
  },

  // Owning user (if authenticated)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    index: true
  },

  // Owning client (for anonymous sessions)
  clientId: {
    type: String,
    required: false,
    index: true
  },

  // Short, URL-safe share identifier
  shareId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Fully-qualified public URL for this shared session
  shareUrl: {
    type: String,
    required: true
  },

  // Resolved title for the shared snapshot
  title: {
    type: String,
    required: true
  },
  brandImage: {
    type: String,
    required: false,
    default: null
  },
  brandColors: [
    {
      primary:{
        type: String,
        required: false,
        default: null
      },
      secondary:{
        type: String,
        required: false,
        default: null
    }
  }
  ],
  // Visibility: public or unlisted
  visibility: {
    type: String,
    enum: ['public', 'unlisted'],
    default: 'public',
    index: true
  },

  // Snapshot of nodes / layout at share time
  nodes: [{
    pineconeId: { type: String, required: true },
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    z: { type: Number, required: true },
    color: { type: String, required: true }
  }],

  // Optional camera / view configuration
  camera: {
    distance: { type: Number, required: false },
    tilt: { type: Number, required: false },
    rotation: { type: Number, required: false }
  },

  // Cached last item metadata (episode, creator, cover art, etc.)
  lastItemMetadata: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
    default: null
  },

  // CDN URL for the generated preview image
  previewImageUrl: {
    type: String,
    required: false,
    default: null
  }
}, {
  timestamps: true
});

const SharedResearchSession = mongoose.model('SharedResearchSession', SharedResearchSessionSchema);

module.exports = { SharedResearchSession };

