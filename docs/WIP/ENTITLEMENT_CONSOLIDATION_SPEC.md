# Entitlement System Consolidation Spec

**Status:** Draft - Awaiting Review  
**Last Updated:** 2026-01-26

## Overview

Consolidate the two existing auth/quota systems (SQLite-based and MongoDB Entitlement) into a unified MongoDB-based entitlement system. Add support for new auth providers (OAuth) and expand coverage to computationally expensive endpoints.

---

## Decisions Made

| Decision | Choice | Notes |
|----------|--------|-------|
| Lightning payments | **Deferred** | Future dev - keep infrastructure |
| Hierarchy lookups | **No protection** | Low-cost MongoDB-only endpoints don't need quotas |
| stream-search | **Comment out** | Nerfed, not currently needed |
| Podcast admins ($50) | **Virtually unlimited** | `-1` maxUsage for all entitlements |
| Subscribers ($9.99) | **High limits** | 4x registered tier |
| Auto-merge accounts | **No** | Don't auto-merge even if same email across providers |
| Period length | **Hybrid** | Anonymous=weekly (7d), Others=monthly (30d) |
| Rollover | **No** | Hard reset each period, unused quota does not carry over |
| Limit type | **Hard limits** | 429 error when limit reached |

### Auth Providers

| Phase | Providers | Identifier |
|-------|-----------|------------|
| **First Pass** | Email (CASCDR JWT), Google, X (Twitter), Nostr | email / email / twitter id / npub |
| **Future Dev** | Facebook, Lightning, GitHub | fb id / payment hash / github id |

---

## Current State Analysis

### What We Have Today

| System | Storage | Auth Types | Endpoints Protected |
|--------|---------|------------|---------------------|
| **Scheme A (Legacy)** | SQLite (`requests.db`, `jamie-user.db`) | IP, Square subscription (Basic auth) | `make-clip`, `stream-search`, `jamie-assist` |
| **Scheme B (Entitlement)** | MongoDB | IP, JWT | On-demand runs only |

### Endpoints Needing Protection (Currently Unprotected)

| Endpoint | Cost Level | Current Auth | Action |
|----------|------------|--------------|--------|
| `POST /api/search-quotes` | Medium (Pinecone + OpenAI embed) | ❌ None | Add entitlement |
| `POST /api/search-quotes-3d` | High (Pinecone + OpenAI embed + UMAP) | ❌ None | Add entitlement |
| `POST /api/search-quotes-3d/expand` | High | ❌ None | Add entitlement |
| `POST /api/fetch-research-id` | Medium-High | ❌ None | Add entitlement |
| `GET /api/episode-with-chapters/:guid` | Low (MongoDB only) | ❌ None | **Leave unprotected** |
| `GET /api/fetch-adjacent-paragraphs` | Low (MongoDB only) | ❌ None | **Leave unprotected** |
| `GET /api/get-hierarchy` | Low (MongoDB only) | ❌ None | **Leave unprotected** |

### Endpoints Already Protected (To Migrate)

| Endpoint | Current Middleware | Action |
|----------|-------------------|--------|
| `POST /api/make-clip` | `jamieAuthMiddleware` (Scheme A) | Migrate to entitlements |
| `POST /api/stream-search` | `jamieAuthMiddleware` (Scheme A) | **Comment out for now** |
| `POST /api/jamie-assist/:lookupHash` | `jamieAuthMiddleware` (Scheme A) | Migrate to entitlements |
| `GET /api/on-demand/checkEligibility` | Scheme B (internal) | Keep as-is |
| `POST /api/on-demand/submitOnDemandRun` | Scheme B (internal) | Keep as-is |

---

## Proposed Architecture

### 1. Multi-Provider Auth Identity Resolution

#### The Problem

Different OAuth providers return different data:

| Provider | Gives Email? | Unique ID | Notes |
|----------|--------------|-----------|-------|
| **CASCDR JWT** | ✅ Yes | email | Our current system |
| **Google** | ✅ Yes (with `email` scope) | `sub` claim | Most reliable for email |
| **Facebook** | ⚠️ Sometimes | `id` | User can deny email permission |
| **Twitter/X** | ❌ Unreliable | `id` | Many users don't have email linked |
| **Apple** | ✅ Yes | `sub` | May be a private relay email |
| **GitHub** | ⚠️ Sometimes | `id` | Email can be private |

**Key insight:** Not all OAuth providers reliably give email, but they ALL give a unique provider-specific ID.

