# Auth Server: Twitter OAuth Implementation Spec

## Overview

This document specifies the changes needed on the **auth server (cascdr-backend)** to support Twitter-based user authentication. The backend (pullthatupjamie-backend) handles the Twitter OAuth flow and calls these endpoints to create/find users and issue JWTs.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ FLOW SUMMARY                                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. User clicks "Sign in with Twitter" → Backend /api/twitter/auth-initiate │
│  2. User authorizes on Twitter                                               │
│  3. Twitter redirects to Backend /api/twitter/callback                       │
│  4. Backend calls Auth Server /internal/twitter/create-user (this doc)       │
│  5. Auth Server creates/finds user, stores tokens, returns tempCode          │
│  6. Backend redirects user to Frontend /auth/twitter/complete?code=xxx       │
│  7. Frontend calls Auth Server /auth/twitter/exchange (this doc)             │
│  8. Auth Server returns JWT                                                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Environment Variables

Add these to your auth server `.env`:

```bash
# Shared secret for backend <-> auth server internal communication
# Must match the value in pullthatupjamie-backend
JAMIE_TO_AUTH_SERVER_HMAC_SECRET=<same_value_as_backend>
```

---

## Schema Changes

> **IMPORTANT**: The shared `UserSchema` in `pullthatupjamie-backend/models/shared/UserSchema.js` 
> has already been updated with the `twitterTokens` field. Your `CASCDRUser` model should match.

### Update: `models/CASCDRUser.js`

Add the `twitterTokens` field to store OAuth tokens for tweet posting capability:

```javascript
const CASCDRUserSchema = new mongoose.Schema({
  // ... existing fields ...
  
  email: { type: String },  // Note: May be null for Twitter/Nostr users
  password: { type: String },
  
  // NEW: Auth provider info (for non-email auth methods)
  authProvider: {
    provider: {
      type: String,
      enum: ['email', 'google', 'twitter', 'nostr']
    },
    providerId: String,  // Twitter user ID, Google ID, npub, etc.
    linkedAt: { type: Date, default: Date.now }
  },
  
  // NEW: Twitter tokens for posting capability
  twitterTokens: {
    accessToken: String,      // OAuth 2.0 access token (consider encrypting)
    refreshToken: String,     // OAuth 2.0 refresh token (consider encrypting)
    expiresAt: Date,
    twitterUsername: String,
    twitterId: String
  },
  
  // ... existing fields ...
  squareCustomerId: { type: String, default: null },
  subscriptionId: { type: String, default: null },
  subscriptionType: { type: String, enum: ['amber', 'jamie-pro', null], default: null }
});

// Add index for auth provider lookup
CASCDRUserSchema.index(
  { 'authProvider.provider': 1, 'authProvider.providerId': 1 },
  { unique: true, sparse: true }
);
```

---

## New Endpoints

### 1. `POST /internal/twitter/create-user`

**Purpose:** Receives Twitter user data from the backend, creates or finds the user, stores tokens, and returns a temporary code.

**Security:** This is an INTERNAL endpoint. Only the backend should call it. Verify HMAC signature.

#### Request

```http
POST /internal/twitter/create-user
Content-Type: application/json
X-Internal-Signature: <hmac_sha256_signature>

{
  "twitterId": "1234567890",
  "twitterUsername": "johndoe",
  "twitterName": "John Doe",
  "accessToken": "oauth2_access_token",
  "refreshToken": "oauth2_refresh_token",
  "expiresAt": 1706536800000,
  "timestamp": 1706450400000
}
```

#### Response (Success)

```json
{
  "success": true,
  "tempCode": "tc_a1b2c3d4e5f6g7h8",
  "isNewUser": true,
  "userId": "65b1234567890abcdef12345"
}
```

#### Response (Error)

```json
{
  "success": false,
  "error": "Invalid signature"
}
```

#### Implementation

