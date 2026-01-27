/**
 * Entitlement Middleware Factory
 * 
 * Creates Express middleware that checks and consumes entitlements.
 * Works with the identity resolver to determine user tier and quotas.
 */

const { resolveIdentity, TIERS } = require('./identityResolver');
const { Entitlement } = require('../models/Entitlement');

const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

/**
 * PRODUCTION Quota configurations per tier per entitlement type
 * 
 * Structure: { [entitlementType]: { [tier]: { maxUsage, periodLengthDays } } }
 * 
 * Use -1 for unlimited
 */
const QUOTA_CONFIG_PRODUCTION = {
  // Search quotes (basic search)
  searchQuotes: {
    [TIERS.anonymous]: { maxUsage: 100, periodLengthDays: 7 },    // 100/week
    [TIERS.registered]: { maxUsage: 100, periodLengthDays: 30 },  // 100/month
    [TIERS.subscriber]: { maxUsage: 500, periodLengthDays: 30 },  // 500/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  },
  
  // 3D search (expensive: embeddings + UMAP)
  search3D: {
    [TIERS.anonymous]: { maxUsage: 20, periodLengthDays: 7 },     // 20/week
    [TIERS.registered]: { maxUsage: 20, periodLengthDays: 30 },   // 20/month
    [TIERS.subscriber]: { maxUsage: 100, periodLengthDays: 30 },  // 100/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  },
  
  // Make clip (video processing)
  makeClip: {
    [TIERS.anonymous]: { maxUsage: 5, periodLengthDays: 7 },      // 5/week
    [TIERS.registered]: { maxUsage: 10, periodLengthDays: 30 },   // 10/month
    [TIERS.subscriber]: { maxUsage: 50, periodLengthDays: 30 },   // 50/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  },
  
  // Jamie Assist (AI analysis)
  jamieAssist: {
    [TIERS.anonymous]: { maxUsage: 10, periodLengthDays: 7 },     // 10/week
    [TIERS.registered]: { maxUsage: 20, periodLengthDays: 30 },   // 20/month
    [TIERS.subscriber]: { maxUsage: 100, periodLengthDays: 30 },  // 100/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  },
  
  // On-demand run (podcast processing)
  onDemandRun: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 7 },      // 2/week
    [TIERS.registered]: { maxUsage: 5, periodLengthDays: 30 },    // 5/month
    [TIERS.subscriber]: { maxUsage: 20, periodLengthDays: 30 },   // 20/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  },
  
  // Research Analyze (AI analysis of research sessions)
  researchAnalyze: {
    [TIERS.anonymous]: { maxUsage: 10, periodLengthDays: 7 },     // 10/week
    [TIERS.registered]: { maxUsage: 20, periodLengthDays: 30 },   // 20/month
    [TIERS.subscriber]: { maxUsage: 100, periodLengthDays: 30 },  // 100/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  }
};

/**
 * DEBUG Quota configurations - LOW LIMITS for testing
 * 
 * All limits are set to 3 (except admin which stays unlimited)
 * Period is 1 day for quick reset testing
 */
const QUOTA_CONFIG_DEBUG = {
  searchQuotes: {
    [TIERS.anonymous]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  search3D: {
    [TIERS.anonymous]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  makeClip: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  jamieAssist: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  onDemandRun: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  researchAnalyze: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  }
};

// Select config based on DEBUG_MODE
const QUOTA_CONFIG = DEBUG_MODE ? QUOTA_CONFIG_DEBUG : QUOTA_CONFIG_PRODUCTION;

if (DEBUG_MODE) {
  console.log('[ENTITLEMENT] ⚠️  DEBUG_MODE enabled - using LOW LIMITS for testing');
}

/**
 * All entitlement types that should be checked in bulk eligibility
 */
const ALL_ENTITLEMENT_TYPES = [
  'searchQuotes',
  'search3D', 
  'makeClip',
  'jamieAssist',
  'researchAnalyze',
  'onDemandRun'
];

/**
 * Get quota config for a specific entitlement type and tier
 */
function getQuotaConfig(entitlementType, tier) {
  const typeConfig = QUOTA_CONFIG[entitlementType];
  if (!typeConfig) {
    console.warn(`[ENTITLEMENT] Unknown entitlement type: ${entitlementType}`);
    return { maxUsage: 10, periodLengthDays: 30 }; // Safe default
  }
  
  return typeConfig[tier] || typeConfig[TIERS.anonymous]; // Fallback to anonymous
}

/**
 * Check if period has expired
 */
function isPeriodExpired(periodStart, periodLengthDays) {
  if (!periodStart) return true;
  
  const now = new Date();
  const periodEnd = new Date(periodStart);
  periodEnd.setDate(periodEnd.getDate() + periodLengthDays);
  
  return now >= periodEnd;
}

/**
 * Get or create entitlement record
 */
async function getOrCreateEntitlement(identifier, identifierType, entitlementType, tier) {
  const config = getQuotaConfig(entitlementType, tier);
  
  // Find existing entitlement
  let entitlement = await Entitlement.findOne({
    identifier,
    identifierType,
    entitlementType
  });
  
  // If exists and not expired, check if tier changed (upgrade quota if needed)
  if (entitlement && !isPeriodExpired(entitlement.periodStart, entitlement.periodLengthDays)) {
    // If tier upgraded and new maxUsage is higher, update it
    if (config.maxUsage > entitlement.maxUsage || config.maxUsage === -1) {
      entitlement.maxUsage = config.maxUsage;
      await entitlement.save();
    }
    return entitlement;
  }
  
  // Create or reset entitlement
  const now = new Date();
  const nextResetDate = new Date(now);
  nextResetDate.setDate(nextResetDate.getDate() + config.periodLengthDays);
  
  entitlement = await Entitlement.findOneAndUpdate(
    { identifier, identifierType, entitlementType },
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
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  
  return entitlement;
}

/**
 * DEBUG_MODE Mock Responses
 * 
 * When DEBUG_MODE=true, these entitlement types return mock data instead of
 * calling expensive external services (Pinecone, OpenAI embeddings, etc.)
 * 
 * ⚠️  SAFETY: Only runs when DEBUG_MODE=true (checked at runtime)
 */
const DEBUG_MOCK_TYPES = ['search3D', 'searchQuotes'];

function generateDebugMockResponse(entitlementType, query) {
  const mockResults = [];
  const numResults = entitlementType === 'search3D' ? 10 : 5;
  
  for (let i = 0; i < numResults; i++) {
    const result = {
      id: `mock-${i}`,
      pineconeId: `mock-pinecone-${i}`,
      score: 0.95 - (i * 0.05),
      text: `Mock result ${i + 1} for query "${query}". DEBUG_MODE mock response.`,
      episode: `Mock Episode ${i + 1}`,
      feedId: '123456',
      feedTitle: 'Mock Podcast Feed',
      publishedDate: new Date().toISOString(),
      startTime: i * 60,
      endTime: (i + 1) * 60
    };
    
    // Add 3D coordinates for search3D
    if (entitlementType === 'search3D') {
      result.coordinates = {
        x: Math.random() * 2 - 1,
        y: Math.random() * 2 - 1,
        z: Math.random() * 2 - 1
      };
    }
    
    mockResults.push(result);
  }
  
  return {
    success: true,
    _debug: true,
    _debugMessage: 'DEBUG_MODE: Mock response - external services not called',
    query,
    results: mockResults,
    resultCount: mockResults.length,
    timings: { embedding: 50, search: 100, total: 150 }
  };
}

/**
 * Create entitlement-checking middleware
 * 
 * @param {string} entitlementType - Type of entitlement to check
 * @param {object} options - Additional options
 * @param {boolean} options.consumeOnSuccess - Whether to consume entitlement after successful request (default: false)
 * @param {boolean} options.allowAnonymous - Whether to allow anonymous users (default: true)
 * 
 * @returns {Function} Express middleware
 */
function createEntitlementMiddleware(entitlementType, options = {}) {
  const { 
    consumeOnSuccess = false,
    allowAnonymous = true 
  } = options;
  
  return async (req, res, next) => {
    try {
      // Resolve identity
      const identity = await resolveIdentity(req);
      
      // Check if anonymous is allowed
      if (!allowAnonymous && identity.tier === TIERS.anonymous) {
        return res.status(401).json({
          error: 'Authentication required',
          code: 'AUTH_REQUIRED'
        });
      }
      
      // Get or create entitlement
      const entitlement = await getOrCreateEntitlement(
        identity.identifier,
        identity.identifierType,
        entitlementType,
        identity.tier
      );
      
      // Check if unlimited (-1)
      const isUnlimited = entitlement.maxUsage === -1;
      
      // Check eligibility
      if (!isUnlimited && entitlement.usedCount >= entitlement.maxUsage) {
        return res.status(429).json({
          error: 'Quota exceeded',
          code: 'QUOTA_EXCEEDED',
          used: entitlement.usedCount,
          max: entitlement.maxUsage,
          resetDate: entitlement.nextResetDate,
          daysUntilReset: Math.ceil((entitlement.nextResetDate - new Date()) / (1000 * 60 * 60 * 24)),
          tier: identity.tier
        });
      }
      
      // Consume entitlement now (before request processing)
      if (!isUnlimited) {
        entitlement.usedCount += 1;
        entitlement.lastUsed = new Date();
        await entitlement.save();
      }
      
      // Attach to request for downstream use
      req.identity = identity;
      req.entitlement = {
        type: entitlementType,
        used: entitlement.usedCount,
        max: entitlement.maxUsage,
        remaining: isUnlimited ? Infinity : Math.max(0, entitlement.maxUsage - entitlement.usedCount),
        isUnlimited,
        resetDate: entitlement.nextResetDate
      };
      
      // Add quota headers
      res.setHeader('X-Quota-Used', entitlement.usedCount);
      res.setHeader('X-Quota-Max', isUnlimited ? 'unlimited' : entitlement.maxUsage);
      res.setHeader('X-Quota-Remaining', isUnlimited ? 'unlimited' : Math.max(0, entitlement.maxUsage - entitlement.usedCount));
      res.setHeader('X-Quota-Reset', entitlement.nextResetDate.toISOString());
      
      // ═══════════════════════════════════════════════════════════════════════
      // DEBUG_MODE: Return mock response for expensive operations
      // ⚠️  SAFETY: Triple-checked - only runs when DEBUG_MODE=true at runtime
      // ═══════════════════════════════════════════════════════════════════════
      if (DEBUG_MODE && 
          process.env.DEBUG_MODE === 'true' && 
          DEBUG_MOCK_TYPES.includes(entitlementType) &&
          req.method === 'POST') {
        const query = req.body?.query || 'test query';
        console.log(`[ENTITLEMENT] ⚠️  DEBUG_MODE: Returning mock response for ${entitlementType}`);
        return res.json(generateDebugMockResponse(entitlementType, query));
      }
      
      next();
      
    } catch (error) {
      console.error(`[ENTITLEMENT] Middleware error for ${entitlementType}:`, error);
      return res.status(500).json({
        error: 'Internal server error',
        code: 'ENTITLEMENT_ERROR'
      });
    }
  };
}

/**
 * Middleware to just resolve identity without checking entitlements
 * Useful for routes that need user info but don't have quotas
 */
async function identityMiddleware(req, res, next) {
  try {
    req.identity = await resolveIdentity(req);
    next();
  } catch (error) {
    console.error('[IDENTITY] Middleware error:', error);
    req.identity = {
      tier: TIERS.anonymous,
      identifier: req.ip || 'unknown',
      identifierType: 'ip',
      user: null,
      provider: null,
      email: null
    };
    next();
  }
}

/**
 * Require authentication middleware (no entitlement check)
 */
async function requireAuth(req, res, next) {
  const identity = await resolveIdentity(req);
  
  if (identity.tier === TIERS.anonymous) {
    return res.status(401).json({
      error: 'Authentication required',
      code: 'AUTH_REQUIRED'
    });
  }
  
  req.identity = identity;
  next();
}

/**
 * Check eligibility for ALL entitlement types at once
 * 
 * @param {string} identifier - User ID or IP address
 * @param {string} identifierType - 'mongoUserId' or 'ip'
 * @param {string} tier - User tier for quota lookup
 * @returns {Promise<Object>} - Map of entitlementType -> eligibility info
 */
async function checkAllEligibility(identifier, identifierType, tier) {
  const results = {};
  
  // Fetch all existing entitlements for this user in one query
  const existingEntitlements = await Entitlement.find({
    identifier,
    identifierType
  }).lean();
  
  // Create a map for quick lookup
  const entitlementMap = new Map(
    existingEntitlements.map(e => [e.entitlementType, e])
  );
  
  // Check each entitlement type
  for (const entitlementType of ALL_ENTITLEMENT_TYPES) {
    const config = getQuotaConfig(entitlementType, tier);
    const existing = entitlementMap.get(entitlementType);
    
    // Check if period expired
    const isExpired = existing ? isPeriodExpired(existing.periodStart, existing.periodLengthDays) : true;
    
    // Calculate values
    let used = 0;
    let max = config.maxUsage;
    let periodStart = new Date();
    let nextResetDate = new Date();
    nextResetDate.setDate(nextResetDate.getDate() + config.periodLengthDays);
    
    if (existing && !isExpired) {
      used = existing.usedCount;
      max = Math.max(existing.maxUsage, config.maxUsage); // Use higher if tier upgraded
      periodStart = existing.periodStart;
      nextResetDate = existing.nextResetDate;
    }
    
    const isUnlimited = max === -1;
    const remaining = isUnlimited ? Infinity : Math.max(0, max - used);
    const eligible = isUnlimited || remaining > 0;
    
    results[entitlementType] = {
      used,
      max: isUnlimited ? 'unlimited' : max,
      remaining: isUnlimited ? 'unlimited' : remaining,
      eligible,
      isUnlimited,
      periodLengthDays: config.periodLengthDays,
      periodStart,
      nextResetDate,
      daysUntilReset: Math.max(0, Math.ceil((nextResetDate - new Date()) / (1000 * 60 * 60 * 24)))
    };
  }
  
  return results;
}

module.exports = {
  createEntitlementMiddleware,
  identityMiddleware,
  requireAuth,
  getQuotaConfig,
  getOrCreateEntitlement,
  checkAllEligibility,
  QUOTA_CONFIG,
  ALL_ENTITLEMENT_TYPES,
  TIERS
};
