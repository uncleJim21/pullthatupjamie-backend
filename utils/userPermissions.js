const { User } = require('../models/User');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

let sqliteDb;

// Initialize SQLite database for IP tracking
async function initializeIPOnDemandDB() {
    if (!sqliteDb) {
        sqliteDb = await open({
            filename: path.join('.', 'requests.db'),
            driver: sqlite3.Database,
        });
    }

    await sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS ip_ondemand_requests (
            ip TEXT PRIMARY KEY,
            request_count INTEGER DEFAULT 0,
            period_start INTEGER,
            last_request_at INTEGER
        )
    `);

    console.log('Initialized IP on-demand requests DB');
    return sqliteDb;
}

// Helper function to get current period start timestamp
const getCurrentPeriodStart = (periodLengthDays) => {
    const now = new Date();
    return Math.floor(now.getTime() / 1000);
};

// Wrapper for SQLite operations with timeout
const withTimeout = (promise, timeoutMs) => {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Operation timed out')), timeoutMs)
        ),
    ]);
};

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
 * Check if IP is eligible for an on-demand run and get remaining quota
 * @param {string} clientIp - Client IP address
 * @returns {Object} Eligibility result with remaining quota and eligibility status
 */
const checkIPOnDemandEligibility = async (clientIp) => {
  try {
    const config = getPermissionConfig();
    const currentPeriodStart = getCurrentPeriodStart(config.periodLengthDays);
    
    // Ensure database is initialized
    if (!sqliteDb) {
      await initializeIPOnDemandDB();
    }
    
    const row = await withTimeout(
      sqliteDb.get(
        `SELECT * FROM ip_ondemand_requests WHERE ip = ?`,
        [clientIp]
      ),
      5000 // 5 seconds timeout
    );
    
    if (!row) {
      return {
        eligible: true,
        remainingRuns: config.usageLimit,
        totalLimit: config.usageLimit,
        usedThisPeriod: 0,
        periodStart: new Date(currentPeriodStart * 1000),
        nextResetDate: new Date((currentPeriodStart + (config.periodLengthDays * 24 * 60 * 60)) * 1000),
        daysUntilReset: Math.ceil(((currentPeriodStart + (config.periodLengthDays * 24 * 60 * 60)) - Math.floor(Date.now() / 1000)) / (24 * 60 * 60))
      };
    }
    
    // Check if period has expired
    if (row.period_start < currentPeriodStart) {
      return {
        eligible: true,
        remainingRuns: config.usageLimit,
        totalLimit: config.usageLimit,
        usedThisPeriod: 0,
        periodStart: new Date(currentPeriodStart * 1000),
        nextResetDate: new Date((currentPeriodStart + (config.periodLengthDays * 24 * 60 * 60)) * 1000),
        daysUntilReset: Math.ceil(((currentPeriodStart + (config.periodLengthDays * 24 * 60 * 60)) - Math.floor(Date.now() / 1000)) / (24 * 60 * 60))
      };
    }
    
    const remainingRuns = Math.max(0, config.usageLimit - row.request_count);
    const eligible = remainingRuns > 0;
    
    return {
      eligible,
      remainingRuns,
      totalLimit: config.usageLimit,
      usedThisPeriod: row.request_count,
      periodStart: new Date(row.period_start * 1000),
      nextResetDate: new Date((row.period_start + (config.periodLengthDays * 24 * 60 * 60)) * 1000),
      daysUntilReset: Math.ceil(((row.period_start + (config.periodLengthDays * 24 * 60 * 60)) - Math.floor(Date.now() / 1000)) / (24 * 60 * 60))
    };
  } catch (error) {
    console.error('Error checking IP on-demand eligibility:', error);
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
 * Consume one on-demand run quota for an IP address
 * @param {string} clientIp - Client IP address
 * @returns {Object} Result of quota consumption
 */
const consumeIPOnDemandQuota = async (clientIp) => {
  try {
    const config = getPermissionConfig();
    const currentPeriodStart = getCurrentPeriodStart(config.periodLengthDays);
    
    // Ensure database is initialized
    if (!sqliteDb) {
      await initializeIPOnDemandDB();
    }
    
    const row = await withTimeout(
      sqliteDb.get(
        `SELECT * FROM ip_ondemand_requests WHERE ip = ?`,
        [clientIp]
      ),
      5000 // 5 seconds timeout
    );
    
    if (!row || row.period_start < currentPeriodStart) {
      // Create new record or reset for new period
      await sqliteDb.run(
        `INSERT OR REPLACE INTO ip_ondemand_requests (ip, request_count, period_start, last_request_at) VALUES (?, 1, ?, ?)`,
        [clientIp, currentPeriodStart, Math.floor(Date.now() / 1000)]
      );
      
      return {
        success: true,
        remainingRuns: config.usageLimit - 1,
        usedThisPeriod: 1,
        totalLimit: config.usageLimit
      };
    }
    
    // Check if limit exceeded
    if (row.request_count >= config.usageLimit) {
      return {
        success: false,
        error: 'IP on-demand usage limit exceeded for this period',
        remainingRuns: 0,
        nextResetDate: new Date((row.period_start + (config.periodLengthDays * 24 * 60 * 60)) * 1000)
      };
    }
    
    // Increment usage
    await sqliteDb.run(
      `UPDATE ip_ondemand_requests SET request_count = request_count + 1, last_request_at = ? WHERE ip = ?`,
      [Math.floor(Date.now() / 1000), clientIp]
    );
    
    return {
      success: true,
      remainingRuns: config.usageLimit - row.request_count - 1,
      usedThisPeriod: row.request_count + 1,
      totalLimit: config.usageLimit
    };
  } catch (error) {
    console.error('Error consuming IP on-demand quota:', error);
    return {
      success: false,
      error: 'Internal server error'
    };
  }
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
 * Supports both user-based (JWT) and IP-based authentication
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
    
    // If we have a user email, use the existing user-based system
    if (userEmail) {
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
      req.authType = 'user';
      
      return next();
    }
    
    // If no user email, fall back to IP-based tracking
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 
                     req.headers['x-real-ip'] || 
                     req.ip ||
                     req.connection.remoteAddress;
    
    if (!clientIp) {
      return res.status(401).json({
        error: 'Authentication required',
        details: 'Either JWT token or valid IP address required for on-demand access'
      });
    }
    
    // Check IP-based eligibility
    const ipEligibility = await checkIPOnDemandEligibility(clientIp);
    
    if (!ipEligibility.eligible) {
      return res.status(403).json({
        error: 'IP on-demand run limit exceeded',
        details: ipEligibility.error || 'You have reached your IP-based usage limit for this period',
        usageInfo: {
          remainingRuns: ipEligibility.remainingRuns,
          totalLimit: ipEligibility.totalLimit,
          nextResetDate: ipEligibility.nextResetDate,
          daysUntilReset: ipEligibility.daysUntilReset
        }
      });
    }
    
    // Store IP and eligibility info for later use
    req.clientIp = clientIp;
    req.eligibilityInfo = ipEligibility;
    req.authType = 'ip';
    
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
  getPermissionConfig,
  checkIPOnDemandEligibility,
  consumeIPOnDemandQuota,
  initializeIPOnDemandDB
}; 