# Unified Authentication Scheme

> **Status:** WIP - Planning Phase  
> **Last Updated:** 2026-01-26  
> **Related:** [ENTITLEMENT_CONSOLIDATION_SPEC.md](./ENTITLEMENT_CONSOLIDATION_SPEC.md)

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Current State](#current-state)
3. [Proposed Changes](#proposed-changes)
4. [Shared User Schema](#shared-user-schema)
5. [Auth Server Changes](#auth-server-changes)
6. [Backend Changes](#backend-changes)
7. [JWT Structure](#jwt-structure)
8. [OAuth Provider Integration](#oauth-provider-integration)
9. [Migration Plan](#migration-plan)
10. [Open Questions](#open-questions)

---

## Architecture Overview

### Two-Server Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           FRONTEND                                   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
          ▼                     │                     ▼
┌─────────────────────┐         │         ┌─────────────────────────┐
│    AUTH SERVER      │         │         │       BACKEND           │
│  (cascdr-backend)   │         │         │ (pullthatupjamie-backend)│
├─────────────────────┤         │         ├─────────────────────────┤
│ • /signup           │         │         │ • /api/search-quotes    │
│ • /signin           │         │         │ • /api/search-quotes-3d │
│ • /signin/google    │◄────────┘         │ • /api/make-clip        │
│ • /signin/twitter   │   (future OAuth)  │ • /api/jamie-assist     │
│ • /signin/nostr     │                   │ • /api/on-demand/*      │
│ • /purchase-sub     │                   │ • etc.                  │
│ • /validate-sub     │                   │                         │
└─────────┬───────────┘                   └────────────┬────────────┘
          │                                            │
          │  JWT issued                    JWT validated│
          │                                            │
          └────────────────────┬───────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │      MongoDB        │
                    │  'users' collection │
                    └─────────────────────┘
```

### Responsibility Split

| Concern | Auth Server | Backend |
|---------|-------------|---------|
| User creation | ✅ | ❌ |
| Password management | ✅ | ❌ |
| OAuth integration | ✅ | ❌ |
| JWT issuance | ✅ | ❌ |
| JWT validation | ❌ | ✅ |
| Square/subscriptions | ✅ | ❌ (reads only) |
| Entitlement tracking | ❌ | ✅ |
| Entitlement enforcement | ❌ | ✅ |
| User preferences | ❌ | ✅ |

---

## Current State

### Auth Server (cascdr-backend)

**Endpoints:**
- `POST /signup` - Email/password registration
- `POST /signin` - Email/password login → JWT
- `POST /purchase-subscription` - Square payment flow
- `GET /validate-subscription` - Check subscription status
- `POST /check-eligibility` - Legacy eligibility check

**User Model:** `CASCDRUser` → writes to `users` collection

**Current Schema:**
```javascript
{
  email: String,
  password: String,        // bcrypt hashed
  squareCustomerId: String,
  subscriptionId: String,
  subscriptionType: 'amber' | 'jamie-pro' | null
}
```

### Backend (pullthatupjamie-backend)

**Auth Methods:**
1. JWT validation (from auth server)
2. HMAC service auth
3. Podcast admin JWT (separate)
4. Legacy IP-based free tier (SQLite)
5. Legacy Square Basic auth (SQLite)

**User Model:** `User` → writes to `users` collection (same!)

**Current Schema:**
```javascript
{
  email: String,
  password: String,
  squareCustomerId: String,
  subscriptionId: String,
  // Missing: subscriptionType
  app_preferences: Object,
  mention_preferences: Object
}
```

### The Problem

1. **Schema drift** - Two schemas for same collection
2. **No OAuth support** - Only email/password
3. **Fragmented entitlements** - IP tracking in SQLite, subscriptions in Mongo
4. **Duplicate eligibility logic** - Auth server has `/check-eligibility`, backend has middleware

---

## Proposed Changes

### High-Level Goals

1. **Unified User Schema** - Single source of truth shared between both codebases
2. **OAuth Support** - Google, Twitter/X, Nostr in auth server
3. **Consolidated Entitlements** - All in MongoDB, managed by backend
4. **Clear Boundaries** - Auth server = identity, Backend = entitlements

### What Changes Where

| Change | Location | Notes |
|--------|----------|-------|
| Add `authProvider` field | Shared schema | For OAuth provider tracking |
| Add `subscriptionType` | Shared schema | Already in auth server, add to backend |
| Google OAuth routes | Auth server | New endpoints |
| Twitter/X OAuth routes | Auth server | New endpoints |
| Nostr NIP-07 routes | Auth server | New endpoints |
| Entitlement middleware | Backend | Replace legacy middleware |
| IP tracking migration | Backend | SQLite → MongoDB Entitlements |
| Remove legacy SQLite | Backend | After migration complete |

---

## Shared User Schema

**Location:** `models/shared/UserSchema.js`

This file should be **identical** in both repositories:
- `pullthatupjamie-backend/models/shared/UserSchema.js`
- `cascdr-backend/models/shared/UserSchema.js` (to be created)

### Schema Structure

```javascript
const UserSchema = new mongoose.Schema({
  // ─────────────────────────────────────────
  // IDENTITY (Auth Server manages)
  // ─────────────────────────────────────────
  email: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  password: {
    type: String,
    required: true
  },
  authProvider: {
    provider: String,   // 'email' | 'google' | 'twitter' | 'nostr'
    providerId: String, // Provider-specific ID
    linkedAt: Date
  },
  
  // ─────────────────────────────────────────
  // SUBSCRIPTION (Auth Server manages)
  // ─────────────────────────────────────────
  squareCustomerId: String,
  subscriptionId: String,
  subscriptionType: 'amber' | 'jamie-pro' | null,
  
  // ─────────────────────────────────────────
  // PREFERENCES (Backend manages)
  // ─────────────────────────────────────────
  app_preferences: Object,
  mention_preferences: Object
});
```

### Auth Provider Values

| Provider | `providerId` Contains | Notes |
|----------|----------------------|-------|
| `email` | User's email address | Legacy/default method |
| `google` | Google user ID | From OAuth response |
| `twitter` | Twitter user ID | From OAuth response |
| `nostr` | User's npub | From NIP-07 signature |

### Key Constraint

**One provider per user.** No account linking/commingling. Users choose ONE auth method.

---

## Auth Server Changes

### New OAuth Endpoints

```javascript
// Google OAuth
POST /signin/google
Body: { idToken: string }
Response: { token: JWT, subscriptionValid: bool, subscriptionType: string }

// Twitter/X OAuth
POST /signin/twitter
Body: { oauthToken: string, oauthVerifier: string }
Response: { token: JWT, subscriptionValid: bool, subscriptionType: string }

// Nostr NIP-07
POST /signin/nostr
Body: { npub: string, signature: string, challenge: string }
Response: { token: JWT, subscriptionValid: bool, subscriptionType: string }
```

### OAuth Flow (Google Example)

```
1. Frontend: User clicks "Sign in with Google"
2. Frontend: Google SDK returns idToken
3. Frontend → Auth Server: POST /signin/google { idToken }
4. Auth Server: Verify idToken with Google
5. Auth Server: Extract googleUserId, email from token
6. Auth Server: Look up user by authProvider.providerId = googleUserId
7. If not found → Create new user with:
   - email: from Google
   - password: random (never used)
   - authProvider: { provider: 'google', providerId: googleUserId }
8. Auth Server: Issue JWT with email in payload
9. Response → Frontend: { token, subscriptionValid, subscriptionType }
```

### Signup Changes

When creating a new user via email/password:

```javascript
// In /signup handler, after creating user:
user.authProvider = {
  provider: 'email',
  providerId: email,
  linkedAt: new Date()
};
await user.save();
```

### Migration for Existing Users

Existing users (created before authProvider field) will have `authProvider: null`.

On next signin:
```javascript
// In /signin handler:
if (!user.authProvider) {
  user.authProvider = {
    provider: 'email',
    providerId: user.email,
    linkedAt: new Date()
  };
  await user.save();
}
```

---

## Backend Changes

### Identity Resolution

The backend receives a JWT from the auth server. It needs to:

1. Decode and verify the JWT
2. Extract the email from payload
3. Look up the User document
4. Determine the user's tier
5. Apply entitlement checks

```javascript
// utils/identityResolver.js

async function resolveIdentity(req) {
  const authHeader = req.headers.authorization;
  
  // No auth header → anonymous
  if (!authHeader) {
    return {
      tier: 'anonymous',
      identifier: req.ip,
      identifierType: 'ip',
      user: null
    };
  }
  
  // JWT auth
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
    const user = await User.findByEmail(payload.email);
    
    if (!user) {
      // Valid JWT but user deleted?
      return { tier: 'anonymous', identifier: req.ip, identifierType: 'ip', user: null };
    }
    
    // Determine tier from user
    const tier = determineTier(user);
    
    return {
      tier,
      identifier: user._id.toString(),
      identifierType: 'user',
      user
    };
  }
  
  // HMAC service auth (unchanged)
  // Podcast admin auth (unchanged)
  
  return { tier: 'anonymous', identifier: req.ip, identifierType: 'ip', user: null };
}

function determineTier(user) {
  // Check if podcast admin (requires ProPodcast lookup)
  // ... 
  
  if (user.subscriptionType === 'jamie-pro') return 'subscriber';
  if (user.subscriptionType === 'amber') return 'subscriber';
  return 'registered';
}
```

### Entitlement Middleware

Replace `jamieAuthMiddleware`, `freeRequestMiddleware`, `squareRequestMiddleware` with:

```javascript
// utils/entitlementMiddleware.js

function createEntitlementMiddleware(entitlementType) {
  return async (req, res, next) => {
    const identity = await resolveIdentity(req);
    
    // Get or create entitlement record
    const entitlement = await getOrCreateEntitlement(
      identity.identifier,
      identity.identifierType,
      entitlementType,
      identity.tier
    );
    
    // Check if eligible
    if (!entitlement.isEligible) {
      return res.status(429).json({
        error: 'Quota exceeded',
        used: entitlement.usedCount,
        max: entitlement.maxUsage,
        resetDate: entitlement.nextResetDate
      });
    }
    
    // Attach to request for later increment
    req.entitlement = entitlement;
    req.identity = identity;
    
    next();
  };
}
```

### Remove Legacy Systems

After migration:
- Delete `utils/requests-db.js`
- Delete `utils/jamie-user-db.js`
- Remove SQLite database files
- Remove legacy middleware from `server.js`

---

## JWT Structure

### Current JWT Payload

```javascript
{
  email: "user@example.com",
  iat: 1706284800,
  exp: 1737820800  // 365 days
}
```

### Proposed JWT Payload (Optional Enhancement)

Could include more info to reduce DB lookups:

```javascript
{
  email: "user@example.com",
  sub: "user_mongo_id",        // NEW: MongoDB _id
  provider: "google",          // NEW: auth provider
  tier: "subscriber",          // NEW: pre-computed tier
  iat: 1706284800,
  exp: 1737820800
}
```

**Decision:** Start with current payload (email only). Backend looks up user on each request. Optimize later if needed.

---

## OAuth Provider Integration

### Google OAuth

**Auth Server Implementation:**

```javascript
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.post('/signin/google', async (req, res) => {
  const { idToken } = req.body;
  
  // Verify with Google
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID
  });
  const payload = ticket.getPayload();
  const googleUserId = payload['sub'];
  const email = payload['email'];
  
  // Find or create user
  let user = await CASCDRUser.findOne({
    'authProvider.provider': 'google',
    'authProvider.providerId': googleUserId
  });
  
  if (!user) {
    // Check if email already exists (different provider)
    const existingEmail = await CASCDRUser.findOne({ email });
    if (existingEmail) {
      return res.status(409).json({
        error: 'Email already registered with different provider'
      });
    }
    
    // Create new user
    const squareCID = await createSquareCustomer(email);
    user = new CASCDRUser({
      email,
      password: crypto.randomBytes(32).toString('hex'), // Random, never used
      squareCustomerId: squareCID,
      authProvider: {
        provider: 'google',
        providerId: googleUserId,
        linkedAt: new Date()
      }
    });
    await user.save();
  }
  
  // Issue JWT
  const token = jwt.sign({ email: user.email }, process.env.CASCDR_AUTH_SECRET, {
    expiresIn: '365d'
  });
  
  // Check subscription
  const subscriptionStatus = await checkSubscriptionStatus(
    user.subscriptionId,
    user.subscriptionType
  );
  
  res.json({
    token,
    subscriptionValid: subscriptionStatus.isValid,
    subscriptionType: subscriptionStatus.type
  });
});
```

### Twitter/X OAuth

Uses OAuth 1.0a flow. Requires:
- `TWITTER_API_KEY`
- `TWITTER_API_SECRET`
- `TWITTER_CALLBACK_URL`

### Nostr NIP-07

```javascript
app.post('/signin/nostr', async (req, res) => {
  const { npub, signature, challenge } = req.body;
  
  // Verify signature matches challenge
  // (challenge was issued by GET /nostr/challenge)
  const isValid = verifyNostrSignature(npub, signature, challenge);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // Find or create user
  let user = await CASCDRUser.findOne({
    'authProvider.provider': 'nostr',
    'authProvider.providerId': npub
  });
  
  if (!user) {
    // Nostr users may not have email - generate placeholder
    const placeholderEmail = `${npub.slice(0, 20)}@nostr.local`;
    
    user = new CASCDRUser({
      email: placeholderEmail,
      password: crypto.randomBytes(32).toString('hex'),
      // No Square customer for Nostr users (they pay via Lightning)
      authProvider: {
        provider: 'nostr',
        providerId: npub,
        linkedAt: new Date()
      }
    });
    await user.save();
  }
  
  const token = jwt.sign({ email: user.email }, process.env.CASCDR_AUTH_SECRET, {
    expiresIn: '365d'
  });
  
  res.json({ token, subscriptionValid: false, subscriptionType: null });
});
```

---

## Migration Plan

### Phase 1: Schema Unification (Backend)

1. ✅ Create `models/shared/UserSchema.js`
2. ✅ Update `models/User.js` to re-export from shared
3. ⬜ Test that existing functionality works
4. ⬜ Deploy backend

### Phase 2: Schema Unification (Auth Server)

1. ⬜ Copy `models/shared/UserSchema.js` to auth server
2. ⬜ Update auth server's model import
3. ⬜ Update `/signup` to set `authProvider` for new users
4. ⬜ Update `/signin` to backfill `authProvider` for existing users
5. ⬜ Test and deploy auth server

### Phase 3: Entitlement Consolidation (Backend)

1. ⬜ Create `utils/identityResolver.js`
2. ⬜ Create `utils/entitlementMiddleware.js`
3. ⬜ Apply middleware to expensive routes
4. ⬜ Migrate IP tracking to MongoDB Entitlements
5. ⬜ Remove legacy SQLite systems

### Phase 4: OAuth Integration (Auth Server)

1. ⬜ Implement Google OAuth endpoint
2. ⬜ Implement Twitter/X OAuth endpoint
3. ⬜ Implement Nostr NIP-07 endpoint
4. ⬜ Update frontend to support OAuth buttons

### Phase 5: Cleanup

1. ⬜ Remove legacy middleware from backend
2. ⬜ Remove SQLite files
3. ⬜ Update documentation

---

## Open Questions

### 1. Email Requirement for OAuth Users

**Google/Twitter:** Both provide email, no issue.

**Nostr:** Users may not have/want to share email.

**Options:**
- A) Generate placeholder email (`npub...@nostr.local`)
- B) Make email optional in schema
- C) Require email even for Nostr users

**Current Decision:** Option A - placeholder email. Revisit if issues arise.

### 2. Password for OAuth Users

OAuth users don't use passwords, but schema requires it.

**Solution:** Generate random password on OAuth signup. User can never sign in with it (no `/signin` route accepts their email without OAuth).

### 3. Square Customer for Non-Email Auth

Should Nostr users get a Square customer ID?

**Current Decision:** No. Nostr users are expected to pay via Lightning (future). Google/Twitter users can still subscribe via Square using their email.

### 4. What Happens If OAuth Provider Revokes Access?

User's account still exists. They can't sign in again via that provider, but their data remains. They would need to contact support.

**Future Enhancement:** Account recovery flow.

### 5. Rate Limiting OAuth Endpoints

OAuth endpoints should have stricter rate limits to prevent abuse.

**Recommendation:** 10 requests per minute per IP for OAuth endpoints.

---

## Appendix: Environment Variables

### Auth Server

```env
# Existing
MONGO_URI=...
CASCDR_AUTH_SECRET=...
SQUARE_API_TOKEN_PROD=...
SQUARE_API_TOKEN_SANDBOX=...

# New for OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TWITTER_CALLBACK_URL=...
```

### Backend

```env
# Existing
MONGO_URI=...
CASCDR_AUTH_SECRET=...  # Same as auth server for JWT validation
```

---

## Appendix: Testing Checklist

### Auth Server Tests

- [ ] Email signup creates user with `authProvider.provider = 'email'`
- [ ] Email signin backfills `authProvider` for existing users
- [ ] Google OAuth creates new user correctly
- [ ] Google OAuth finds existing user correctly
- [ ] Google OAuth rejects duplicate email from different provider
- [ ] Twitter OAuth works similarly
- [ ] Nostr signin creates user with placeholder email
- [ ] JWT contains correct email
- [ ] Subscription purchase still works

### Backend Tests

- [ ] JWT from auth server validates correctly
- [ ] User lookup by email works
- [ ] Tier determination is correct for each subscription type
- [ ] Entitlement middleware enforces quotas
- [ ] Anonymous users get IP-based entitlements
- [ ] Registered users get user-based entitlements
- [ ] Subscribers get higher quotas
- [ ] 429 returned when quota exceeded
