// models/QueueJob.js
const mongoose = require('mongoose');

const QueueDOJobSchema = new mongoose.Schema({
  lookupHash: { type: String, required: true, unique: true },
  status: { 
    type: String, 
    enum: ['queued', 'processing', 'completed', 'failed'],
    default: 'queued'
  },
  priority: { type: Number, default: 0 },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 3 },
  
  // Job data
  clipData: { type: Object, required: true },
  timestamps: { type: Array },
  subtitles: { type: Array },
  jobType: { 
    type: String, 
    required: true 
  },
  
  // Instance tracking
  instanceId: { type: String }, // Which instance is processing this
  claimedAt: { type: Date },
  heartbeatAt: { type: Date },
  
  // Timestamps
  queuedAt: { type: Date, default: Date.now },
  startedAt: { type: Date },
  completedAt: { type: Date },
  failedAt: { type: Date },
  
  // Error tracking
  lastError: { type: String },
  errorHistory: [{ 
    attempt: Number, 
    error: String, 
    timestamp: Date 
  }]
});

// Indexes for performance
QueueDOJobSchema.index({ status: 1, priority: -1, queuedAt: 1 });
QueueDOJobSchema.index({ instanceId: 1, heartbeatAt: 1 });
QueueDOJobSchema.index({ lookupHash: 1 });

module.exports = mongoose.model('QueueDOJob', QueueDOJobSchema);