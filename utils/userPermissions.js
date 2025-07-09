const { User } = require('../models/User');

/**
 * Get user permission limits and period from environment variables
 * @returns {Object} Configuration object with usage limit and period length
 */
const getPermissionConfig = () => {
  return {
    usageLimit: parseInt(process.env.ON_DEMAND_USAGE_LIMIT) || 10,
    periodLengthDays: parseInt(process.env.ON_DEMAND_PERIOD_DAYS) || 30,
    entitlementName: 'on-demand-runs' // Hard coded entitlement name
  };
};

/**
 * Check if a user's permission period has expired and needs to be reset
 * @param {Object} permissions - User's permissions object
 * @param {number} periodLengthDays - Period length in days
 * @returns {boolean} True if period has expired
 */
const isPeriodExpired = (permissions, periodLengthDays) => {
  if (!permissions || !permissions.periodStart) {
    return true; // No permissions set or no period start - treat as expired
  }
  
  const now = new Date();
  const periodStart = new Date(permissions.periodStart);
  const daysDiff = (now - periodStart) / (1000 * 60 * 60 * 24);
  
  return daysDiff >= periodLengthDays;
};

/**
 * Initialize or reset user permissions for a new period
 * @param {Object} user - User document
 * @param {Object} config - Permission configuration
 * @returns {Object} Updated permissions object
 */
const initializePermissions = (user, config) => {
  const newPermissions = {
    entitlementName: config.entitlementName,
    usageThisPeriod: 0,
    periodStart: new Date()
  };
  
  return newPermissions;
};

/**
 * Check if user is eligible for an on-demand run and get remaining quota
 * @param {string} userEmail - User's email address
 * @returns {Object} Eligibility result with remaining quota and eligibility status
 */
const checkOnDemandEligibility = async (userEmail) => {
  try {
    const config = getPermissionConfig();
    
    // Find user by email
    const user = await User.findOne({ email: userEmail });
    
    if (!user) {
      return {
        eligible: false,
        error: 'User not found',
        remainingRuns: 0,
        totalLimit: config.usageLimit,
        periodStart: null,
        nextResetDate: null
      };
    }
    
    let permissions = user.permissions;
    let needsUpdate = false;
    
    // If no permissions exist or period expired, initialize new period
    if (!permissions || isPeriodExpired(permissions, config.periodLengthDays)) {
      permissions = initializePermissions(user, config);
      needsUpdate = true;
    }
    
    // Calculate remaining runs
    const remainingRuns = Math.max(0, config.usageLimit - permissions.usageThisPeriod);
    const eligible = remainingRuns > 0;
    
    // Calculate next reset date
    const nextResetDate = new Date(permissions.periodStart);
    nextResetDate.setDate(nextResetDate.getDate() + config.periodLengthDays);
    
    // Update user permissions if needed
    if (needsUpdate) {
      await User.findByIdAndUpdate(user._id, { permissions });
    }
    
    return {
      eligible,
      remainingRuns,
      totalLimit: config.usageLimit,
      usedThisPeriod: permissions.usageThisPeriod,
      periodStart: permissions.periodStart,
      nextResetDate,
      daysUntilReset: Math.ceil((nextResetDate - new Date()) / (1000 * 60 * 60 * 24))
    };
  } catch (error) {
    console.error('Error checking on-demand eligibility:', error);
    return {
      eligible: false,
      error: 'Internal server error',
      remainingRuns: 0,
      totalLimit: 0,
      periodStart: null,
      nextResetDate: null
    };
  }
};

/**
 * Consume one on-demand run quota for a user
 * @param {string} userEmail - User's email address
 * @returns {Object} Result of quota consumption
 */
const consumeOnDemandQuota = async (userEmail) => {
  try {
    const config = getPermissionConfig();
    
    // Find user by email
    const user = await User.findOne({ email: userEmail });
    
    if (!user) {
      return {
        success: false,
        error: 'User not found',
        remainingRuns: 0,
        totalLimit: config.usageLimit
      };
    }
    
    let permissions = user.permissions;
    let needsUpdate = false;
    
    // If no permissions exist or period expired, initialize new period
    if (!permissions || isPeriodExpired(permissions, config.periodLengthDays)) {
      permissions = initializePermissions(user, config);
      needsUpdate = true;
    }
    
    // Check if limit exceeded
    if (permissions.usageThisPeriod >= config.usageLimit) {
      const nextResetDate = new Date(permissions.periodStart);
      nextResetDate.setDate(nextResetDate.getDate() + config.periodLengthDays);
      
      return {
        success: false,
        error: 'On-demand usage limit exceeded for this period',
        remainingRuns: 0,
        nextResetDate
      };
    }
    
    // Increment usage
    permissions.usageThisPeriod += 1;
    needsUpdate = true;
    
    // Update user permissions
    if (needsUpdate) {
      await User.findByIdAndUpdate(user._id, { permissions });
    }
    
    const remainingRuns = Math.max(0, config.usageLimit - permissions.usageThisPeriod);
    
    return {
      success: true,
      remainingRuns,
      usedThisPeriod: permissions.usageThisPeriod,
      totalLimit: config.usageLimit
    };
  } catch (error) {
    console.error('Error consuming on-demand quota:', error);
    return {
      success: false,
      error: 'Internal server error'
    };
  }
};

module.exports = {
  getPermissionConfig,
  isPeriodExpired,
  initializePermissions,
  checkOnDemandEligibility,
  consumeOnDemandQuota
}; 