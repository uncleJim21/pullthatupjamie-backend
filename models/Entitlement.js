const mongoose = require('mongoose');//

const entitlementSchema = new mongoose.Schema({
  // Unique identifier for the entitlement holder (IP address, JWT user ID, etc.)
  identifier: {
    type: String,
    required: true,
    index: true
  },
  
  // Type of identifier (ip, mongoUserId, etc.)
  identifierType: {
    type: String,
    required: true,
    enum: ['ip', 'mongoUserId', 'user', 'jwt', 'email', 'custom'], // 'mongoUserId' is preferred for authenticated users
    index: true
  },
  
  // Type of entitlement (onDemandRun, premiumFeature, etc.)
  entitlementType: {
    type: String,
    required: true,
    enum: [
      'onDemandRun',      // Podcast on-demand processing
      'searchQuotes',     // Basic quote search
      'search3D',         // 3D search (embeddings + UMAP)
      'makeClip',         // Video clip creation
      'jamieAssist',      // AI analysis
      'premiumFeature',   // Generic premium feature
      'apiAccess',        // API access
      'custom'            // Custom entitlement
    ],
    index: true
  },
  
  // Current usage count
  usedCount: {
    type: Number,
    required: true,
    default: 0
  },
  
  // Maximum allowed usage
  maxUsage: {
    type: Number,
    required: true,
    default: 10
  },
  
  // Period configuration
  periodStart: {
    type: Date,
    required: true,
    default: Date.now
  },
  
  // Period length in days
  periodLengthDays: {
    type: Number,
    required: true,
    default: 30
  },
  
  // Next reset date (calculated)
  nextResetDate: {
    type: Date,
    required: true
  },
  
  // Last usage timestamp
  lastUsed: {
    type: Date,
    default: Date.now
  },
  
  // Status of the entitlement (active, suspended, expired)
  status: {
    type: String,
    enum: ['active', 'suspended', 'expired'],
    default: 'active',
    index: true
  },
  
  // Metadata for flexible configuration
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
entitlementSchema.index({ identifier: 1, identifierType: 1, entitlementType: 1 }, { unique: true });

// Virtual for remaining usage
entitlementSchema.virtual('remainingUsage').get(function() {
  return Math.max(0, this.maxUsage - this.usedCount);
});

// Virtual for days until reset
entitlementSchema.virtual('daysUntilReset').get(function() {
  if (!this.nextResetDate) return 0;
  const now = new Date();
  const diffTime = this.nextResetDate - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
});

// Virtual for whether entitlement is eligible
entitlementSchema.virtual('isEligible').get(function() {
  return this.status === 'active' && this.remainingUsage > 0;
});

// Ensure virtuals are included in JSON
entitlementSchema.set('toJSON', { virtuals: true });

// Pre-save middleware to calculate nextResetDate
entitlementSchema.pre('save', function(next) {
  if (this.isModified('periodStart') || this.isModified('periodLengthDays')) {
    this.nextResetDate = new Date(this.periodStart);
    this.nextResetDate.setDate(this.nextResetDate.getDate() + this.periodLengthDays);
  }
  next();
});

const Entitlement = mongoose.model('Entitlement', entitlementSchema);

module.exports = { Entitlement }; 