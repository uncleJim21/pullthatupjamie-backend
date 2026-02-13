const mongoose = require('mongoose');

const BlogPostSchema = new mongoose.Schema({
  // Nostr event identification
  nostr_event_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Nostr replaceable event identifier (d tag) — used for edit detection
  nostr_d_tag: {
    type: String,
    required: false,
    index: true
  },

  // Author pubkey (hex)
  pubkey: {
    type: String,
    required: true,
    index: true
  },

  // Post content
  title: {
    type: String,
    required: true
  },

  slug: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  summary: {
    type: String,
    default: ''
  },

  content_md: {
    type: String,
    required: true
  },

  // Nostr timestamps (unix seconds)
  created_at: {
    type: Number,
    required: true,
    index: true
  },

  updated_at: {
    type: Number,
    required: true
  },

  // Origin tracking
  source: {
    type: String,
    default: 'stacker.news'
  },

  source_url: {
    type: String,
    default: ''
  },

  // Publishing status
  status: {
    type: String,
    enum: ['published', 'draft', 'hidden'],
    default: 'published',
    index: true
  },

  // Content tags from Nostr t tags
  tags: [{
    type: String
  }],

  // SEO metadata (pre-computed for fast API responses)
  seo: {
    meta_description: {
      type: String,
      default: ''
    },
    canonical_url: {
      type: String,
      default: ''
    },
    og_image: {
      type: String,
      default: ''
    }
  }
}, {
  timestamps: true // Mongoose _createdAt, _updatedAt for internal bookkeeping
});

// Compound indexes for common queries
BlogPostSchema.index({ status: 1, created_at: -1 }); // Blog listing sorted by date
BlogPostSchema.index({ pubkey: 1, nostr_d_tag: 1 });  // Edit detection

module.exports = mongoose.model('BlogPost', BlogPostSchema);
