const mongoose = require('mongoose');

// Define the podcast preferences schema
const PodcastPreferenceSchema = new mongoose.Schema({
    feed_id: {
        type: String,
        required: true
    },
    is_favorite: {
        type: Boolean,
        default: false
    },
    is_excluded: {
        type: Boolean,
        default: false
    },
    preferred_topics: {
        type: [String],
        default: []
    },
    excluded_topics: {
        type: [String],
        default: []
    },
    notification_frequency: {
        type: String,
        enum: ['never', 'daily', 'weekly', 'monthly'],
        default: 'weekly'
    }
}, { _id: false });

// Main schema
const ProPodcastUserPrefsSchema = new mongoose.Schema({
    user_id: {
        type: String,
        required: true,
        index: true
    },
    email: {
        type: String,
        required: true,
        index: true
    },
    global_preferences: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    podcast_preferences: {
        type: [PodcastPreferenceSchema],
        default: []
    }
}, {
    collection: 'propodcastuserprefs',
    timestamps: true
});

// Create compound index for faster lookups
ProPodcastUserPrefsSchema.index({ email: 1, user_id: 1 });

// Log the collection name when the model is created
console.log('Creating ProPodcastUserPrefs model with collection:', 'propodcastuserprefs');

const ProPodcastUserPrefs = mongoose.model('ProPodcastUserPrefs', ProPodcastUserPrefsSchema);

// Verify indexes after model creation
ProPodcastUserPrefs.listIndexes()
    .then(indexes => {
        console.log('ProPodcastUserPrefs indexes:', indexes);
    })
    .catch(err => {
        console.error('Error listing indexes:', err);
    });

module.exports = ProPodcastUserPrefs; 