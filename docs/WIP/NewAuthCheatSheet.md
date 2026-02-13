# New Auth System Cheat Sheet

> Quick reference for the provider-agnostic authentication and entitlement system.

---

## Core Terminology

| Term | Layer | What It Is | Example Values |
|------|-------|------------|----------------|
| **provider** | Auth | How you signed in | `email`, `google`, `twitter`, `nostr` |
| **providerId** | Auth | Your unique ID from that provider | `jim@example.com`, `npub1abc...` |
| **User._id** | Database | MongoDB's internal unique ID | `683e27e7173052dd16faffdb` |
| **identifier** | Entitlement | Key used for quota tracking | User's `_id` or IP address |
| **identifierType** | Entitlement | What kind of identifier | `mongoUserId`, `ip` |
| **tier** | Entitlement | Quota level based on subscription | `anonymous`, `registered`, `subscriber`, `admin` |

---

## The 4 Tiers

| Tier | Who | How Determined | Quota Level |
|------|-----|----------------|-------------|
| `anonymous` | Not logged in | No JWT or invalid JWT | Lowest (weekly) |
| `registered` | Account, no subscription | `subscriptionType: null` | Medium (monthly) |
| `subscriber` | $9.99/mo (amber) | `subscriptionType: 'amber'` | Higher (monthly) |
| `admin` | $50/mo podcast admin | `subscriptionType: 'jamie-pro'` | Unlimited |

---

## Provider ID Examples

| Provider | What `providerId` Contains | Has Email? |
|----------|---------------------------|------------|
| `email` | The email address itself | ✅ Yes |
| `google` | Google's user ID (`118234567890`) | ✅ Yes |
| `twitter` | Twitter's user ID (`12345678`) | ❌ Usually no |
| `nostr` | User's npub (`npub1abc...`) | ❌ No |

---

## Flow Diagrams