```javascript
const crypto = require('crypto');

// In-memory temp code store (use Redis in production for multi-instance)
const tempCodeStore = new Map();

// Cleanup expired codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of tempCodeStore.entries()) {
    if (now - data.timestamp > 5 * 60 * 1000) {
      tempCodeStore.delete(code);
    }
  }
}, 5 * 60 * 1000);

/**
 * Verify HMAC signature from backend
 */
function verifyInternalSignature(payload, signature) {
  const secret = process.env.JAMIE_TO_AUTH_SERVER_HMAC_SECRET;
  if (!secret) {
    console.error('JAMIE_TO_AUTH_SERVER_HMAC_SECRET not configured');
    return false;
  }
  
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Generate a random temp code
 */
function generateTempCode() {
  return 'tc_' + crypto.randomBytes(16).toString('hex');
}

/**
 * POST /internal/twitter/create-user
 * Internal endpoint - creates/finds user from Twitter OAuth data
 */
router.post('/internal/twitter/create-user', async (req, res) => {
  try {
    const signature = req.headers['x-internal-signature'];
    const payload = req.body;

    // Verify signature
    if (!signature || !verifyInternalSignature(payload, signature)) {
      console.error('Invalid internal signature for twitter/create-user');
      return res.status(401).json({
        success: false,
        error: 'Invalid signature'
      });
    }

    // Verify timestamp (reject if older than 5 minutes)
    if (Date.now() - payload.timestamp > 5 * 60 * 1000) {
      return res.status(400).json({
        success: false,
        error: 'Request expired'
      });
    }

    const { twitterId, twitterUsername, twitterName, accessToken, refreshToken, expiresAt } = payload;

    console.log('🐦 Creating/finding user for Twitter:', twitterUsername);

    // Find existing user by Twitter ID
    let user = await CASCDRUser.findOne({
      'authProvider.provider': 'twitter',
      'authProvider.providerId': twitterId
    });

    const isNewUser = !user;

    if (isNewUser) {
      // Create new user
      user = new CASCDRUser({
        email: null,  // Twitter doesn't provide email reliably
        password: null,
        authProvider: {
          provider: 'twitter',
          providerId: twitterId,
          linkedAt: new Date()
        },
        twitterTokens: {
          accessToken,
          refreshToken,
          expiresAt: new Date(expiresAt),
          twitterUsername,
          twitterId
        }
      });

      await user.save();
      console.log('   Created new user:', user._id);

    } else {
      // Update existing user's tokens
      user.twitterTokens = {
        accessToken,
        refreshToken,
        expiresAt: new Date(expiresAt),
        twitterUsername,
        twitterId
      };

      await user.save();
      console.log('   Updated existing user:', user._id);
    }

    // Generate temp code
    const tempCode = generateTempCode();
    
    // Store temp code with user info (expires in 60 seconds)
    tempCodeStore.set(tempCode, {
      userId: user._id.toString(),
      twitterId,
      twitterUsername,
      isNewUser,
      timestamp: Date.now()
    });

    console.log('   Generated temp code:', tempCode.substring(0, 10) + '...');

    res.json({
      success: true,
      tempCode,
      isNewUser,
      userId: user._id.toString()
    });

  } catch (error) {
    console.error('Error in /internal/twitter/create-user:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});
```

---

### 2. `POST /auth/twitter/exchange`

**Purpose:** Frontend exchanges a temp code for a JWT. This is the final step of authentication.

**Security:** Public endpoint, but temp codes are single-use and expire quickly.

#### Request

```http
POST /auth/twitter/exchange
Content-Type: application/json

{
  "code": "tc_a1b2c3d4e5f6g7h8"
}
```

#### Response (Success)

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "isNewUser": true,
  "user": {
    "twitterUsername": "johndoe",
    "twitterId": "1234567890",
    "subscriptionValid": false,
    "subscriptionType": null
  }
}
```

#### Response (Error)

```json
{
  "success": false,
  "error": "Invalid or expired code"
}
```

#### Implementation

```javascript
/**
 * POST /auth/twitter/exchange
 * Exchange temp code for JWT
 */
