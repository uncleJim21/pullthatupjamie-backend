const { Entitlement } = require('../models/Entitlement');
const { ENTITLEMENT_TYPES } = require('../constants/entitlementTypes');

/**
 * Default configuration for different entitlement types
 */
const ENTITLEMENT_CONFIGS = {
  [ENTITLEMENT_TYPES.SUBMIT_ON_DEMAND_RUN]: {
    maxUsage: parseInt(process.env.ON_DEMAND_USAGE_LIMIT) || 10,
    periodLengthDays: parseInt(process.env.ON_DEMAND_PERIOD_DAYS) || 30
  },
  premiumFeature: {
    maxUsage: 100,
    periodLengthDays: 30
  },
  apiAccess: {
    maxUsage: 1000,
    periodLengthDays: 30
  }
};

/**
 * Get configuration for a specific entitlement type
 */
const getEntitlementConfig = (entitlementType) => {
  return ENTITLEMENT_CONFIGS[entitlementType] || {
    maxUsage: 10,
    periodLengthDays: 30
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
 * Initialize or reset entitlement for a new period
 */
const initializeEntitlement = async (identifier, identifierType, entitlementType) => {
  const config = getEntitlementConfig(entitlementType);
  const now = new Date();
  const nextResetDate = new Date(now);
  nextResetDate.setDate(nextResetDate.getDate() + config.periodLengthDays);

  // Use an atomic upsert so that:
  // - If no entitlement exists, it is created with the correct values
  // - If an entitlement exists but the period has expired, it is reset in-place
  // This avoids duplicate-key errors from the unique index.
  const entitlement = await Entitlement.findOneAndUpdate(
    {
      identifier,
      identifierType,
      entitlementType
    },
    {
      identifier,
      identifierType,
      entitlementType,
      usedCount: 0,
      maxUsage: config.maxUsage,
      periodStart: now,
      periodLengthDays: config.periodLengthDays,
      nextResetDate,
      lastUsed: now,
      status: 'active'
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true
    }
  );

  return entitlement;
};

/**
 * Check eligibility for an entitlement
 */
const checkEntitlementEligibility = async (identifier, identifierType, entitlementType) => {
  try {
    const config = getEntitlementConfig(entitlementType);
    
    // Find existing entitlement
    let entitlement = await Entitlement.findOne({
      identifier,
      identifierType,
      entitlementType
    });
    
    // If no entitlement exists or period has expired, initialize new entitlement
    if (!entitlement || isPeriodExpired(entitlement.periodStart, entitlement.periodLengthDays)) {
      entitlement = await initializeEntitlement(identifier, identifierType, entitlementType);
    }
    
    return {
      eligible: entitlement.isEligible,
      remainingUsage: entitlement.remainingUsage,
      maxUsage: entitlement.maxUsage,
      usedCount: entitlement.usedCount,
      periodStart: entitlement.periodStart,
      nextResetDate: entitlement.nextResetDate,
      daysUntilReset: entitlement.daysUntilReset,
      status: entitlement.status
    };
  } catch (error) {
    console.error('Error checking entitlement eligibility:', error);
    // Let callers surface this as a proper 5xx instead of
    // returning a misleading 0/0 entitlement state.
    throw error;
  }
};

/**
 * Consume one entitlement usage
 */
const consumeEntitlement = async (identifier, identifierType, entitlementType) => {
  try {
    const config = getEntitlementConfig(entitlementType);
    
    // Find existing entitlement
    let entitlement = await Entitlement.findOne({
      identifier,
      identifierType,
      entitlementType
    });
    
    // If no entitlement exists or period has expired, initialize new entitlement
    if (!entitlement || isPeriodExpired(entitlement.periodStart, entitlement.periodLengthDays)) {
      entitlement = await initializeEntitlement(identifier, identifierType, entitlementType);
    }
    
    // Check if limit exceeded
    if (entitlement.remainingUsage <= 0) {
      return {
        success: false,
        error: 'Entitlement limit exceeded for this period',
        remainingUsage: 0,
        nextResetDate: entitlement.nextResetDate
      };
    }
    
    // Consume one usage
    entitlement.usedCount += 1;
    entitlement.lastUsed = new Date();
    await entitlement.save();
    
    return {
      success: true,
      remainingUsage: entitlement.remainingUsage,
      usedCount: entitlement.usedCount,
      maxUsage: entitlement.maxUsage
    };
  } catch (error) {
    console.error('Error consuming entitlement:', error);
    return {
      success: false,
      error: 'Internal server error'
    };
  }
};

/**
 * Get entitlement statistics (for admin/debugging)
 */
const getEntitlementStats = async (entitlementType = null) => {
  try {
    const matchStage = entitlementType ? { entitlementType } : {};
    
    const stats = await Entitlement.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            identifierType: '$identifierType',
            entitlementType: '$entitlementType'
          },
          totalEntitlements: { $sum: 1 },
          totalUsed: { $sum: '$usedCount' },
          totalRemaining: { $sum: '$remainingUsage' },
          avgUsed: { $avg: '$usedCount' },
          avgRemaining: { $avg: '$remainingUsage' }
        }
      }
    ]);
    
    return stats;
  } catch (error) {
    console.error('Error getting entitlement stats:', error);
    return [];
  }
};

/**
 * Reset entitlement for a specific identifier
 */
const resetEntitlement = async (identifier, identifierType, entitlementType) => {
  try {
    const config = getEntitlementConfig(entitlementType);
    const now = new Date();
    const nextResetDate = new Date(now);
    nextResetDate.setDate(nextResetDate.getDate() + config.periodLengthDays);
    
    const entitlement = await Entitlement.findOneAndUpdate(
      {
        identifier,
        identifierType,
        entitlementType
      },
      {
        usedCount: 0,
        periodStart: now,
        nextResetDate,
        lastUsed: now,
        status: 'active'
      },
      { new: true, upsert: true }
    );
    
    return entitlement;
  } catch (error) {
    console.error('Error resetting entitlement:', error);
    return null;
  }
};

/**
 * Update entitlement configuration
 */
const updateEntitlementConfig = async (identifier, identifierType, entitlementType, updates) => {
  try {
    const entitlement = await Entitlement.findOneAndUpdate(
      {
        identifier,
        identifierType,
        entitlementType
      },
      updates,
      { new: true }
    );
    
    return entitlement;
  } catch (error) {
    console.error('Error updating entitlement config:', error);
    return null;
  }
};

module.exports = {
  checkEntitlementEligibility,
  consumeEntitlement,
  getEntitlementStats,
  resetEntitlement,
  updateEntitlementConfig,
  getEntitlementConfig,
  ENTITLEMENT_CONFIGS
}; 