#### Solution: Provider Adapter Pattern

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PROVIDER ADAPTER PATTERN                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Incoming Token ──► Provider Adapter ──► Normalized Identity        │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Provider Adapters (config/authProviders.js)                │   │
│  │                                                             │   │
│  │  cascdr: {                                                  │   │
│  │    name: 'CASCDR',                                          │   │
│  │    extractId: (decoded) => decoded.email,                   │   │
│  │    extractEmail: (decoded) => decoded.email,                │   │
│  │    verify: async (token) => jwt.verify(token, secret)       │   │
│  │  }                                                          │   │
│  │                                                             │   │
│  │  google: {                                                  │   │
│  │    name: 'Google',                                          │   │
│  │    extractId: (payload) => payload.sub,                     │   │
│  │    extractEmail: (payload) => payload.email,                │   │
│  │    verify: async (token) => googleClient.verifyIdToken(...) │   │
│  │  }                                                          │   │
│  │                                                             │   │
│  │  twitter: {                                                 │   │
│  │    name: 'Twitter',                                         │   │
│  │    extractId: (profile) => profile.id,                      │   │
│  │    extractEmail: (profile) => profile.email || null,        │   │
│  │    verify: async (token) => twitterClient.verify(token)     │   │
│  │  }                                                          │   │
│  │                                                             │   │
│  │  facebook: {                                                │   │
│  │    name: 'Facebook',                                        │   │
│  │    extractId: (profile) => profile.id,                      │   │
│  │    extractEmail: (profile) => profile.email || null,        │   │
│  │    verify: async (token) => fbClient.debugToken(token)      │   │
│  │  }                                                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Output: {                                                          │
│    provider: 'google',                                              │
│    providerId: '123456789',                                         │
│    email: 'user@gmail.com',  // or null if not available            │
│    displayName: 'John Doe',                                         │
│    raw: { ...original token claims }                                │
│  }                                                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### Identity Resolution Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         IDENTITY FLOW                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. Token arrives (JWT, OAuth token, etc.)                          │
│                              │                                      │
│                              ▼                                      │
│  2. Detect provider type & run adapter                              │
│     → { provider, providerId, email }                               │
│                              │                                      │
│                              ▼                                      │
│  3. Lookup: User.findOne({                                          │
│       'authProviders.provider': provider,                           │
│       'authProviders.providerId': providerId                        │
│     })                                                              │
│                              │                                      │
│             ┌────────────────┴────────────────┐                     │
│             ▼                                 ▼                     │
│     User Found                         User Not Found               │
│         │                                     │                     │
│         ▼                                     ▼                     │
│   Return existing User              Create new User with            │
│   (DO NOT auto-merge)               this auth provider linked       │
│                                                                     │
│  4. Output: { userId, email, tier, authProviders, ... }             │
│                                                                     │
│  NOTE: Even if two providers have same email, we do NOT             │
│        auto-merge. User must explicitly link accounts.              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### Auth Resolution Priority (for requests)

```
1. Bearer JWT → Try CASCDR verify first, then other providers
2. Provider-specific headers (if we add them later)
3. Fallback: Client IP → anonymous user
```

**Note:** Lightning payments deferred for now. Basic Auth (legacy Square) will be migrated away.

### 2. Updated User Schema

The User model is simplified: **1 account = 1 auth provider** (no linking/co-mingling):

```javascript
// models/User.js - Proposed Updates

const UserSchema = new mongoose.Schema({
  // ═══════════════════════════════════════════════════════════════
  // AUTH PROVIDER (exactly one per user - no co-mingling)
  // ═══════════════════════════════════════════════════════════════
  authProvider: {
    type: String,
    required: true,
    enum: ['email', 'google', 'twitter', 'nostr', 'facebook', 'lightning', 'github']
  },
  
  // Provider-specific unique identifier
  // - email: "user@example.com"
  // - google: "user@gmail.com" (verified email)
  // - twitter: "12345678" (twitter user id)
  // - nostr: "npub1abc..." (npub)
  providerId: {
    type: String,
    required: true
  },
  
  // Email (optional - not all providers have it, e.g., Twitter, Nostr)
  // Used for: notifications, display, Square subscription lookup
  email: { 
    type: String, 
    sparse: true,  // Allow null but unique when present
    index: true
  },
  
  // ═══════════════════════════════════════════════════════════════
  // PAYMENT / SUBSCRIPTION (separate from auth)
  // ═══════════════════════════════════════════════════════════════
  squareCustomerId: { type: String },
  subscriptionId: { type: String },
  
  // ... existing fields (password for email auth, app_preferences, mention_preferences, etc.)
});

// Compound unique index for provider-agnostic lookup
UserSchema.index({ authProvider: 1, providerId: 1 }, { unique: true });
```

**Key Points:**
- **1 account = 1 auth provider** - No linking, no co-mingling
- `authProvider` + `providerId` uniquely identifies a user
- `email` is optional (Twitter/Nostr users may not have one)
- `squareCustomerId` is for payment/subscription, NOT auth
- Same lookup pattern regardless of provider

### 3. Tier System

| Tier | How Determined | Default Quotas |
|------|----------------|----------------|
| `anonymous` | No auth, IP-based only | Lowest limits |
| `registered` | Has User account, no active subscription | Medium limits |
| `subscriber` | Has User account + active subscription (Square, etc.) | High limits |
| `admin` | Has User account + is ProPodcast admin | **Virtually unlimited** for their podcast content |

