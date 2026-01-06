const mongoose = require('mongoose');

// Subdocument schema for per-item Pinecone metadata snapshots
const ResearchSessionItemSchema = new mongoose.Schema({
  pineconeId: {
    type: String,
    required: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
    default: null
  },
  // Optional 3D coordinates for galaxy view; when not provided,
  // the 3D fetch endpoint will synthesize small random offsets.
  coordinates3d: {
    x: { type: Number, required: false, default: null },
    y: { type: Number, required: false, default: null },
    z: { type: Number, required: false, default: null }
  }
}, { _id: false });

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
  title: {
    type: String,
    required: false,
    index: false
  },
  // Ordered list of Pinecone vector IDs associated with this research session
  pineconeIds: {
    type: [String],
    required: true,
    default: []
  },

  // Per-item metadata snapshots corresponding to entries in pineconeIds
  items: {
    type: [ResearchSessionItemSchema],
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

// Helper to strip embeddings from any metadata blobs
function stripEmbeddingsFromDoc(doc) {
  if (!doc) return;

  // Strip from items[].metadata.embedding
  if (Array.isArray(doc.items)) {
    doc.items.forEach((item) => {
      if (item && item.metadata && Object.prototype.hasOwnProperty.call(item.metadata, 'embedding')) {
        delete item.metadata.embedding;
      }
    });
  }

  // Strip from lastItemMetadata.embedding
  if (doc.lastItemMetadata && Object.prototype.hasOwnProperty.call(doc.lastItemMetadata, 'embedding')) {
    delete doc.lastItemMetadata.embedding;
  }
}

// Ensure embeddings are never persisted to MongoDB
ResearchSessionSchema.pre('save', function(next) {
  stripEmbeddingsFromDoc(this);
  next();
});

// Ensure embeddings are not exposed when converting to JSON / plain objects
ResearchSessionSchema.set('toJSON', {
  transform: function(doc, ret) {
    stripEmbeddingsFromDoc(ret);
    return ret;
  }
});

ResearchSessionSchema.set('toObject', {
  transform: function(doc, ret) {
    stripEmbeddingsFromDoc(ret);
    return ret;
  }
});

// Optional compound indexes for common query patterns
ResearchSessionSchema.index({ userId: 1, createdAt: -1 });
ResearchSessionSchema.index({ clientId: 1, createdAt: -1 });

const ResearchSession = mongoose.model('ResearchSession', ResearchSessionSchema);

module.exports = { ResearchSession };