router.post('/auth/twitter/exchange', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Code required'
      });
    }

    // Look up temp code
    const codeData = tempCodeStore.get(code);

    if (!codeData) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired code'
      });
    }

    // Check expiration (60 second max)
    if (Date.now() - codeData.timestamp > 60 * 1000) {
      tempCodeStore.delete(code);
      return res.status(400).json({
        success: false,
        error: 'Code expired'
      });
    }

    // Delete code (single use)
    tempCodeStore.delete(code);

    // Look up user to get current subscription status
    const user = await CASCDRUser.findById(codeData.userId);
    
    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check subscription status if they have one
    let subscriptionStatus = { isValid: false, type: null };
    if (user.subscriptionId) {
      subscriptionStatus = await checkSubscriptionStatus(user.subscriptionId, user.subscriptionType);
    }

    // Generate JWT
    const jwtPayload = {
      sub: codeData.twitterId,      // Provider ID
      provider: 'twitter',
      email: null                    // Twitter users may not have email
    };

    const token = jwt.sign(jwtPayload, process.env.CASCDR_AUTH_SECRET, {
      expiresIn: '365d'
    });

    console.log('🎫 Issued JWT for Twitter user:', codeData.twitterUsername);

    res.json({
      success: true,
      token,
      isNewUser: codeData.isNewUser,
      user: {
        twitterUsername: codeData.twitterUsername,
        twitterId: codeData.twitterId,
        subscriptionValid: subscriptionStatus.isValid,
        subscriptionType: subscriptionStatus.type
      }
    });

  } catch (error) {
    console.error('Error in /auth/twitter/exchange:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});
```

---

## File Structure

Create or update these files:

```
cascdr-backend/
├── auth/
│   ├── routes.js           # Mount point for auth routes
│   ├── twitterAuth.js      # NEW: Twitter auth endpoints
│   └── internalAuth.js     # NEW: HMAC verification middleware (optional)
├── models/
│   └── CASCDRUser.js       # UPDATE: Add twitterTokens field
└── .env                    # UPDATE: Add JAMIE_TO_AUTH_SERVER_HMAC_SECRET
```

### Mounting the routes

In your main server file or `auth/routes.js`:

```javascript
const twitterAuth = require('./twitterAuth');

// Mount Twitter auth routes
router.use('/', twitterAuth);  // Adds /internal/twitter/* and /auth/twitter/*
```

---

## Complete `auth/twitterAuth.js`

Here's the complete file for easy copy-paste:

```javascript
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const CASCDRUser = require('../models/CASCDRUser');
const { checkSubscriptionStatus } = require('../square_apis/SquareCustomersAPI');

// ============================================
// TEMP CODE STORAGE
// ============================================

// In-memory store (use Redis in production for multi-instance)
const tempCodeStore = new Map();

// Cleanup expired codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of tempCodeStore.entries()) {
    if (now - data.timestamp > 5 * 60 * 1000) {
      tempCodeStore.delete(code);
    }
  }
}, 5 * 60 * 1000);

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Verify HMAC signature from backend
 */
function verifyInternalSignature(payload, signature) {
  const secret = process.env.JAMIE_TO_AUTH_SERVER_HMAC_SECRET;
  if (!secret) {
    console.error('JAMIE_TO_AUTH_SERVER_HMAC_SECRET not configured');
    return false;
  }
  
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (e) {
    return false;
  }
}

/**
 * Generate a random temp code
 */
function generateTempCode() {
  return 'tc_' + crypto.randomBytes(16).toString('hex');
}

// ============================================
// INTERNAL ENDPOINTS (Backend -> Auth Server)
// ============================================

/**
 * POST /internal/twitter/create-user
 * 
 * Called by the backend after successful Twitter OAuth.
 * Creates or finds a user, stores tokens, returns a temp code.
 * 
 * Security: Requires valid HMAC signature in X-Internal-Signature header.
 */
