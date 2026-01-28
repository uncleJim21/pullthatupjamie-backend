# Frontend Auth Migration Guide

> **For:** Frontend Team / Agent  
> **Date:** January 2026  
> **Backend Version:** New Provider-Agnostic Auth System

---

## Overview

The backend has migrated to a new authentication and entitlement system. This document covers all changes the frontend needs to implement.

### Key Changes Summary

| Area | Old System | New System |
|------|------------|------------|
| Auth endpoints | `/auth/login`, `/auth/register` | `/auth/signin`, `/auth/signup` (provider-based) |
| JWT payload | `{ email }` | `{ sub, provider, email? }` |
| User identity | Email-only | Multi-provider (email, nostr, twitter) |
| Rate limiting | IP-based free tier + Square sub | MongoDB entitlements per user |
| Lightning auth | BOLT11 payment header | **Removed** (temporary) |
| Subscription sync | `/register-sub` endpoint | **Removed** (handled by auth server) |

---

## 1. Authentication Endpoints

### Base URLs
- **Auth Server:** `https://cascdr-auth-backend-cw4nk.ondigitalocean.app` (prod) / `http://localhost:6111` (dev)
- **Backend:** `https://pullthatupjamie-explore-alpha-xns9k.ondigitalocean.app` (prod) / `http://localhost:4132` (dev)

---

### 1.1 Email Signup

```http
POST /auth/signup
Content-Type: application/json

{
  "provider": "email",
  "credentials": {
    "email": "user@example.com",
    "password": "securepassword123"
  }
}
```

**Response (200):**
```json
{
  "message": "User created successfully",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "subscriptionValid": false,
  "subscriptionType": null
}
```

**Errors:**
- `400` - Invalid email/password format
- `409` - Email already registered

---

### 1.2 Email Signin

```http
POST /auth/signin
Content-Type: application/json

{
  "provider": "email",
  "credentials": {
    "email": "user@example.com",
    "password": "securepassword123"
  }
}
```

**Response (200):**
```json
{
  "message": "Signed in successfully",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "subscriptionValid": true,
  "subscriptionType": "subscriber"
}
```

**Errors:**
- `401` - Invalid credentials
- `404` - User not found

---

### 1.3 Nostr (NIP-07) Authentication

#### Step 1: Check for Extension
```javascript
if (!window.nostr) {
  // Show "Install Alby/nos2x" message
  return;
}
```

#### Step 2: Get Public Key
```javascript
const npub = await window.nostr.getPublicKey();
// Returns hex pubkey, convert to npub format
import { nip19 } from 'nostr-tools';
const npubEncoded = nip19.npubEncode(npub);
```

#### Step 3: Request Challenge
```http
POST /auth/nostr/challenge
Content-Type: application/json

{
  "npub": "npub1abc..."
}
```

**Response:**
```json
{
  "challenge": "fd69b31c87bd1540bf44...",
  "expiresIn": 300
}
```

#### Step 4: Sign Challenge
```javascript
const event = {
  kind: 22242,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['challenge', challenge]],
  content: 'Sign in to PullThatUpJamie'
};

const signedEvent = await window.nostr.signEvent(event);
```

#### Step 5: Verify & Get JWT
```http
POST /auth/nostr/verify
Content-Type: application/json

{
  "npub": "npub1abc...",
  "signedEvent": { /* signed event object */ }
}
```

**Response (200):**
```json
{
  "message": "Signed in successfully",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "subscriptionValid": false,
  "subscriptionType": null
}
```

---

### 1.4 Twitter/X OAuth (Coming Soon)

```
Flow: Standard OAuth 2.0 PKCE
Endpoints: TBD
```

---

## 2. JWT Structure

### New JWT Payload Format

```json
{
  "sub": "user@example.com",      // Provider-specific ID (email, npub, twitter_id)
  "provider": "email",            // "email" | "nostr" | "twitter"
  "email": "user@example.com",    // Optional - null for Nostr users
  "iat": 1769537570,
  "exp": 1801073570               // 1 year expiry
}
```

### Provider-Specific `sub` Values

| Provider | `sub` Value | `email` Field |
|----------|-------------|---------------|
| email | `user@example.com` | Same as sub |
| nostr | `npub1abc...` | `null` |
| twitter | `twitter_user_id` | May be present |

### Storing & Using JWT

```javascript
// Store after login
localStorage.setItem('jwt', token);

// Use in API requests
fetch('/api/search-quotes-3d', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ query: '...' })
});
```

---

## 3. User Tiers

