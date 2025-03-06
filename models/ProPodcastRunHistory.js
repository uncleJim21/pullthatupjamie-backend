const mongoose = require('mongoose');

// Define the nested schemas first
const FilterScopeSchema = new mongoose.Schema({
  feed_id: {
    type: String,
    required: true
  },
  episode_guid: {
    type: String,
    required: false
  }
}, { _id: false });

const ClipRecommendationSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  text: {
    type: String,
    required: true
  },
  start_time: {
    type: Number,
    required: true
  },
  end_time: {
    type: Number,
    required: true
  },
  episode_title: {
    type: String,
    required: true
  },
  feed_title: {
    type: String,
    required: true
  },
  audio_url: {
    type: String,
    required: true
  },
  relevance_score: {
    type: Number,
    required: true
  },
  episode_image: {
    type: String,
    required: false
  },
  duration: {
    type: Number,
    required: true
  },
  paragraph_ids: {
    type: [String],
    default: []
  },
  expanded_context: {
    type: Boolean,
    default: false
  },
  first_word_index: {
    type: Number,
    required: false
  },
  last_word_index: {
    type: Number,
    required: false
  }
}, { _id: false });

// Main schema
const ProPodcastRunHistorySchema = new mongoose.Schema({
  feed_id: {
    type: String,
    required: true,
    index: true
  },
  run_date: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },
  filter_scope: {
    type: FilterScopeSchema,
    required: true
  },
  recommendations: {
    type: [ClipRecommendationSchema],
    default: []
  }
}, { 
  collection: 'propodcastrunhistory',
  timestamps: true // Adds createdAt and updatedAt fields
});

// Create model
const ProPodcastRunHistory = mongoose.model('ProPodcastRunHistory', ProPodcastRunHistorySchema);

module.exports = ProPodcastRunHistory; 