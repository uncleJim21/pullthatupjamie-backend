const { OnDemandQuota } = require('../models/OnDemandQuota');

/**
 * Get quota configuration from environment variables
 */
const getQuotaConfig = () => {
  return {
    usageLimit: parseInt(process.env.ON_DEMAND_USAGE_LIMIT) || 10,
    periodLengthDays: parseInt(process.env.ON_DEMAND_PERIOD_DAYS) || 30
  };
};

/**
 * Check if a period has expired
 */
const isPeriodExpired = (periodStart, periodLengthDays) => {
  if (!periodStart) return true;
  
  const now = new Date();
  const periodEnd = new Date(periodStart);
  periodEnd.setDate(periodEnd.getDate() + periodLengthDays);
  
  return now >= periodEnd;
};

/**
 * Initialize or reset quota for a new period
 */
const initializeQuota = async (identifier, type) => {
  const config = getQuotaConfig();
  const now = new Date();
  const nextResetDate = new Date(now);
  nextResetDate.setDate(nextResetDate.getDate() + config.periodLengthDays);
  
  const quota = new OnDemandQuota({
    identifier: `${type}:${identifier}`,
    type,
    remainingRuns: config.usageLimit,
    totalLimit: config.usageLimit,
    usedThisPeriod: 0,
    periodStart: now,
    nextResetDate,
    lastUsed: now
  });
  
  return await quota.save();
};

/**
 * Check eligibility for on-demand runs
 */
const checkQuotaEligibility = async (identifier, type) => {
  try {
    const config = getQuotaConfig();
    const quotaId = `${type}:${identifier}`;
    
    // Find existing quota
    let quota = await OnDemandQuota.findOne({ identifier: quotaId });
    
    // If no quota exists or period has expired, initialize new quota
    if (!quota || isPeriodExpired(quota.periodStart, config.periodLengthDays)) {
      quota = await initializeQuota(identifier, type);
    }
    
    const eligible = quota.remainingRuns > 0;
    
    return {
      eligible,
      remainingRuns: quota.remainingRuns,
      totalLimit: quota.totalLimit,
      usedThisPeriod: quota.usedThisPeriod,
      periodStart: quota.periodStart,
      nextResetDate: quota.nextResetDate,
      daysUntilReset: quota.daysUntilReset
    };
  } catch (error) {
    console.error('Error checking quota eligibility:', error);
    return {
      eligible: false,
      error: 'Internal server error',
      remainingRuns: 0,
      totalLimit: 0,
      periodStart: null,
      nextResetDate: null,
      daysUntilReset: 0
    };
  }
};

/**
 * Consume one quota run
 */
const consumeQuota = async (identifier, type) => {
  try {
    const config = getQuotaConfig();
    const quotaId = `${type}:${identifier}`;
    
    // Find existing quota
    let quota = await OnDemandQuota.findOne({ identifier: quotaId });
    
    // If no quota exists or period has expired, initialize new quota
    if (!quota || isPeriodExpired(quota.periodStart, config.periodLengthDays)) {
      quota = await initializeQuota(identifier, type);
    }
    
    // Check if limit exceeded
    if (quota.remainingRuns <= 0) {
      return {
        success: false,
        error: 'Quota limit exceeded for this period',
        remainingRuns: 0,
        nextResetDate: quota.nextResetDate
      };
    }
    
    // Consume one run
    quota.remainingRuns -= 1;
    quota.usedThisPeriod += 1;
    quota.lastUsed = new Date();
    await quota.save();
    
    return {
      success: true,
      remainingRuns: quota.remainingRuns,
      usedThisPeriod: quota.usedThisPeriod,
      totalLimit: quota.totalLimit
    };
  } catch (error) {
    console.error('Error consuming quota:', error);
    return {
      success: false,
      error: 'Internal server error'
    };
  }
};

/**
 * Get quota statistics (for admin/debugging)
 */
const getQuotaStats = async () => {
  try {
    const stats = await OnDemandQuota.aggregate([
      {
        $group: {
          _id: '$type',
          totalQuotas: { $sum: 1 },
          totalUsed: { $sum: '$usedThisPeriod' },
          totalRemaining: { $sum: '$remainingRuns' },
          avgUsed: { $avg: '$usedThisPeriod' },
          avgRemaining: { $avg: '$remainingRuns' }
        }
      }
    ]);
    
    return stats;
  } catch (error) {
    console.error('Error getting quota stats:', error);
    return [];
  }
};

module.exports = {
  checkQuotaEligibility,
  consumeQuota,
  getQuotaStats,
  getQuotaConfig
}; 