**Tier Determination Logic:**
```javascript
const determineTier = async (user) => {
  if (!user) return 'anonymous';
  
  // Check if podcast admin
  const proPodcast = await ProPodcast.findOne({ adminEmail: user.email });
  if (proPodcast) return 'admin';
  
  // Check if has active subscription
  if (user.squareCustomerId && user.subscriptionId) {
    const isActive = await checkSquareSubscriptionStatus(user.squareCustomerId, user.subscriptionId);
    if (isActive) return 'subscriber';
  }
  
  // Default: registered user without subscription
  return 'registered';
};
```

### 4. Entitlement Types & Default Quotas

**Quota Structure:**
- **Anonymous** = Weekly limits (7 days) - fast reset for explorers
- **Registered** = Monthly limits (30 days) - same numbers as anon, but monthly = ~4x effective value
- **Subscriber ($9.99)** = Monthly limits - significantly boosted, especially search3D & makeClip
- **Admin ($50)** = Unlimited (-1)

```javascript
// config/entitlementDefaults.js

const PERIOD_WEEKLY = 7;
const PERIOD_MONTHLY = 30;

const ENTITLEMENT_DEFAULTS = {
  // ─────────────────────────────────────────────────────────────
  // SEARCH OPERATIONS
  // ─────────────────────────────────────────────────────────────
  searchQuotes: {
    description: 'Basic semantic search (/api/search-quotes)',
    costLevel: 'medium',
    defaults: {
      anonymous:   { maxUsage: 100,  periodLengthDays: PERIOD_WEEKLY },   // weekly
      registered:  { maxUsage: 100,  periodLengthDays: PERIOD_MONTHLY },  // monthly (same #, 4x value)
      subscriber:  { maxUsage: 500,  periodLengthDays: PERIOD_MONTHLY },  // monthly, 5x reg
      admin:       { maxUsage: -1,   periodLengthDays: PERIOD_MONTHLY },  // unlimited
    }
  },
  
  search3D: {
    description: '3D semantic search with UMAP (/api/search-quotes-3d, /expand, /fetch-research-id)',
    costLevel: 'high',
    defaults: {
      anonymous:   { maxUsage: 20,   periodLengthDays: PERIOD_WEEKLY },   // weekly
      registered:  { maxUsage: 20,   periodLengthDays: PERIOD_MONTHLY },  // monthly (same #, 4x value)
      subscriber:  { maxUsage: 200,  periodLengthDays: PERIOD_MONTHLY },  // monthly, 10x reg (BOOSTED)
      admin:       { maxUsage: -1,   periodLengthDays: PERIOD_MONTHLY },  // unlimited
    }
  },
  
  // ─────────────────────────────────────────────────────────────
  // CONTENT GENERATION
  // ─────────────────────────────────────────────────────────────
  makeClip: {
    description: 'Video clip generation (/api/make-clip)',
    costLevel: 'high',
    defaults: {
      anonymous:   { maxUsage: 5,    periodLengthDays: PERIOD_WEEKLY },   // weekly
      registered:  { maxUsage: 5,    periodLengthDays: PERIOD_MONTHLY },  // monthly (same #, 4x value)
      subscriber:  { maxUsage: 50,   periodLengthDays: PERIOD_MONTHLY },  // monthly, 10x reg (BOOSTED)
      admin:       { maxUsage: -1,   periodLengthDays: PERIOD_MONTHLY },  // unlimited
    }
  },
  
  jamieAssist: {
    description: 'AI assistant interactions (/api/jamie-assist)',
    costLevel: 'high',
    defaults: {
      anonymous:   { maxUsage: 10,   periodLengthDays: PERIOD_WEEKLY },   // weekly
      registered:  { maxUsage: 10,   periodLengthDays: PERIOD_MONTHLY },  // monthly (same #, 4x value)
      subscriber:  { maxUsage: 50,   periodLengthDays: PERIOD_MONTHLY },  // monthly, 5x reg
      admin:       { maxUsage: -1,   periodLengthDays: PERIOD_MONTHLY },  // unlimited
    }
  },
  
  onDemandRun: {
    description: 'On-demand podcast processing (/api/on-demand/submitOnDemandRun)',
    costLevel: 'very-high',
    defaults: {
      anonymous:   { maxUsage: 1,    periodLengthDays: PERIOD_WEEKLY },   // weekly
      registered:  { maxUsage: 2,    periodLengthDays: PERIOD_MONTHLY },  // monthly
      subscriber:  { maxUsage: 10,   periodLengthDays: PERIOD_MONTHLY },  // monthly, 5x reg
      admin:       { maxUsage: -1,   periodLengthDays: PERIOD_MONTHLY },  // unlimited
    }
  },
  
  // ─────────────────────────────────────────────────────────────
  // NOT IMPLEMENTING
  // ─────────────────────────────────────────────────────────────
  // streamSearch: COMMENTED OUT - endpoint nerfed
  // hierarchyLookup: NOT NEEDED - low-cost, no protection
};

// Helper to get defaults for a tier
const getDefaultsForTier = (entitlementType, tier) => {
  const config = ENTITLEMENT_DEFAULTS[entitlementType];
  if (!config) return null;
  return config.defaults[tier] || config.defaults.anonymous;
};

module.exports = { ENTITLEMENT_DEFAULTS, getDefaultsForTier, PERIOD_WEEKLY, PERIOD_MONTHLY };
```

