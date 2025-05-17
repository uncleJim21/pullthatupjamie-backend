const mongoose = require('mongoose');

const scheduledPodcastFeedSchema = new mongoose.Schema({
  feedUrl: {
    type: String,
    required: true,
    trim: true
  },
  feedId: {
    type: Number,
    required: true,
    unique: true
  },
  isEnabled: {
    type: Boolean,
    default: true
  },
  lastProcessed: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  feedTitle: {
    type: String,
    trim: true
  },
  podcastImage: {
    type: String,
    trim: true
  }
});

// Update the updatedAt timestamp before saving
scheduledPodcastFeedSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const ScheduledPodcastFeed = mongoose.model('ScheduledPodcastFeed', scheduledPodcastFeedSchema);

module.exports = ScheduledPodcastFeed; 