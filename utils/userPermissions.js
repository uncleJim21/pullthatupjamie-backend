const { User } = require('../models/User');

/**
 * Get user permission limits and period from environment variables
 * @returns {Object} Configuration object with usage limit and period length
 */
const getPermissionConfig = () => {
  return {
    usageLimit: parseInt(process.env.ON_DEMAND_USAGE_LIMIT) || 2,
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
        error: 'User not found'
      };
    }
    
    let permissions = user.permissions;
    
    // If no permissions exist or period expired, initialize new period
    if (!permissions || isPeriodExpired(permissions, config.periodLengthDays)) {
      permissions = initializePermissions(user, config);
    }
    
    // Check if user has remaining quota
    if (permissions.usageThisPeriod >= config.usageLimit) {
      return {
        success: false,
        error: 'Usage limit exceeded for this period',
        remainingRuns: 0,
        nextResetDate: new Date(permissions.periodStart.getTime() + (config.periodLengthDays * 24 * 60 * 60 * 1000))
      };
    }
    
    // Increment usage
    permissions.usageThisPeriod += 1;
    
    // Update user permissions
    await User.findByIdAndUpdate(user._id, { permissions });
    
    const remainingRuns = config.usageLimit - permissions.usageThisPeriod;
    
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

/**
 * Middleware to check on-demand run eligibility before processing
 * Expects user email in req.user.email or extracted from JWT token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const checkOnDemandPermissions = async (req, res, next) => {
  try {
    // Extract user email from various possible sources
    let userEmail = null;
    
    // Try to get email from auth header (JWT token)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const jwt = require('jsonwebtoken');
      try {
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
        userEmail = decoded.email;
      } catch (jwtError) {
        console.error('JWT verification failed:', jwtError.message);
      }
    }
    
    // Try to get email from request body
    if (!userEmail && req.body && req.body.userEmail) {
      userEmail = req.body.userEmail;
    }
    
    // Try to get email from request user object (if set by previous middleware)
    if (!userEmail && req.user && req.user.email) {
      userEmail = req.user.email;
    }
    
    if (!userEmail) {
      return res.status(401).json({
        error: 'User authentication required',
        details: 'Could not determine user email for permissions check'
      });
    }
    
    // Check eligibility
    const eligibility = await checkOnDemandEligibility(userEmail);
    
    if (!eligibility.eligible) {
      return res.status(403).json({
        error: 'On-demand run limit exceeded',
        details: eligibility.error || 'You have reached your usage limit for this period',
        usageInfo: {
          remainingRuns: eligibility.remainingRuns,
          totalLimit: eligibility.totalLimit,
          nextResetDate: eligibility.nextResetDate,
          daysUntilReset: eligibility.daysUntilReset
        }
      });
    }
    
    // Store user email and eligibility info for later use
    req.userEmail = userEmail;
    req.eligibilityInfo = eligibility;
    
    next();
  } catch (error) {
    console.error('Error in on-demand permissions middleware:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: 'Failed to check permissions'
    });
  }
};

module.exports = {
  checkOnDemandEligibility,
  consumeOnDemandQuota,
  checkOnDemandPermissions,
  getPermissionConfig
}; 