**Quota Summary Table:**

| Entitlement | Anonymous (weekly) | Registered (monthly) | Subscriber (monthly) | Admin |
|-------------|-------------------|---------------------|---------------------|-------|
| searchQuotes | 100 | 100 | 500 | ∞ |
| search3D | 20 | 20 | **200** ⬆️ | ∞ |
| makeClip | 5 | 5 | **50** ⬆️ | ∞ |
| jamieAssist | 10 | 10 | 50 | ∞ |
| onDemandRun | 1 | 2 | 10 | ∞ |

**Notes:**
- **Anonymous:** Weekly (7 days) - fast reset for trial users
- **Registered/Subscriber/Admin:** Monthly (30 days) - matches billing cycle
- **No rollover** - unused quota resets each period
- **Hard limits** - 429 error when limit reached
- ⬆️ = Boosted beyond standard multiplier for subscriber tier

### 5. Updated Entitlement Schema

```javascript
// models/Entitlement.js - Proposed Updates

const entitlementSchema = new mongoose.Schema({
  // === IDENTITY ===
  // For authenticated users: identifier = User._id.toString()
  // For anonymous users: identifier = IP address
  identifier: { 
    type: String, 
    required: true, 
    index: true 
  },
  
  identifierType: {
    type: String,
    required: true,
    enum: ['user', 'ip'],  // Simplified: 'user' for all authenticated, 'ip' for anonymous
    index: true
  },
  
  // === ENTITLEMENT CONFIG ===
  entitlementType: {
    type: String,
    required: true,
    enum: [
      'searchQuotes',   // Basic semantic search
      'search3D',       // 3D search + UMAP
      'makeClip',       // Video clip generation
      'jamieAssist',    // AI assistant
      'onDemandRun',    // On-demand podcast processing
      'custom'          // Future expansion
    ],
    index: true
  },
  
  // === USAGE TRACKING ===
  usedCount: { 
    type: Number, 
    default: 0 
  },
  maxUsage: { 
    type: Number, 
    required: true,
    // -1 = unlimited (for admin tier)
  },
  
  // === PERIOD MANAGEMENT ===
  periodStart: { type: Date, required: true },
  periodLengthDays: { type: Number, required: true },
  nextResetDate: { type: Date, required: true },
  
  // === TIER INFO (denormalized for fast queries & display) ===
  tier: {
    type: String,
    enum: ['anonymous', 'registered', 'subscriber', 'admin', 'custom'],
    default: 'anonymous',
    index: true
  },
  
  // === STATUS ===
  status: {
    type: String,
    enum: ['active', 'suspended', 'expired'],
    default: 'active',
    index: true
  },
  
  // === AUDIT ===
  lastUsed: { type: Date },
  
  // === FLEXIBLE METADATA ===
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
    // Can store: authProvider used, request context, etc.
  }
}, {
  timestamps: true  // Adds createdAt, updatedAt automatically
});

// Compound index for efficient lookups
entitlementSchema.index(
  { identifier: 1, identifierType: 1, entitlementType: 1 }, 
  { unique: true }
);

// Virtual for unlimited check
entitlementSchema.virtual('isUnlimited').get(function() {
  return this.maxUsage === -1;
});

// Virtual for remaining (handles unlimited)
entitlementSchema.virtual('remainingUsage').get(function() {
  if (this.maxUsage === -1) return Infinity;
  return Math.max(0, this.maxUsage - this.usedCount);
});

// Virtual for eligibility (handles unlimited)
entitlementSchema.virtual('isEligible').get(function() {
  if (this.status !== 'active') return false;
  if (this.maxUsage === -1) return true;  // unlimited
  return this.remainingUsage > 0;
});
```

**Key Changes from Current Schema:**
- Simplified `identifierType` to just `user` and `ip` (auth method is metadata, not identity)
- Added `tier` field for denormalized tier info
- Added `-1` handling for unlimited usage (admin tier)
- Removed `streamSearch` and `hierarchyLookup` from enum
```

### 6. New Middleware Architecture

```javascript
// utils/entitlementMiddleware.js

