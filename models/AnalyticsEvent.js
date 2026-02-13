const mongoose = require('mongoose');

/**
 * Analytics Event Schema
 * 
 * Tracks user journeys, feature usage, and conversion funnels.
 * Privacy-focused: session_id is a random UUID, not linked to identity.
 */
const analyticsEventSchema = new mongoose.Schema({
  // Event type (e.g., 'auth_completed', 'entitlement_consumed')
  type: {
    type: String,
    required: true,
    index: true
  },
  
  // Client session ID (UUID v4, stored in localStorage)
  session_id: {
    type: String,
    required: true,
    index: true
  },
  
  // Client-generated timestamp
  timestamp: {
    type: Date,
    required: true,
    index: true
  },
  
  // User tier at time of event
  tier: {
    type: String,
    required: true,
    enum: ['anonymous', 'registered', 'subscriber', 'admin']
  },
  
  // Environment where event occurred
  environment: {
    type: String,
    required: true,
    enum: ['dev', 'staging', 'prod'],
    index: true
  },
  
  // Event-specific properties (flexible schema)
  properties: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Server-side timestamp (when we received the event)
  server_timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  // Disable Mongoose's automatic timestamps since we manage our own
  timestamps: false,
  // Don't block on index creation in dev - indexes created manually in prod
  autoIndex: false
});

// Compound index for common queries (e.g., "all auth events in last 7 days")
analyticsEventSchema.index({ type: 1, timestamp: -1 });

// Compound index for session analysis
analyticsEventSchema.index({ session_id: 1, timestamp: 1 });

// Compound index for environment-filtered queries
analyticsEventSchema.index({ environment: 1, type: 1, timestamp: -1 });

const AnalyticsEvent = mongoose.model('AnalyticsEvent', analyticsEventSchema);

module.exports = { AnalyticsEvent };
