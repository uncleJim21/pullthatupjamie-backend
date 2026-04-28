/**
 * Entitlement Middleware Factory
 * 
 * Creates Express middleware that checks and consumes entitlements.
 * Works with the identity resolver to determine user tier and quotas.
 */

const { resolveIdentity, TIERS } = require('./identityResolver');
const { Entitlement } = require('../models/Entitlement');
const { AgentInvoice } = require('../models/AgentInvoice');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { ENTITLEMENT_TYPES, ALL_ENTITLEMENT_TYPES } = require('../constants/entitlementTypes');
const { emitServerEvent } = require('./analyticsEmitter');
const { SERVER_EVENT_TYPES } = require('../constants/analyticsTypes');
const { getAgentCostMicroUsd, DEFAULT_CREDIT_PURCHASE_SATS, AGENT_MIN_DEPOSIT_SATS, AGENT_MAX_DEPOSIT_SATS, AGENT_PRICING_MICRO_USD, computeDefaultSatsForEndpoint } = require('../constants/agentPricing');
const { isLightningAvailable, microUsdToUsd, getBtcUsdRate, satsToUsdMicro } = require('./btcPrice');
const { generateInvoiceForSats } = require('./lightning-utils');
const { mintMacaroon, buildWwwAuthenticateHeader } = require('./macaroon-utils');

const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

/**
 * Generate a 402 Payment Required response with L402 challenge.
 * Creates a Lightning invoice and macaroon for the agent to pay.
 * 
 * Supports optional ?amountSats=N query param for custom credit amounts.
 * 
 * @param {object} req - Express request (reads amountSats from query)
 * @param {object} res - Express response
 * @param {object} options - Additional context for the response body
 * @returns {Promise<object>} The response (already sent)
 */