const { resolveIdentity } = require('./identityResolver');
const { checkEntitlementEligibility, consumeEntitlement } = require('./entitlements');
const { getDefaultsForTier } = require('../config/entitlementDefaults');

/**
 * Creates middleware that checks entitlement for a specific operation type
 * @param {string} entitlementType - Type of entitlement to check
 * @param {object} options - Configuration options
 */
const createEntitlementMiddleware = (entitlementType, options = {}) => {
  const {
    consumeOnSuccess = true,  // Decrement quota on successful request?
  } = options;
  
  return async (req, res, next) => {
    try {
      // Step 1: Resolve identity (user or IP)
      const identity = await resolveIdentity(req);
      req.identity = identity;
      
      // Step 2: Check entitlement
      // Note: admin tier with maxUsage=-1 will always be eligible
      const eligibility = await checkEntitlementEligibility(
        identity.identifier,
        identity.identifierType,
        entitlementType,
        identity.tier  // Pass tier for auto-creation with correct defaults
      );
      
      if (!eligibility.eligible) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          entitlementType,
          tier: identity.tier,
          remainingUsage: 0,
          maxUsage: eligibility.maxUsage,
          nextResetDate: eligibility.nextResetDate,
          upgradeHint: getUpgradeHint(identity.tier)
        });
      }
      
      // Step 3: Attach info to request for post-processing
      req.entitlement = {
        type: entitlementType,
        ...eligibility,
        consumeOnSuccess
      };
      
      next();
    } catch (error) {
      console.error(`Entitlement middleware error for ${entitlementType}:`, error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
};

/**
 * Post-response middleware to consume entitlement on success
 * Must be added BEFORE the route handler
 */
const consumeEntitlementOnSuccess = (req, res, next) => {
  res.on('finish', async () => {
    try {
      // Only consume if:
      // - Request was successful (2xx)
      // - Entitlement info exists
      // - consumeOnSuccess is true
      // - Not an unlimited entitlement
      if (
        res.statusCode >= 200 && 
        res.statusCode < 300 && 
        req.entitlement?.consumeOnSuccess &&
        !req.entitlement?.isUnlimited
      ) {
        await consumeEntitlement(
          req.identity.identifier,
          req.identity.identifierType,
          req.entitlement.type
        );
      }
    } catch (error) {
      // Log but don't fail - response already sent
      console.error('Error consuming entitlement:', error);
    }
  });
  next();
};

/**
 * Get upgrade suggestion based on current tier
 */
const getUpgradeHint = (tier) => {
  switch (tier) {
    case 'anonymous':
      return 'Create a free account to increase your limits';
    case 'registered':
      return 'Upgrade to Jamie Pro for higher limits';
    case 'subscriber':
      return 'Contact support if you need higher limits';
    default:
      return null;
  }
};

module.exports = { 
  createEntitlementMiddleware, 
  consumeEntitlementOnSuccess,
  getUpgradeHint
};
```

**Usage Example:**
```javascript
const { createEntitlementMiddleware, consumeEntitlementOnSuccess } = require('./utils/entitlementMiddleware');

// Apply to a route
app.post('/api/search-quotes',
  createEntitlementMiddleware('searchQuotes'),
  consumeEntitlementOnSuccess,
  async (req, res) => {
    // ... route handler
    // req.identity contains { identifier, identifierType, tier, user?, email? }
    // req.entitlement contains { type, eligible, remainingUsage, ... }
  }
);
```

### 7. Identity Resolution Module

```javascript
// utils/identityResolver.js

const jwt = require('jsonwebtoken');
const { User } = require('../models/User');
const { getProPodcastByAdminEmail } = require('./ProPodcastUtils');
const { AUTH_PROVIDERS } = require('../config/authProviders');

/**
 * Resolve the identity of the requester
 * Returns: { identifier, identifierType, tier, user?, email?, authProvider? }
 */
const resolveIdentity = async (req) => {
  const authHeader = req.headers.authorization;
  
  // ─────────────────────────────────────────────────────────────
  // 1. Check for Bearer token
  // ─────────────────────────────────────────────────────────────
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    
    // Try each provider adapter in priority order
    // First pass: email, google, twitter, nostr
    for (const [providerKey, adapter] of Object.entries(AUTH_PROVIDERS)) {
      try {
        const verified = await adapter.verify(token);
        if (!verified) continue;
        
        const providerId = adapter.extractId(verified);
        const email = adapter.extractEmail(verified);
        
        // Look up user by this provider
        const user = await User.findOne({
          'authProviders.provider': providerKey,
          'authProviders.providerId': providerId
        });
        
        if (user) {
          // Existing user found
          const tier = await determineTier(user);
          return {
            identifier: user._id.toString(),
            identifierType: 'user',
            tier,
            user,
            email: user.email || email,
            authProvider: providerKey
          };
        }
        
        // New user - create account
        // (Or you could return a special state and let the route handle registration)
        const newUser = await createUserFromProvider(providerKey, providerId, email, verified);
        const tier = await determineTier(newUser);
        return {
          identifier: newUser._id.toString(),
          identifierType: 'user',
          tier,
          user: newUser,
          email: newUser.email || email,
          authProvider: providerKey,
          isNewUser: true
        };
        
      } catch (e) {
        // This provider didn't work, try next
        continue;
      }
    }
    
    // No provider could verify the token
    console.warn('Bearer token provided but no provider could verify it');
  }
  
  // ─────────────────────────────────────────────────────────────
  // 2. Lightning payments (DEFERRED - keeping structure for future)
  // ─────────────────────────────────────────────────────────────
  // if (authHeader && isLightningPaymentFormat(authHeader)) {
  //   // ... lightning verification logic
  // }
  
  // ─────────────────────────────────────────────────────────────
  // 3. Fallback to IP-based anonymous
  // ─────────────────────────────────────────────────────────────
  const clientIp = extractClientIp(req);
  return {
    identifier: clientIp,
    identifierType: 'ip',
    tier: 'anonymous',
    user: null,
    email: null,
    authProvider: null
  };
};