### Authentication Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    REQUEST WITH JWT                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      JWT PAYLOAD                                 │
│  {                                                               │
│    "sub": "jim@example.com",     ◄── providerId                 │
│    "provider": "email",          ◄── provider                   │
│    "email": "jim@example.com"    ◄── optional metadata          │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     USER LOOKUP                                  │
│                                                                  │
│  User.findByAuthProvider("email", "jim@example.com")            │
│                                                                  │
│  Matches on:                                                     │
│    authProvider.provider = "email"                               │
│    authProvider.providerId = "jim@example.com"                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    USER DOCUMENT                                 │
│  {                                                               │
│    _id: "683e27e7173052dd16faffdb",   ◄── MongoDB ID            │
│    email: "jim@example.com",           (optional)               │
│    authProvider: {                                               │
│      provider: "email",                                          │
│      providerId: "jim@example.com"                               │
│    },                                                            │
│    subscriptionType: "amber"           ◄── determines tier      │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Tier Resolution Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      HAS VALID JWT?                              │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │ NO                            │ YES
              ▼                               ▼
       ┌────────────┐              ┌─────────────────────┐
       │ ANONYMOUS  │              │ LOOK UP USER        │
       │ tier       │              │ subscriptionType?   │
       └────────────┘              └─────────────────────┘
                                              │
                    ┌─────────────┬───────────┼───────────┐
                    ▼             ▼           ▼           ▼
                  null        'amber'    'jamie-pro'   (other)
                    │             │           │           │
                    ▼             ▼           ▼           ▼
              ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐
              │REGISTERED│ │SUBSCRIBER│ │  ADMIN  │ │REGISTERED│
              └──────────┘ └──────────┘ └─────────┘ └──────────┘
```

### Entitlement Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    IDENTITY RESOLVED                             │
│                                                                  │
│  Authenticated User:                                             │
│    identifier = "683e27e7173052dd16faffdb" (User._id)           │
│    identifierType = "mongoUserId"                               │
│    tier = "subscriber"                                          │
│                                                                  │
│  Anonymous User:                                                 │
│    identifier = "192.168.1.1" (IP address)                      │
│    identifierType = "ip"                                        │
│    tier = "anonymous"                                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 QUOTA CONFIG LOOKUP                              │
│                                                                  │
│  QUOTA_CONFIG[entitlementType][tier]                            │
│                                                                  │
│  Example: QUOTA_CONFIG['searchQuotes']['subscriber']            │
│           → { maxUsage: 500, periodLengthDays: 30 }             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              ENTITLEMENT DOCUMENT (MongoDB)                      │
│  {                                                               │
│    identifier: "683e27e7173052dd16faffdb",                      │
│    identifierType: "mongoUserId",                               │
│    entitlementType: "searchQuotes",                             │
│    usedCount: 42,                                               │
│    maxUsage: 500,                                               │
│    periodLengthDays: 30,                                        │
│    nextResetDate: "2026-02-26"                                  │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quota Table

| Entitlement | Anonymous | Registered | Subscriber | Admin |
|-------------|-----------|------------|------------|-------|
| `searchQuotes` | 100/week | 100/month | 500/month | ∞ |
| `search3D` | 20/week | 20/month | 100/month | ∞ |
| `makeClip` | 5/week | 10/month | 50/month | ∞ |
| `jamieAssist` | 10/week | 20/month | 100/month | ∞ |
| `onDemandRun` | 2/week | 5/month | 20/month | ∞ |

**Note:** Anonymous gets weekly resets, everyone else gets monthly.

---

## Key Files

| File | Purpose |
|------|---------|
| `models/shared/UserSchema.js` | Unified User schema (shared with auth server) |
| `utils/identityResolver.js` | JWT → User → Tier resolution |
| `utils/entitlementMiddleware.js` | Quota checking middleware factory |
| `models/Entitlement.js` | Entitlement document schema |

---

## API: Auth Server Endpoints

```
POST /auth/signup
Body: { provider: "email", credentials: { email, password } }
Returns: { token, subscriptionValid, subscriptionType }

POST /auth/signin  
Body: { provider: "email", credentials: { email, password } }
Returns: { token, subscriptionValid, subscriptionType }

GET /auth/nostr/challenge
Returns: { challenge }  (for NIP-07 signin)
```

---

## API: Backend Debug Endpoints

```
GET /api/debug/test-identity
Header: Authorization: Bearer <token>
Returns: { tier, identifier, identifierType, provider, email, ... }

GET /api/debug/test-entitlement/:type
Header: Authorization: Bearer <token>
Returns: { quota: { used, max, remaining, isEligible } }

POST /api/debug/test-consume/:type
Header: Authorization: Bearer <token>
Returns: { consumed: true, quota: { used, max, remaining } }
```

---

## JWT Structure

### New Format (from `/auth/signin`)
```json
{
  "sub": "jim@example.com",
  "provider": "email",
  "email": "jim@example.com",
  "iat": 1706284800,
  "exp": 1737820800
}
```

### Legacy Format (still supported)
```json
{
  "email": "jim@example.com",
  "iat": 1706284800,
  "exp": 1737820800
}
```

---

## Quick Reference: What Goes Where

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER DOCUMENT                            │
├─────────────────────────────────────────────────────────────────┤
│  _id ─────────────────────► Used as entitlement identifier      │
│  email ───────────────────► Display/logging only                │
│  authProvider.provider ───► "email" | "google" | "nostr" | ...  │
│  authProvider.providerId ─► Unique ID from that provider        │
│  subscriptionType ────────► Determines tier                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      ENTITLEMENT DOCUMENT                        │
├─────────────────────────────────────────────────────────────────┤
│  identifier ──────────────► User._id OR IP address              │
│  identifierType ──────────► "mongoUserId" | "ip"                │
│  entitlementType ─────────► "searchQuotes" | "search3D" | ...   │
│  usedCount / maxUsage ────► Quota tracking                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Common Questions

**Q: Why use `User._id` instead of email for entitlements?**
A: Not all users have email (Nostr). `_id` is always unique and never changes.

**Q: Why separate `provider` and `providerId`?**
A: So we can look up users by their OAuth ID without caring about email. A Google user with ID `118234567890` can be found even if their email changes.

**Q: Why weekly limits for anonymous but monthly for others?**
A: Anonymous users (IP-based) are harder to track reliably. Weekly limits prevent abuse while still being generous for legitimate use.

**Q: What's the difference between `subscriber` and `admin`?**
A: `subscriber` = $9.99 amber tier (generous quotas). `admin` = $50 jamie-pro tier (unlimited, for podcast owners).