async function send402Challenge(req, res, options = {}) {
  try {
    console.log('[L402-DEBUG] send402Challenge triggered', {
      path: req.path,
      method: req.method,
      detail: options.detail,
      code: options.extra?.code
    });

    console.log('[L402-DEBUG] Checking isLightningAvailable...');
    if (!isLightningAvailable()) {
      console.log('[L402-DEBUG] Lightning not available — attempting synchronous price fetch...');
      try {
        await getBtcUsdRate();
      } catch (priceErr) {
        console.error('[L402-DEBUG] Price fetch failed:', priceErr.message);
      }

      if (!isLightningAvailable()) {
        console.log('[L402-DEBUG] Lightning still NOT available after fetch attempt');
        return res.status(503).json({
          error: 'Lightning services temporarily unavailable',
          code: 'LIGHTNING_UNAVAILABLE'
        });
      }
      console.log('[L402-DEBUG] Price fetch succeeded, lightning now available');
    } else {
      console.log('[L402-DEBUG] Lightning is available');
    }

    console.log('[L402-DEBUG] Fetching BTC/USD rate...');
    const { rate: btcUsdRate } = await getBtcUsdRate();
    console.log('[L402-DEBUG] BTC/USD rate:', btcUsdRate);

    // Size the default invoice to cover exactly one call for this endpoint
    // (plus a small buffer) when the caller tells us which endpoint they're
    // protecting. Falls back to the global DEFAULT_CREDIT_PURCHASE_SATS when
    // the endpoint is unpriced or no entitlementType was supplied.
    let defaultSats = DEFAULT_CREDIT_PURCHASE_SATS;
    if (options.entitlementType) {
      const endpointDefault = computeDefaultSatsForEndpoint(options.entitlementType, btcUsdRate);
      if (endpointDefault) defaultSats = endpointDefault;
    }

    let amountSats = defaultSats;
    const requestedAmount = parseInt(req.query?.amountSats, 10);
    if (!isNaN(requestedAmount)) {
      if (requestedAmount < AGENT_MIN_DEPOSIT_SATS || requestedAmount > AGENT_MAX_DEPOSIT_SATS) {
        return res.status(400).json({
          error: 'Invalid amountSats',
          message: `amountSats must be between ${AGENT_MIN_DEPOSIT_SATS} and ${AGENT_MAX_DEPOSIT_SATS}`,
          minSats: AGENT_MIN_DEPOSIT_SATS,
          maxSats: AGENT_MAX_DEPOSIT_SATS
        });
      }
      amountSats = requestedAmount;
    }

    const amountUsdMicro = satsToUsdMicro(amountSats);
    const amountUsd = microUsdToUsd(amountUsdMicro);
    console.log('[L402-DEBUG] Amount:', { amountSats, amountUsdMicro, amountUsd });

    console.log('[L402-DEBUG] Generating invoice via Alby...', {
      hasAlbyWalletApiKey: !!process.env.ALBY_WALLET_API_KEY,
      hasAlbyHubToken: !!process.env.ALBY_HUB_TOKEN
    });
    const invoice = await generateInvoiceForSats(amountSats);
    console.log('[L402-DEBUG] Invoice generated:', {
      paymentHash: invoice.paymentHash,
      expiresAt: invoice.expiresAt,
      prLength: invoice.pr?.length
    });

    console.log('[L402-DEBUG] Minting macaroon...', {
      hasL402Secret: !!process.env.L402_MACAROON_SECRET
    });
    const { macaroonBase64 } = mintMacaroon(invoice.paymentHash);
    console.log('[L402-DEBUG] Macaroon minted, length:', macaroonBase64?.length);

    console.log('[L402-DEBUG] Creating AgentInvoice in MongoDB...');
    await AgentInvoice.create({
      paymentHash: invoice.paymentHash,
      invoiceStr: invoice.pr,
      amountSats,
      amountUsdMicro,
      btcUsdRate,
      clientId: options.clientId || null,
      status: 'pending',
      expiresAt: invoice.expiresAt
    });
    console.log('[L402-DEBUG] AgentInvoice stored');

    res.setHeader('WWW-Authenticate', buildWwwAuthenticateHeader(macaroonBase64, invoice.pr));

    console.log('[L402-DEBUG] Sending 402 response');
    return res.status(402).json({
      type: 'https://pullthatupjamie.ai/l402/payment-required',
      title: 'Payment Required',
      status: 402,
      detail: options.detail || 'Purchase credits to access this endpoint. Pay the Lightning invoice, then retry with Authorization: L402 <macaroon>:<preimage>',
      macaroon: macaroonBase64,
      invoice: invoice.pr,
      paymentHash: invoice.paymentHash,
      amountSats,
      amountUsd: parseFloat(amountUsd.toFixed(6)),
      btcUsdRate,
      expiresAt: invoice.expiresAt,
      creditInfo: {
        model: 'credit',
        service: 'pullthatupjamie',
        message: 'Pay the Lightning invoice to receive credits for pullthatupjamie.ai. Each API call deducts its cost from your balance. You may reuse the same L402 credential across all endpoints until depleted, or pay per query — your choice.',
        customAmount: `To request a different amount, add ?amountSats=N to any request (min: ${AGENT_MIN_DEPOSIT_SATS}, max: ${AGENT_MAX_DEPOSIT_SATS})`,
        defaultSats,
        globalDefaultSats: DEFAULT_CREDIT_PURCHASE_SATS,
        minSats: AGENT_MIN_DEPOSIT_SATS,
        maxSats: AGENT_MAX_DEPOSIT_SATS,
        balanceEndpoint: '/api/agent/balance',
        responseHeaders: ['X-Credits-Remaining-USD', 'X-Credits-Cost-USD'],
        pricingMicroUsd: AGENT_PRICING_MICRO_USD
      },
      ...options.extra
    });
  } catch (err) {
    console.error('[L402-DEBUG] send402Challenge CAUGHT ERROR:', {
      message: err.message,
      stack: err.stack,
      name: err.name,
      code: err.code,
      response: err.response?.status,
      responseData: err.response?.data
    });
    return res.status(500).json({
      error: 'Failed to generate payment challenge',
      code: 'CHALLENGE_ERROR'
    });
  }
}

/**
 * PRODUCTION Quota configurations per tier per entitlement type
 * 
 * Structure: { [entitlementType]: { [tier]: { maxUsage, periodLengthDays } } }
 * 
 * Use -1 for unlimited
 */