/**
 * Determine tier based on User record
 */
const determineTier = async (user) => {
  if (!user) return 'anonymous';
  
  // Check if podcast admin (highest priority)
  if (user.email) {
    const proPodcast = await getProPodcastByAdminEmail(user.email);
    if (proPodcast) return 'admin';
  }
  
  // Check if has active subscription via Square
  if (user.squareCustomerId && user.subscriptionId) {
    // Could add actual Square API check here, or rely on cached status
    // For now, presence of both fields indicates subscriber
    return 'subscriber';
  }
  
  // Default: registered user without subscription
  return 'registered';
};

/**
 * Create a new user from an auth provider
 */
const createUserFromProvider = async (provider, providerId, email, rawPayload) => {
  const newUser = new User({
    email: email || null,  // May be null for Twitter, etc.
    authProviders: [{
      provider,
      providerId,
      email,
      displayName: rawPayload.name || rawPayload.displayName || null,
      linkedAt: new Date(),
      metadata: {
        raw: rawPayload  // Store original payload for reference
      }
    }]
  });
  await newUser.save();
  return newUser;
};

/**
 * Extract client IP from request
 */
const extractClientIp = (req) => {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 
         req.headers['x-real-ip'] || 
         req.ip ||
         req.connection?.remoteAddress ||
         'unknown';
};

module.exports = { 
  resolveIdentity, 
  determineTier, 
  extractClientIp,
  createUserFromProvider
};
```

### 8. Auth Provider Adapters

```javascript
// config/authProviders.js

const jwt = require('jsonwebtoken');
// const { OAuth2Client } = require('google-auth-library');  // npm install google-auth-library
// const TwitterApi = require('twitter-api-v2');  // Already in project

/**
 * Auth Provider Adapter Interface:
 * {
 *   name: string,              // Display name
 *   verify: async (token) => payload | null,  // Verify token, return payload or null
 *   extractId: (payload) => string,           // Extract unique provider ID
 *   extractEmail: (payload) => string | null, // Extract email (if available)
 * }
 */

const AUTH_PROVIDERS = {
  // ═══════════════════════════════════════════════════════════════
  // FIRST PASS - Implementing Now
  // ═══════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────
  // EMAIL (via CASCDR JWT) - Current primary auth
  // ─────────────────────────────────────────────────────────────
  email: {
    name: 'Email',
    verify: async (token) => {
      try {
        return jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
      } catch (e) {
        return null;
      }
    },
    extractId: (payload) => payload.email,  // Email IS the unique ID
    extractEmail: (payload) => payload.email,
  },

  // ─────────────────────────────────────────────────────────────
  // GOOGLE OAuth
  // ─────────────────────────────────────────────────────────────
  google: {
    name: 'Google',
    verify: async (token) => {
      // TODO: Implement
      // const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
      // const ticket = await client.verifyIdToken({
      //   idToken: token,
      //   audience: process.env.GOOGLE_CLIENT_ID,
      // });
      // return ticket.getPayload();
      return null;
    },
    extractId: (payload) => payload.email,  // Use email as ID (has verified email)
    extractEmail: (payload) => payload.email,
  },

  // ─────────────────────────────────────────────────────────────
  // X (Twitter) OAuth - Already have OAuth in project
  // ─────────────────────────────────────────────────────────────
  twitter: {
    name: 'X (Twitter)',
    verify: async (token) => {
      // TODO: Implement using existing Twitter OAuth setup
      return null;
    },
    extractId: (payload) => payload.id,  // Twitter user ID (numeric string)
    extractEmail: (payload) => payload.email || null,  // Often not available
  },

  // ─────────────────────────────────────────────────────────────
  // NOSTR (NIP-07) - Uses npub as identifier
  // ─────────────────────────────────────────────────────────────
  nostr: {
    name: 'Nostr',
    verify: async (signedEvent) => {
      // TODO: Implement NIP-07 verification
      // 1. Verify the signature on the event
      // 2. Check event kind (e.g., kind 22242 for auth)
      // 3. Check timestamp is recent
      // 4. Return { pubkey, npub, ... }
      return null;
    },
    extractId: (payload) => payload.npub,  // npub is the unique Nostr ID
    extractEmail: (payload) => null,  // Nostr doesn't have email
  },

  // ═══════════════════════════════════════════════════════════════
  // FUTURE DEV - Not implementing yet
  // ═══════════════════════════════════════════════════════════════

  // facebook: { ... }   // Future
  // lightning: { ... }  // Future - use payment hash as ID
  // github: { ... }     // Future
};

