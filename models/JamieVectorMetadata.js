const mongoose = require('mongoose');

/**
 * Single-collection Pinecone metadata mirror.
 *
 * Collection name (explicit): jamieVectorMetadata
 *
 * Primary access patterns:
 * - Pinecone IDs -> metadata: find({ pineconeId: { $in: [...] } })
 * - Hierarchy: paragraph/chapter -> episode(guid) -> feed(feedId)
 * - Chapter containment: type=chapter + guid + (start_time <= t && end_time >= t)
 * - Filtering: feedId + publishedTimestamp range
 */

const JamieVectorMetadataSchema = new mongoose.Schema(
  {
    // --- identity / linkage ---
    pineconeId: { type: String, required: true },
    type: {
      type: String,
      enum: ['paragraph', 'chapter', 'episode', 'feed'],
      required: true,
    },

    // Episode identity + feed identity
    guid: { type: String, required: false },
    feedId: { type: String, required: false }, // store as string consistently

    // --- common time fields ---
    publishedDate: { type: String, required: false }, // ISO string (kept for compatibility)
    publishedTimestamp: { type: Number, required: false }, // ms since epoch
    publishedYear: { type: Number, required: false },
    publishedMonth: { type: Number, required: false },

    // paragraph/chapter interval (seconds)
    start_time: { type: Number, required: false },
    end_time: { type: Number, required: false },

    // --- commonly returned fields (optional; depends on your formatter) ---
    quote: { type: String, required: false },
    text: { type: String, required: false },
    episode: { type: String, required: false },
    creator: { type: String, required: false },
    audioUrl: { type: String, required: false },
    episodeImage: { type: String, required: false },
    listenLink: { type: String, required: false },
    shareUrl: { type: String, required: false },
    shareLink: { type: String, required: false },

    // --- full fidelity metadata for traceability ---
    metadataRaw: { type: mongoose.Schema.Types.Mixed, required: true },

    // --- provenance (which cache trial/chunk produced this doc) ---
    cache: {
      trialId: { type: String, required: false },
      chunkFile: { type: String, required: false },
      updatedAt: { type: Date, default: Date.now },
    },
  },
  {
    collection: 'jamieVectorMetadata',
    timestamps: true,
    minimize: false,
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

// Fast ID lookup after Pinecone returns IDs
JamieVectorMetadataSchema.index({ pineconeId: 1 }, { unique: true });

// Fast episode lookup (for enrichment)
JamieVectorMetadataSchema.index({ type: 1, guid: 1 });

// Fast feed lookup
JamieVectorMetadataSchema.index({ type: 1, feedId: 1 });

// Date filtering per feed (common filters)
JamieVectorMetadataSchema.index({ feedId: 1, publishedTimestamp: 1 });

// Chapter containment helper index (narrows by type+guid, then scans start_time)
JamieVectorMetadataSchema.index({ type: 1, guid: 1, start_time: 1, end_time: 1 });

// Enforce single canonical episode doc per guid (still one collection)
JamieVectorMetadataSchema.index(
  // Use different key order than the non-unique index to avoid duplicate-index warnings in mongoose
  { guid: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: 'episode', guid: { $type: 'string' } } }
);

// Enforce single canonical feed doc per feedId (still one collection)
JamieVectorMetadataSchema.index(
  // Use different key order than the non-unique index to avoid duplicate-index warnings in mongoose
  { feedId: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: 'feed', feedId: { $type: 'string' } } }
);

// Check if model exists before creating
const JamieVectorMetadata =
  mongoose.models.JamieVectorMetadata ||
  mongoose.model('JamieVectorMetadata', JamieVectorMetadataSchema);

module.exports = JamieVectorMetadata;


