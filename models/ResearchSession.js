const mongoose = require('mongoose');

const ResearchSessionSchema = new mongoose.Schema({
  // Optional reference to an authenticated user
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    index: true
  },

  // Optional anonymous client identifier (e.g. browser-generated UUID)
  clientId: {
    type: String,
    required: false,
    index: true
  },

  // Ordered list of Pinecone vector IDs associated with this research session
  pineconeIds: {
    type: [String],
    required: true,
    default: []
  },

  // Metadata snapshot for the most recent item in pineconeIds
  lastItemMetadata: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
    default: null
  }
}, {
  timestamps: true
});

// Optional compound indexes for common query patterns
ResearchSessionSchema.index({ userId: 1, createdAt: -1 });
ResearchSessionSchema.index({ clientId: 1, createdAt: -1 });

const ResearchSession = mongoose.model('ResearchSession', ResearchSessionSchema);

module.exports = { ResearchSession };