module.exports = { AUTH_PROVIDERS };
```

**Adding a New Provider:**
1. Add entry to `AUTH_PROVIDERS` with the adapter interface
2. Implement the `verify` function to validate tokens
3. Map `extractId` to the provider's unique user identifier
4. Map `extractEmail` to email (or return null if not available)
5. No other code changes needed - identity resolver picks it up automatically

---

## Migration Plan

### Phase 1: Schema & Infrastructure (No Breaking Changes)
- [ ] Update `models/Entitlement.js` with new fields (tier, updated enums)
- [ ] Update `models/User.js` with `authProviders` array schema
- [ ] Create `config/authProviders.js` with provider adapter pattern
- [ ] Create `config/entitlementDefaults.js` with tier/quota configurations
- [ ] Create `utils/identityResolver.js` 
- [ ] Create `utils/entitlementMiddleware.js` with factory function
- [ ] Update `utils/entitlements.js` to handle `-1` (unlimited) and tier parameter

### Phase 2: Protect New Endpoints (Additive, Non-Breaking)
- [ ] Apply entitlement middleware to currently unprotected routes:
  - `POST /api/search-quotes` → `searchQuotes`
  - `POST /api/search-quotes-3d` → `search3D`
  - `POST /api/search-quotes-3d/expand` → `search3D`
  - `POST /api/fetch-research-id` → `search3D`
- [ ] Test with anonymous (IP), and existing JWT auth
- [ ] Monitor for issues, tune quotas if needed

### Phase 3: Migrate Existing Auth (Replace Legacy)
- [ ] Replace `jamieAuthMiddleware` with new entitlement middleware:
  - `POST /api/make-clip` → `makeClip`
  - `POST /api/jamie-assist/:lookupHash` → `jamieAssist`
- [ ] Comment out `/api/stream-search` (nerfed, not needed)
- [ ] Migrate existing users to have `authProviders` entry for `cascdr`
- [ ] Mark SQLite code as deprecated (don't remove yet)

### Phase 4: User Schema Migration
- [ ] Write migration script to:
  - Add `authProviders: [{ provider: 'email', providerId: email, email }]` to all existing users
  - Preserve all existing fields (`squareCustomerId`, `subscriptionId`, etc.)
- [ ] Run migration in staging, then production
- [ ] Verify all users can still authenticate

### Phase 5: Additional Auth Providers (First Pass)
- [ ] Implement Google OAuth adapter
- [ ] Implement Twitter/X OAuth adapter (using existing TwitterApi setup)
- [ ] Implement Nostr NIP-07 adapter (npub as identifier)
- [ ] Add frontend UI for OAuth/Nostr login options
- [ ] (Optional) Add account linking UI

### Phase 6: Future Auth Providers (Later)
- [ ] Facebook OAuth adapter
- [ ] Lightning auth adapter
- [ ] GitHub OAuth adapter

### Phase 7: Cleanup (After Stabilization)
- [ ] Remove deprecated SQLite code (`requests-db.js`, `jamie-user-db.js`)
- [ ] Remove `requests.db` and `jamie-user.db` from `DatabaseBackupManager`
- [ ] Remove `jamieAuthMiddleware` and `squareRequestMiddleware`
- [ ] Update documentation
- [ ] Archive this spec to `docs/architecture/`

---

## All Questions Decided ✅

### Core Decisions

| Question | Decision |
|----------|----------|
| Lightning Payments | **Future dev** - Defer, keep infrastructure |
| Auto-merge accounts | **No** - Even if same email across providers, don't auto-merge |
| Hierarchy lookups | **No protection** - Low cost, leave open |
| stream-search | **Comment out** - Nerfed, not needed |
| Admin tier ($50) | **Unlimited** (`-1`) for all entitlements |
| Period length | **Hybrid** - Anonymous=weekly (7d), Others=monthly (30d) |
| Rollover | **No** - Hard reset, no carryover |
| Limit type | **Hard limits** - 429 error at limit |

### Auth & Account Decisions

| Question | Decision |
|----------|----------|
| Square Subscriptions | **Payment-only** - Square is NOT an auth provider. User auths via email/OAuth, we check `squareCustomerId` on User to determine tier |
| Account Linking | **No** - 1 account = 1 auth provider. No co-mingling |
| New User Creation | **Yes, via sign-up route** - Must go through proper sign-up flow |
| Provider per account | **Exactly 1** - Each User has exactly one auth provider |

### Auth Providers

| Phase | Provider | Identifier | Notes |
|-------|----------|------------|-------|
| First | Email | email | Current CASCDR JWT |
| First | Google | email | OAuth, verified email |
| First | X (Twitter) | twitter id | OAuth, email often unavailable |
| First | Nostr | npub | NIP-07 signature verification |
| Future | Facebook | fb id | OAuth |
| Future | Lightning | payment hash | Pay-per-use or tier elevation |
| Future | GitHub | github id | OAuth |

### Simplified User Model (Provider-Agnostic Lookup)

Since each user has **exactly 1 auth provider**, the User model simplifies:

```javascript
const UserSchema = new mongoose.Schema({
  // ═══════════════════════════════════════════════════════════════
  // AUTH PROVIDER (exactly one per user)
  // ═══════════════════════════════════════════════════════════════
  authProvider: {
    type: String,
    required: true,
    enum: ['email', 'google', 'twitter', 'nostr', 'facebook', 'lightning', 'github']
  },
  
  // Provider-specific unique identifier
  // - email: "user@example.com"
  // - google: "user@gmail.com" (verified email)
  // - twitter: "12345678" (twitter user id)
  // - nostr: "npub1abc..." (npub)
  providerId: {
    type: String,
    required: true
  },
  
  // Email (optional - not all providers have it)
  // Used for: notifications, display, Square lookup
  email: {
    type: String,
    sparse: true,
    index: true
  },
  
  // ═══════════════════════════════════════════════════════════════
  // PAYMENT / SUBSCRIPTION (separate from auth)
  // ═══════════════════════════════════════════════════════════════
  squareCustomerId: { type: String },
  subscriptionId: { type: String },
  
  // ... existing fields
});