| Tier | Description | How Determined |
|------|-------------|----------------|
| `anonymous` | No JWT / invalid JWT | No auth header |
| `registered` | Valid JWT, no subscription | `subscriptionType: null` |
| `subscriber` | Valid JWT with active subscription | `subscriptionType: "subscriber"` |
| `admin` | Admin user | `subscriptionType: "admin"` |

### Getting User Tier

The tier is returned in the eligibility check (see section 4).

---

## 4. Entitlement Checking

### Check All Entitlements

Call this on app load and before expensive operations:

```http
GET /api/on-demand/checkEligibility
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "tier": "registered",
  "identifier": "abc123...",
  "identifierType": "mongoUserId",
  "hasUser": true,
  "entitlements": {
    "searchQuotes": {
      "eligible": true,
      "used": 5,
      "max": 100,
      "remaining": 95,
      "isUnlimited": false,
      "periodLengthDays": 30,
      "periodStart": "2026-01-01T00:00:00.000Z",
      "nextResetDate": "2026-01-31T00:00:00.000Z",
      "daysUntilReset": 4
    },
    "search3D": { /* same structure */ },
    "makeClip": { /* same structure */ },
    "jamieAssist": { /* same structure */ },
    "researchAnalyze": { /* same structure */ },
    "onDemandRun": { /* same structure */ }
  }
}
```

### Entitlement Types → Endpoints Mapping

| Entitlement Type | Endpoint(s) |
|------------------|-------------|
| `searchQuotes` | `POST /api/search-quotes` |
| `search3D` | `POST /api/search-quotes-3d`, `POST /api/search-quotes-3d/expand` |
| `makeClip` | `POST /api/make-clip` |
| `jamieAssist` | `POST /api/jamie-assist/:lookupHash` |
| `researchAnalyze` | `POST /api/research/analyze` |
| `onDemandRun` | `POST /api/on-demand/submitOnDemandRun` |

---

## 5. Quota Limits by Tier

### Production Limits

| Entitlement | Anonymous | Registered | Subscriber | Admin |
|-------------|-----------|------------|------------|-------|
| searchQuotes | 100/week | 100/month | 500/month | ∞ |
| search3D | 20/week | 20/month | 100/month | ∞ |
| makeClip | 5/week | 10/month | 50/month | ∞ |
| jamieAssist | 10/week | 20/month | 100/month | ∞ |
| researchAnalyze | 5/week | 10/month | 50/month | ∞ |
| onDemandRun | 0 | 1/month | 5/month | ∞ |

---

## 6. Error Handling

### Quota Exceeded (429)

When a user exceeds their quota:

```json
{
  "error": "Quota exceeded",
  "code": "QUOTA_EXCEEDED",
  "used": 100,
  "max": 100,
  "resetDate": "2026-02-01T00:00:00.000Z",
  "daysUntilReset": 4,
  "tier": "registered"
}
```

**Frontend handling:**
```javascript
if (response.status === 429) {
  const data = await response.json();
  showQuotaExceededModal({
    used: data.used,
    max: data.max,
    resetDate: data.resetDate,
    upgradeUrl: '/pricing'  // if tier !== 'subscriber'
  });
}
```

### Authentication Errors

| Status | Code | Meaning |
|--------|------|---------|
| 401 | `AUTH_REQUIRED` | No token or invalid token |
| 401 | `TOKEN_EXPIRED` | JWT expired |
| 403 | `FORBIDDEN` | Valid token but not authorized |

---

## 7. UI Components Needed

### 7.1 Login Modal/Page

```
┌─────────────────────────────────────┐
│          Sign In                    │
├─────────────────────────────────────┤
│  [Email]  [Password]  [Sign In]     │
│                                     │
│  ─────────── OR ───────────         │
│                                     │
│  [🔑 Sign in with Nostr]            │
│  [𝕏 Sign in with X] (coming soon)  │
│                                     │
│  Don't have an account? [Sign Up]   │
└─────────────────────────────────────┘
```

### 7.2 Usage/Quota Display

```
┌─────────────────────────────────────┐
│  Your Usage This Month              │
├─────────────────────────────────────┤
│  Searches     ████████░░  80/100    │
│  3D Searches  ██░░░░░░░░  4/20      │
│  Clips        █░░░░░░░░░  2/10      │
│  AI Analysis  ░░░░░░░░░░  0/20      │
│                                     │
│  Resets in 4 days                   │
│  [Upgrade for more →]               │
└─────────────────────────────────────┘
```

### 7.3 Quota Exceeded Modal

