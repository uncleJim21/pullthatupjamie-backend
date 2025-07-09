const mongoose = require('mongoose');

const onDemandQuotaSchema = new mongoose.Schema({
  identifier: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  type: {
    type: String,
    enum: ['ip', 'jwt'],
    required: true
  },
  remainingRuns: {
    type: Number,
    required: true,
    default: 10
  },
  totalLimit: {
    type: Number,
    required: true,
    default: 10
  },
  usedThisPeriod: {
    type: Number,
    required: true,
    default: 0
  },
  periodStart: {
    type: Date,
    required: true,
    default: Date.now
  },
  nextResetDate: {
    type: Date,
    required: true
  },
  lastUsed: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for efficient queries
onDemandQuotaSchema.index({ identifier: 1, type: 1 });

// Virtual for days until reset
onDemandQuotaSchema.virtual('daysUntilReset').get(function() {
  if (!this.nextResetDate) return 0;
  const now = new Date();
  const diffTime = this.nextResetDate - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
});

// Ensure virtuals are included in JSON
onDemandQuotaSchema.set('toJSON', { virtuals: true });

const OnDemandQuota = mongoose.model('OnDemandQuota', onDemandQuotaSchema);

module.exports = { OnDemandQuota }; 