// Compound unique index for provider lookup
UserSchema.index({ authProvider: 1, providerId: 1 }, { unique: true });
```

**Provider-agnostic lookup:**
```javascript
// Any provider resolves the same way
User.findOne({ authProvider: 'email', providerId: 'user@example.com' })
User.findOne({ authProvider: 'twitter', providerId: '12345678' })
User.findOne({ authProvider: 'nostr', providerId: 'npub1abc...' })

// Tier determination (Square is payment, not auth)
const user = await User.findOne({ authProvider, providerId });
const isSubscriber = !!(user.squareCustomerId && user.subscriptionId);
```

---

## File Structure (Proposed)

```
config/
├── authProviders.js          # NEW: Provider adapter definitions
└── entitlementDefaults.js    # NEW: Tier & quota configurations

models/
├── Entitlement.js            # UPDATE: New fields (tier, updated enums)
└── User.js                   # UPDATE: Add authProviders array

utils/
├── entitlements.js           # UPDATE: Handle -1 unlimited, tier param
├── adminEntitlements.js      # (exists) Admin functions
├── identityResolver.js       # NEW: Auth/identity resolution
├── entitlementMiddleware.js  # NEW: Middleware factory
├── requests-db.js            # DEPRECATED (Phase 6)
└── jamie-user-db.js          # DEPRECATED (Phase 6)

routes/
├── adminEntitlements.js      # (exists) Admin API - no changes
├── jamieExploreRoutes.js     # UPDATE: Add entitlement middleware
└── ...

scripts/
└── migrate-users-auth-providers.js  # NEW: Migration script (Phase 4)
```

---

## Summary

This spec consolidates the legacy SQLite-based auth (Scheme A) and the MongoDB Entitlement system (Scheme B) into a unified architecture that:

1. **Uses MongoDB exclusively** for all entitlement/quota tracking
2. **Supports multiple auth providers** via adapter pattern:
   - First pass: Email, Google, X (Twitter), Nostr
   - Future: Facebook, Lightning, GitHub
3. **Resolves all authenticated users to a User record** (via `authProviders` lookup)
4. **Ties entitlements to User._id** (for authenticated) or **IP** (for anonymous)
5. **Provides tier-based quotas:**
   - Anonymous: Weekly limits (fast reset for trial)
   - Registered: Monthly limits (same numbers = ~4× effective value)
   - Subscriber ($9.99): Monthly limits (boosted, especially search3D & makeClip)
   - Admin ($50): Unlimited
6. **Hard limits** with no rollover - 429 error when limit reached

---

## Next Steps

1. **Review this spec** and provide feedback on open questions
2. **Approve the approach** before implementation begins
3. **Phase 1 implementation** once approved

When ready, let me know and we'll start with Phase 1 (schema updates, identity resolver, middleware factory).