router.post('/internal/twitter/create-user', async (req, res) => {
  try {
    const signature = req.headers['x-internal-signature'];
    const payload = req.body;

    // Verify signature
    if (!signature || !verifyInternalSignature(payload, signature)) {
      console.error('❌ Invalid internal signature for twitter/create-user');
      return res.status(401).json({
        success: false,
        error: 'Invalid signature'
      });
    }

    // Verify timestamp (reject if older than 5 minutes)
    if (Date.now() - payload.timestamp > 5 * 60 * 1000) {
      return res.status(400).json({
        success: false,
        error: 'Request expired'
      });
    }

    const { 
      twitterId, 
      twitterUsername, 
      twitterName, 
      accessToken, 
      refreshToken, 
      expiresAt 
    } = payload;

    console.log('🐦 Processing Twitter auth for:', twitterUsername);

    // Find existing user by Twitter ID
    let user = await CASCDRUser.findOne({
      'authProvider.provider': 'twitter',
      'authProvider.providerId': twitterId
    });

    const isNewUser = !user;

    if (isNewUser) {
      // Create new user
      user = new CASCDRUser({
        email: null,
        password: null,
        authProvider: {
          provider: 'twitter',
          providerId: twitterId,
          linkedAt: new Date()
        },
        twitterTokens: {
          accessToken,
          refreshToken,
          expiresAt: new Date(expiresAt),
          twitterUsername,
          twitterId
        }
      });

      await user.save();
      console.log('   ✅ Created new user:', user._id);

    } else {
      // Update existing user's tokens
      user.twitterTokens = {
        accessToken,
        refreshToken,
        expiresAt: new Date(expiresAt),
        twitterUsername,
        twitterId
      };

      await user.save();
      console.log('   ✅ Updated existing user:', user._id);
    }

    // Generate temp code (single-use, expires in 60 seconds)
    const tempCode = generateTempCode();
    
    tempCodeStore.set(tempCode, {
      userId: user._id.toString(),
      twitterId,
      twitterUsername,
      isNewUser,
      timestamp: Date.now()
    });

    console.log('   🎫 Generated temp code');

    res.json({
      success: true,
      tempCode,
      isNewUser,
      userId: user._id.toString()
    });

  } catch (error) {
    console.error('❌ Error in /internal/twitter/create-user:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// ============================================
// PUBLIC ENDPOINTS (Frontend -> Auth Server)
// ============================================

/**
 * POST /auth/twitter/exchange
 * 
 * Exchange a temp code for a JWT.
 * Called by the frontend after redirect from backend.
 * 
 * Security: Temp codes are single-use and expire in 60 seconds.
 */
router.post('/auth/twitter/exchange', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Code required'
      });
    }

    // Look up temp code
    const codeData = tempCodeStore.get(code);

    if (!codeData) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired code'
      });
    }

    // Check expiration (60 second max)
    if (Date.now() - codeData.timestamp > 60 * 1000) {
      tempCodeStore.delete(code);
      return res.status(400).json({
        success: false,
        error: 'Code expired'
      });
    }

    // Delete code (single use)
    tempCodeStore.delete(code);

    // Look up user to get current subscription status
    const user = await CASCDRUser.findById(codeData.userId);
    
    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check subscription status
    let subscriptionStatus = { isValid: false, type: null };
    if (user.subscriptionId) {
      try {
        subscriptionStatus = await checkSubscriptionStatus(
          user.subscriptionId, 
          user.subscriptionType
        );
      } catch (subError) {
        console.error('Subscription check failed:', subError.message);
        // Continue without subscription info
      }
    }

    // Generate JWT with new provider-based payload
    const jwtPayload = {
      sub: codeData.twitterId,      // Provider ID (Twitter user ID)
      provider: 'twitter',
      email: null                    // Twitter users typically don't have email
    };

    const token = jwt.sign(jwtPayload, process.env.CASCDR_AUTH_SECRET, {
      expiresIn: '365d'
    });

    console.log('🎫 Issued JWT for Twitter user:', codeData.twitterUsername);

    res.json({
      success: true,
      token,
      isNewUser: codeData.isNewUser,
      user: {
        twitterUsername: codeData.twitterUsername,
        twitterId: codeData.twitterId,
        subscriptionValid: subscriptionStatus.isValid,
        subscriptionType: subscriptionStatus.type
      }
    });

  } catch (error) {
    console.error('❌ Error in /auth/twitter/exchange:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

module.exports = router;
```

---

## Mounting in Main Server

In your main Express app (server.js or wherever routes are mounted):

```javascript
// Existing auth routes
const authRoutes = require('./auth/routes');
app.use('/auth', authRoutes);

// NEW: Twitter auth routes (can be mounted in auth/routes.js instead)
const twitterAuth = require('./auth/twitterAuth');
app.use('/', twitterAuth);  // Mounts at /internal/twitter/* and /auth/twitter/*
```

Or in `auth/routes.js`:

```javascript
const twitterAuth = require('./twitterAuth');
router.use('/', twitterAuth);
```

---

## Testing Checklist

### Manual Test Flow

1. **Start both servers**
   - Backend on :4132
   - Auth server on :6111

2. **Visit auth-initiate**
   ```
   http://localhost:4132/api/twitter/auth-initiate?redirect_uri=http://localhost:3000
   ```

3. **Authorize on Twitter**
   - Should redirect back to backend

4. **Backend calls auth server**
   - Check auth server logs for "Processing Twitter auth"

5. **Redirect to frontend**
   - Should land on `http://localhost:3000/auth/twitter/complete?code=tc_xxx`

6. **Exchange code for JWT**
   ```bash
   curl -X POST http://localhost:6111/auth/twitter/exchange \
     -H "Content-Type: application/json" \
     -d '{"code": "tc_xxx"}'
   ```

7. **Verify JWT works on backend**
   ```bash
   curl http://localhost:4132/api/on-demand/checkEligibility \
     -H "Authorization: Bearer <jwt_from_step_6>"
   ```

---

## Token Encryption (Required)

**Before storing `accessToken` and `refreshToken` to the database, encrypt them.** Both servers share `JAMIE_TO_AUTH_SERVER_HMAC_SECRET`, so use it as the encryption key.

```javascript
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const SECRET = process.env.JAMIE_TO_AUTH_SERVER_HMAC_SECRET;

function encrypt(text) {
  const key = crypto.createHash('sha256').update(SECRET).digest(); // 32 bytes
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encrypted) {
  const [ivHex, encryptedText] = encrypted.split(':');
  const key = crypto.createHash('sha256').update(SECRET).digest();
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
```

**Usage in `/internal/twitter/create-user`:**
```javascript
user.twitterTokens = {
  accessToken: encrypt(accessToken),
  refreshToken: encrypt(refreshToken),
  // ... rest unchanged
};
```

The backend will use the same `encrypt`/`decrypt` functions when reading tokens for posting.

---

## Security Considerations

1. **HMAC Secret**: Keep `JAMIE_TO_AUTH_SERVER_HMAC_SECRET` secure and identical on both servers.

2. **Temp Code Expiration**: Codes expire in 60 seconds and are single-use.

3. **Token Storage**: Consider encrypting `accessToken` and `refreshToken` at rest.

4. **Rate Limiting**: Consider rate limiting `/auth/twitter/exchange` to prevent brute-force.

5. **Network Security**: In production, `/internal/*` endpoints should only be accessible from the backend server (use firewall rules or private networking).

---

## Summary

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/internal/twitter/create-user` | POST | HMAC | Backend → Auth: Create user, get temp code |
| `/auth/twitter/exchange` | POST | None | Frontend → Auth: Exchange temp code for JWT |

| Schema Change | Field | Type |
|---------------|-------|------|
| `CASCDRUser` | `authProvider` | `{ provider, providerId, linkedAt }` |
| `CASCDRUser` | `twitterTokens` | `{ accessToken, refreshToken, expiresAt, twitterUsername, twitterId }` |

| Env Variable | Server | Purpose |
|--------------|--------|---------|
| `JAMIE_TO_AUTH_SERVER_HMAC_SECRET` | Both | Internal API authentication |
