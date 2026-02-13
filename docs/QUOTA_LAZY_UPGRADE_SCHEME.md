# Quota Lazy Upgrade Scheme

## Overview

The entitlement/quota system uses a **lazy (on-demand) adjustment** pattern rather than migrations. Quota limits are determined at runtime based on the user's current tier, and upgrades take effect immediately on the next request.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Request Flow                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Request                                                            │
│      │                                                               │
│      ▼                                                               │
│   resolveIdentity(req)                                               │
│      │                                                               │
│      ├── JWT present? ──► Find User ──► determineTier(user)          │
│      │                                                               │
│      └── No JWT? ──► tier = 'anonymous', identifier = IP             │
│                                                                      │
│      ▼                                                               │
│   getOrCreateEntitlement(identifier, identifierType, type, tier)     │
│      │                                                               │
│      ├── Entitlement exists & not expired?                           │
│      │      │                                                        │
│      │      └── tier.maxUsage > stored.maxUsage?                     │
│      │             │                                                 │
│      │             └── YES: Update maxUsage (LAZY UPGRADE)           │
│      │                                                               │
│      └── Expired or doesn't exist?                                   │
│             │                                                        │
│             └── Create/reset with tier's config                      │
│                                                                      │
│      ▼                                                               │
│   Check: usedCount < maxUsage?                                       │
│      │                                                               │
│      ├── YES: Allow request, increment usedCount                     │
│      └── NO: Return 429 (quota exceeded)                             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. Tier Determination (`identityResolver.js`)

Tiers are determined **solely by subscription status**:

| Tier | Criteria |
|------|----------|
| `anonymous` | No valid JWT |
| `registered` | Valid JWT, no subscription |
| `subscriber` | `User.subscriptionType === 'amber'` |
| `admin` | `User.subscriptionType === 'jamie-pro'` |

> **Important**: Being in `ProPodcastDetails` does NOT grant admin tier for quotas.
> ProPodcastDetails association only determines access to podcast admin *features* (like `/api/twitter/tweet`).
> The subscription type is the sole source of truth for quota limits.

```javascript
async function determineTier(user) {
  if (user.subscriptionType === 'jamie-pro') return TIERS.admin;
  if (user.subscriptionType === 'amber') return TIERS.subscriber;
  return TIERS.registered;
}
```

### 2. Quota Configuration (`entitlementMiddleware.js`)

Quotas are defined in code, not stored in the database:

```javascript
const QUOTA_CONFIG_PRODUCTION = {
  'search-quotes': {
    anonymous:   { maxUsage: 100, periodLengthDays: 7 },   // 100/week
    registered:  { maxUsage: 100, periodLengthDays: 30 },  // 100/month
    subscriber:  { maxUsage: 500, periodLengthDays: 30 },  // 500/month
    admin:       { maxUsage: -1,  periodLengthDays: 30 }   // Unlimited
  },
  // ... other entitlement types
};
```

### 3. Lazy Upgrade Logic (`entitlementMiddleware.js`)

```javascript
async function getOrCreateEntitlement(identifier, identifierType, entitlementType, tier) {
  const config = getQuotaConfig(entitlementType, tier);
  
  let entitlement = await Entitlement.findOne({ identifier, identifierType, entitlementType });
  
  // LAZY UPGRADE: If tier upgraded and new maxUsage is higher, update immediately
  if (entitlement && !isPeriodExpired(...)) {
    if (config.maxUsage > entitlement.maxUsage || config.maxUsage === -1) {
      entitlement.maxUsage = config.maxUsage;
      await entitlement.save();
    }
    return entitlement;
  }
  
  // Create or reset entitlement
  return Entitlement.findOneAndUpdate(
    { identifier, identifierType, entitlementType },
    { ...config, usedCount: 0, periodStart: now },
    { upsert: true, new: true }
  );
}
```

## Behavior by Scenario

### User Upgrades (e.g., registered → subscriber)

| Before | After (next request) |
|--------|---------------------|
| `maxUsage: 100` | `maxUsage: 500` |
| `usedCount: 75` | `usedCount: 75` (preserved) |
| Remaining: 25 | Remaining: 425 |

**Effect**: Immediate. User gains access to higher quota on their very next request.

### User Downgrades (e.g., subscriber → registered)

| Before | After (same period) | After (period expires) |
|--------|---------------------|------------------------|
| `maxUsage: 500` | `maxUsage: 500` (kept) | `maxUsage: 100` |
| `usedCount: 200` | `usedCount: 200` | `usedCount: 0` |

**Effect**: Graceful. Current period honors the higher limit. Lower limit applies after reset.

### Period Expires

| Before (expired) | After (next request) |
|------------------|---------------------|
| `periodStart: 30 days ago` | `periodStart: now` |
| `usedCount: 95` | `usedCount: 0` |
| `maxUsage: (old tier)` | `maxUsage: (current tier)` |

**Effect**: Full reset with current tier's configuration.

### New User (First Request)

- No existing Entitlement record
- Creates new record with current tier's config
- `usedCount: 0`, `periodStart: now`

## Entitlement Model (`models/Entitlement.js`)

```javascript
{
  identifier: String,        // User's MongoDB _id or IP address
  identifierType: String,    // 'mongoUserId' | 'ip'
  entitlementType: String,   // 'search-quotes' | 'make-clip' | etc.
  usedCount: Number,         // Current usage in this period
  maxUsage: Number,          // Limit for this period (from tier config)
  periodStart: Date,         // When this period started
  periodLengthDays: Number,  // Period duration
  nextResetDate: Date,       // Calculated: periodStart + periodLengthDays
  status: String             // 'active' | 'suspended' | 'expired'
}
```

## Available Entitlement Types

| Type | Description |
|------|-------------|
| `search-quotes` | Basic quote search |
| `search-quotes-3d` | 3D search (embeddings + UMAP) |
| `make-clip` | Video clip creation |
| `jamie-assist` | AI content generation |
| `ai-analyze` | Research session AI analysis |
| `submit-on-demand-run` | Podcast on-demand processing |

## Debug Mode

When `DEBUG_MODE=true`:
- Uses `QUOTA_CONFIG_DEBUG` with low limits (2-5 per day)
- 1-day periods for quick reset testing
- Mock responses for expensive operations (Pinecone, OpenAI)

## Operations

### Reset All Users' Usage (Optional at Cutover)

```javascript
// MongoDB shell
db.entitlements.updateMany({}, { $set: { usedCount: 0 } })
```

### Check a User's Entitlements

```javascript
db.entitlements.find({ 
  identifier: "<user_mongo_id>",
  identifierType: "mongoUserId"
})
```

### Force Upgrade a User's Quota

Not needed! Just update `User.subscriptionType` and the next request will lazy-upgrade.

## Key Benefits

1. **No migration scripts** for plan changes
2. **Immediate upgrades** for better UX
3. **Graceful downgrades** to honor existing period
4. **Single source of truth** for limits (code, not DB)
5. **Easy to modify** - change `QUOTA_CONFIG` and deploy

## Related Files

- `utils/entitlementMiddleware.js` - Core logic
- `utils/identityResolver.js` - Tier determination
- `models/Entitlement.js` - Database schema
- `constants/entitlementTypes.js` - Type constants