const QUOTA_CONFIG_PRODUCTION = {
  // Search quotes (basic search)
  [ENTITLEMENT_TYPES.SEARCH_QUOTES]: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 7 },    // 100/week
    [TIERS.registered]: { maxUsage: 50, periodLengthDays: 30 },  // 100/month
    [TIERS.subscriber]: { maxUsage: 500, periodLengthDays: 30 },  // 500/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  },
  
  // 3D search (expensive: embeddings + UMAP)
  [ENTITLEMENT_TYPES.SEARCH_QUOTES_3D]: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 7 },     // 20/week
    [TIERS.registered]: { maxUsage: 20, periodLengthDays: 30 },   // 20/month
    [TIERS.subscriber]: { maxUsage: 100, periodLengthDays: 30 },  // 100/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  },
  
  // Make clip (video processing)
  [ENTITLEMENT_TYPES.MAKE_CLIP]: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 7 },      // 5/week
    [TIERS.registered]: { maxUsage: 10, periodLengthDays: 30 },   // 10/month
    [TIERS.subscriber]: { maxUsage: 50, periodLengthDays: 30 },   // 50/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  },
  
  // Jamie Assist (AI analysis)
  [ENTITLEMENT_TYPES.JAMIE_ASSIST]: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 7 },     // 10/week
    [TIERS.registered]: { maxUsage: 20, periodLengthDays: 30 },   // 20/month
    [TIERS.subscriber]: { maxUsage: 100, periodLengthDays: 30 },  // 100/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  },
  
  // On-demand run (podcast processing)
  [ENTITLEMENT_TYPES.SUBMIT_ON_DEMAND_RUN]: {
    [TIERS.anonymous]: { maxUsage: 1, periodLengthDays: 7 },      // 2/week
    [TIERS.registered]: { maxUsage: 5, periodLengthDays: 30 },    // 5/month
    [TIERS.subscriber]: { maxUsage: 20, periodLengthDays: 30 },   // 20/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  },
  
  // Research Analyze (AI analysis of research sessions)
  [ENTITLEMENT_TYPES.AI_ANALYZE]: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 7 },     // 10/week
    [TIERS.registered]: { maxUsage: 20, periodLengthDays: 30 },   // 20/month
    [TIERS.subscriber]: { maxUsage: 100, periodLengthDays: 30 },  // 100/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }         // Unlimited
  },

  // Twitter posting (~$0.01/tweet, Nostr is free and unlimited)
  [ENTITLEMENT_TYPES.TWITTER_POST]: {
    [TIERS.anonymous]: { maxUsage: 0, periodLengthDays: 30 },      // Must have account
    [TIERS.registered]: { maxUsage: 60, periodLengthDays: 30 },    // 60/month (~$0.60)
    [TIERS.subscriber]: { maxUsage: 200, periodLengthDays: 30 },   // 200/month (~$2.00)
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }          // Unlimited
  },

  // Podcast discovery (LLM extraction + Podcast Index search)
  [ENTITLEMENT_TYPES.DISCOVER_PODCASTS]: {
    [TIERS.anonymous]: { maxUsage: 3, periodLengthDays: 7 },      // 10/week
    [TIERS.registered]: { maxUsage: 30, periodLengthDays: 30 },    // 30/month
    [TIERS.subscriber]: { maxUsage: 150, periodLengthDays: 30 },   // 150/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }          // Unlimited
  },

  // Chapter search (keyword search across corpus chapters)
  [ENTITLEMENT_TYPES.CHAPTER_SEARCH]: {
    [TIERS.anonymous]: { maxUsage: 3, periodLengthDays: 7 },      // 30/week
    [TIERS.registered]: { maxUsage: 50, periodLengthDays: 30 },    // 50/month
    [TIERS.subscriber]: { maxUsage: 200, periodLengthDays: 30 },   // 200/month
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 30 }          // Unlimited
  },

  // Pull (LLM-orchestrated corpus query, $0.10 per pull)
  [ENTITLEMENT_TYPES.PULL]: {
    [TIERS.anonymous]: { maxUsage: 7, periodLengthDays: 30 },       // 7/month
    [TIERS.registered]: { maxUsage: 15, periodLengthDays: 30 },    // 10/month
    [TIERS.subscriber]: { maxUsage: 50, periodLengthDays: 30 },    // 50/month
    [TIERS.admin]: { maxUsage: 250, periodLengthDays: 30 }         // 250/month (safety cap, was unlimited)
  }
};