```
┌─────────────────────────────────────┐
│  ⚠️ Limit Reached                   │
├─────────────────────────────────────┤
│  You've used all 100 searches       │
│  this month.                        │
│                                     │
│  Your quota resets on Feb 1, 2026   │
│                                     │
│  [Upgrade to Subscriber]  [Close]   │
└─────────────────────────────────────┘
```

---

## 8. Migration Checklist

### Remove (Deprecated)
- [ ] Lightning/BOLT11 payment auth flow
- [ ] `/register-sub` endpoint calls
- [ ] IP-based free tier checking (`/api/check-free-eligibility`)
- [ ] Square-specific subscription sync logic

### Update
- [ ] Signin endpoint: `/auth/login` → `/auth/signin` with provider format
- [ ] Signup endpoint: `/auth/register` → `/auth/signup` with provider format
- [ ] JWT parsing to handle new `sub`/`provider` fields
- [ ] Handle `email: null` for Nostr users (display npub instead)

### Add
- [ ] Nostr login button + NIP-07 flow
- [ ] X/Twitter login button (when ready)
- [ ] Entitlement checking on app load
- [ ] Quota display component
- [ ] Pre-action quota check before expensive operations
- [ ] 429 error handling with upgrade prompt
- [ ] Tier badge/indicator in user menu

---

## 9. Code Examples

### React Hook: useEntitlements

```javascript
import { useState, useEffect } from 'react';

export function useEntitlements() {
  const [entitlements, setEntitlements] = useState(null);
  const [tier, setTier] = useState('anonymous');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchEntitlements = async () => {
      const token = localStorage.getItem('jwt');
      
      try {
        const response = await fetch('/api/on-demand/checkEligibility', {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        
        const data = await response.json();
        setEntitlements(data.entitlements);
        setTier(data.tier);
      } catch (error) {
        console.error('Failed to fetch entitlements:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchEntitlements();
  }, []);

  const canUse = (type) => {
    if (!entitlements?.[type]) return false;
    return entitlements[type].eligible && entitlements[type].remaining > 0;
  };

  return { entitlements, tier, loading, canUse };
}
```

### Pre-Action Check

```javascript
const { canUse, entitlements } = useEntitlements();

const handleSearch3D = async (query) => {
  if (!canUse('search3D')) {
    showQuotaExceededModal(entitlements.search3D);
    return;
  }

  try {
    const response = await fetch('/api/search-quotes-3d', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    if (response.status === 429) {
      const error = await response.json();
      showQuotaExceededModal(error);
      return;
    }

    // Handle success...
  } catch (error) {
    // Handle error...
  }
};
```

### Nostr Login Component

```javascript
import { nip19 } from 'nostr-tools';

async function handleNostrLogin() {
  // Check for extension
  if (!window.nostr) {
    alert('Please install a Nostr extension like Alby or nos2x');
    return;
  }

  try {
    // Get public key
    const pubkeyHex = await window.nostr.getPublicKey();
    const npub = nip19.npubEncode(pubkeyHex);

    // Request challenge
    const challengeRes = await fetch('/auth/nostr/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ npub })
    });
    const { challenge } = await challengeRes.json();

    // Sign challenge
    const event = {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['challenge', challenge]],
      content: 'Sign in to PullThatUpJamie'
    };
    const signedEvent = await window.nostr.signEvent(event);

    // Verify and get JWT
    const verifyRes = await fetch('/auth/nostr/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ npub, signedEvent })
    });
    const { token } = await verifyRes.json();

    // Store token and redirect
    localStorage.setItem('jwt', token);
    window.location.href = '/dashboard';
    
  } catch (error) {
    console.error('Nostr login failed:', error);
    alert('Login failed. Please try again.');
  }
}
```

---

## 10. Testing

### Test Accounts (Debug Mode)

| Type | Credentials | Tier |
|------|-------------|------|
| Email (registered) | `jim.carucci+test-registered@protonmail.com` / `testpass123` | registered |
| Email (subscriber) | `jim.carucci+test-subscriber@protonmail.com` / `testpass123` | subscriber |
| Email (admin) | `jim.carucci+test-admin@protonmail.com` / `testpass123` | admin |
| Nostr | Use test script keypair | registered |

### Verifying Integration

1. **Login flow works** - Get JWT, store it
2. **Entitlements load** - Call checkEligibility, display quotas
3. **Quota enforcement** - Use up quota, verify 429 response
4. **Tier display** - Correct tier shown based on subscription

---

## Questions?

Contact backend team or check:
- `docs/WIP/NewAuthCheatSheet.md` - Terminology and concepts
- `docs/WIP/AUTH_SERVER_MIGRATION_PROMPT.md` - Auth server details
- `test/new-auth/` - Test scripts for reference