/**
 * DEBUG Quota configurations - LOW LIMITS for testing
 * 
 * All limits are set to 3 (except admin which stays unlimited)
 * Period is 1 day for quick reset testing
 */
const QUOTA_CONFIG_DEBUG = {
  [ENTITLEMENT_TYPES.SEARCH_QUOTES]: {
    [TIERS.anonymous]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  [ENTITLEMENT_TYPES.SEARCH_QUOTES_3D]: {
    [TIERS.anonymous]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  [ENTITLEMENT_TYPES.MAKE_CLIP]: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  [ENTITLEMENT_TYPES.JAMIE_ASSIST]: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  [ENTITLEMENT_TYPES.SUBMIT_ON_DEMAND_RUN]: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  [ENTITLEMENT_TYPES.AI_ANALYZE]: {
    [TIERS.anonymous]: { maxUsage: 2, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  [ENTITLEMENT_TYPES.TWITTER_POST]: {
    [TIERS.anonymous]: { maxUsage: 0, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  [ENTITLEMENT_TYPES.DISCOVER_PODCASTS]: {
    [TIERS.anonymous]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  [ENTITLEMENT_TYPES.CHAPTER_SEARCH]: {
    [TIERS.anonymous]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.registered]: { maxUsage: 3, periodLengthDays: 1 },
    [TIERS.subscriber]: { maxUsage: 5, periodLengthDays: 1 },
    [TIERS.admin]: { maxUsage: -1, periodLengthDays: 1 }
  },
  [ENTITLEMENT_TYPES.PULL]: {
    [TIERS.anonymous]: { maxUsage: 1, periodLengthDays: 1 },
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

// ALL_ENTITLEMENT_TYPES is now imported from constants/entitlementTypes.js

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
 * When DEBUG_MODE=true, these entitlement types return mock data from
 * jamieVectorMetadata instead of calling expensive external services.
 * 
 * ⚠️  SAFETY: Only runs when DEBUG_MODE=true (checked at runtime)
 */
const DEBUG_MOCK_TYPES = [ENTITLEMENT_TYPES.SEARCH_QUOTES_3D, ENTITLEMENT_TYPES.SEARCH_QUOTES];

async function generateDebugMockResponse(entitlementType, query) {
  const numResults = entitlementType === ENTITLEMENT_TYPES.SEARCH_QUOTES_3D ? 20 : 10;
  
  // Pull real paragraph documents from jamieVectorMetadata
  const realDocs = await JamieVectorMetadata.find({ type: 'paragraph' })
    .limit(numResults)
    .lean();
  
  const results = realDocs.map((doc, i) => ({
    shareLink: doc.pineconeId,
    shareUrl: `https://pullthatupjamie.ai/share?clip=${doc.pineconeId}`,
    listenLink: doc.listenLink || '',
    quote: doc.text || doc.metadataRaw?.text || 'Mock quote text',
    summary: null,
    headline: null,
    description: null,
    episode: doc.episode || doc.metadataRaw?.episode || 'Mock Episode',
    creator: doc.creator || doc.metadataRaw?.creator || 'Mock Creator',
    audioUrl: doc.audioUrl || doc.metadataRaw?.audioUrl || '',
    episodeImage: doc.episodeImage || doc.metadataRaw?.episodeImage || '',
    date: doc.publishedDate || 'Date not provided',
    published: doc.publishedDate || null,
    similarity: {
      combined: 0.95 - (i * 0.02),
      vector: 0.95 - (i * 0.02)
    },
    timeContext: {
      start_time: doc.start_time || doc.metadataRaw?.start_time || 0,
      end_time: doc.end_time || doc.metadataRaw?.end_time || 60
    },
    additionalFields: {
      feedId: doc.feedId || doc.metadataRaw?.feedId,
      guid: doc.guid || doc.metadataRaw?.guid,
      sequence: doc.metadataRaw?.sequence || i,
      num_words: doc.metadataRaw?.num_words || 10
    },
    hierarchyLevel: 'paragraph',
    coordinates3d: {
      x: Math.random() * 2 - 1,
      y: Math.random() * 2 - 1,
      z: Math.random() * 2 - 1
    }
  }));
  
  return {
    query,
    results,
    total: results.length,
    model: 'text-embedding-ada-002',
    metadata: {
      numResults: results.length,
      embeddingTimeMs: 50,
      searchTimeMs: 100,
      mongoLookupTimeMs: 50,
      totalTimeMs: 200,
      fastMode: true,
      umapConfig: 'debug-mock',
      approach: 'debug-mock-from-jamieVectorMetadata'
    },
    axisLabels: {
      center: 'Debug Mock',
      xPositive: 'Topic A',
      xNegative: 'Topic B',
      yPositive: 'Topic C',
      yNegative: 'Topic D',
      zPositive: 'Topic E',
      zNegative: 'Topic F'
    },
    _debug: true,
    _debugMessage: 'DEBUG_MODE: Real docs from jamieVectorMetadata, no Pinecone/OpenAI calls'
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
      
      // Read analytics session ID from header (for server-side event emission)
      const analyticsSessionId = req.headers['x-pulse-session'] || req.headers['x-analytics-session'] || null;
      
      // ═══════════════════════════════════════════════════════════════════════
      // L402-first: anonymous users on priced endpoints get an immediate 402
      // unless they explicitly opt in to the free tier via X-Free-Tier header.
      // This ensures 402 Index and other L402 verifiers see a proper paywall.
      // Webapp/browser clients should send X-Free-Tier: true to use free quota.
      // ═══════════════════════════════════════════════════════════════════════
      const freeTierRequested = req.headers['x-free-tier'] === 'true';
      if (identity.tier === TIERS.anonymous && !freeTierRequested) {
        const costMicroUsd = getAgentCostMicroUsd(entitlementType);
        if (costMicroUsd !== null) {
          return send402Challenge(req, res, {
            detail: 'Payment required. Pay the Lightning invoice to access this endpoint. Add X-Free-Tier: true header to use the free quota instead.',
            entitlementType,
            extra: { code: 'PAYMENT_REQUIRED' }
          });
        }
      }

      // Check if anonymous is allowed
      if (!allowAnonymous && identity.tier === TIERS.anonymous) {
        const costMicroUsd = getAgentCostMicroUsd(entitlementType);
        if (costMicroUsd !== null) {
          return send402Challenge(req, res, {
            detail: 'Authentication required. Pay the Lightning invoice to get access.',
            entitlementType,
            extra: { code: 'AUTH_REQUIRED' }
          });
        }
        return res.status(401).json({
          error: 'Authentication required',
          code: 'AUTH_REQUIRED'
        });
      }
      
      // ═══════════════════════════════════════════════════════════════════════
      // Lightning agent path: deduct USD microdollars from balance per call
      // ═══════════════════════════════════════════════════════════════════════
      if (identity.identifierType === 'prepaid') {
        // Stateless L402 clients often replay the original URL (including any
        // ?amountSats query param) with the newly-minted Authorization header
        // on their retry. Rather than hard-failing, silently ignore the
        // sizing hint — the existing balance is what gets debited.
        if (req.query?.amountSats !== undefined) {
          console.warn('[L402] Ignoring ?amountSats — valid prepaid credential present, debiting existing balance', {
            path: req.path,
            amountSatsRequested: req.query.amountSats,
            identifier: identity.identifier
          });
        }

        const costMicroUsd = getAgentCostMicroUsd(entitlementType);

        if (costMicroUsd === null) {
          return res.status(403).json({
            error: 'Not available for agent access',
            code: 'AGENT_ENDPOINT_NOT_PRICED',
            message: `Endpoint ${entitlementType} is not available via Lightning agent access`
          });
        }

        // Look up the lightning entitlement (apiAccess, keyed by paymentHash)
        const lightningEntitlement = await Entitlement.findOne({
          identifier: identity.identifier,
          identifierType: 'prepaid',
          entitlementType: 'apiAccess',
          status: 'active'
        });

        if (!lightningEntitlement) {
          return send402Challenge(req, res, {
            detail: 'No active credit balance. Pay the invoice to purchase credits.',
            entitlementType,
            extra: { code: 'NO_BALANCE' }
          });
        }

        const remainingMicroUsd = lightningEntitlement.maxUsage - lightningEntitlement.usedCount;

        if (remainingMicroUsd < costMicroUsd) {
          return send402Challenge(req, res, {
            detail: 'Insufficient funds. Pay the invoice to top up your balance.',
            entitlementType,
            extra: {
              code: 'INSUFFICIENT_FUNDS',
              costUsd: parseFloat(microUsdToUsd(costMicroUsd).toFixed(6)),
              balanceUsd: parseFloat(microUsdToUsd(remainingMicroUsd).toFixed(6))
            }
          });
        }

        // Deduct usage (in microdollars)
        lightningEntitlement.usedCount += costMicroUsd;
        lightningEntitlement.lastUsed = new Date();
        await lightningEntitlement.save();

        const newRemainingMicroUsd = lightningEntitlement.maxUsage - lightningEntitlement.usedCount;

        // Attach to request for downstream use
        req.identity = identity;
        req.entitlement = {
          type: entitlementType,
          used: lightningEntitlement.usedCount,
          max: lightningEntitlement.maxUsage,
          remaining: newRemainingMicroUsd,
          isUnlimited: false,
          costMicroUsd,
          isLightning: true
        };

        // Set lightning-specific headers
        res.setHeader('X-Credits-Remaining-USD', microUsdToUsd(newRemainingMicroUsd).toFixed(6));
        res.setHeader('X-Credits-Cost-USD', microUsdToUsd(costMicroUsd).toFixed(6));

        // Emit analytics event
        emitServerEvent(
          SERVER_EVENT_TYPES.ENTITLEMENT_CONSUMED,
          analyticsSessionId,
          identity.tier,
          {
            entitlement_type: entitlementType,
            cost_micro_usd: costMicroUsd,
            remaining_micro_usd: newRemainingMicroUsd,
            identifier_type: 'prepaid'
          }
        );

        return next();
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
        // Emit entitlement_denied analytics event (async, don't await)
        emitServerEvent(
          SERVER_EVENT_TYPES.ENTITLEMENT_DENIED,
          analyticsSessionId,
          identity.tier,
          {
            entitlement_type: entitlementType,
            used: entitlement.usedCount,
            max: entitlement.maxUsage
          }
        );

        // Anonymous users on priced endpoints:
        //   - With X-Free-Tier: true → 429 (webapp expects this for modals/upgrade prompts)
        //   - Without X-Free-Tier → 402 L402 challenge (agents/L402 verifiers expect this)
        const costMicroUsd = getAgentCostMicroUsd(entitlementType);
        if (identity.tier === TIERS.anonymous && costMicroUsd !== null && !freeTierRequested) {
          return send402Challenge(req, res, {
            detail: 'Free quota exceeded. Pay the Lightning invoice to continue with paid access.',
            entitlementType,
            extra: {
              code: 'QUOTA_EXCEEDED',
              freeQuotaUsed: entitlement.usedCount,
              freeQuotaMax: entitlement.maxUsage,
              resetDate: entitlement.nextResetDate
            }
          });
        }
        
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
        
        // Emit entitlement_consumed analytics event (async, don't await)
        emitServerEvent(
          SERVER_EVENT_TYPES.ENTITLEMENT_CONSUMED,
          analyticsSessionId,
          identity.tier,
          {
            entitlement_type: entitlementType,
            used: entitlement.usedCount,
            remaining: entitlement.maxUsage - entitlement.usedCount,
            max: entitlement.maxUsage
          }
        );
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
        const mockResponse = await generateDebugMockResponse(entitlementType, query);
        return res.json(mockResponse);
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
  send402Challenge,
  getQuotaConfig,
  getOrCreateEntitlement,
  checkAllEligibility,
  QUOTA_CONFIG,
  ALL_ENTITLEMENT_TYPES,
  TIERS
};
