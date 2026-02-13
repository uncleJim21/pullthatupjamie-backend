# Auth Server Migration: Provider-Agnostic Architecture

> **Purpose:** Refactor cascdr-backend (auth server) to support multiple auth providers (email, Google, Twitter, Nostr) with a unified, provider-agnostic architecture.

---

## Architecture Overview

### Current (Email-Centric)
```
/signup  → email + password → User { email, password }
/signin  → email + password → JWT { email }
```

### Target (Provider-Agnostic)
```
/auth/signup   → { provider, credentials } → User { authProvider: { provider, providerId }, email? }
/auth/signin   → { provider, credentials } → JWT { sub: providerId, provider, email? }
```

**Key Shift:** `providerId` is the primary identifier, `email` is optional metadata.

---

## Tasks

### 1. Create Shared Schema File

Create `models/shared/UserSchema.js`:

```javascript
/**
 * UNIFIED USER SCHEMA
 * 
 * Sync between: cascdr-backend, pullthatupjamie-backend
 * Collection: 'users'
 */

const mongoose = require('mongoose');

const AuthProviderSchema = new mongoose.Schema({
  provider: {
    type: String,
    required: true,
    enum: ['email', 'google', 'twitter', 'nostr']
  },
  providerId: {
    type: String,
    required: true
    // email: the email address
    // google: Google user ID
    // twitter: Twitter user ID  
    // nostr: npub
  },
  linkedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const PinnedMentionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  label: { type: String },
  twitter_profile: { type: Object },
  nostr_profile: { type: Object, default: null },
  is_cross_platform: { type: Boolean, default: false },
  source_mapping_id: { type: String, default: null },
  mapping_confidence: { type: Number, default: null },
  usage_count: { type: Number, default: 0 },
  is_adopted: { type: Boolean, default: false }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  // OPTIONAL - not all providers give email (e.g., Nostr)
  email: {
    type: String,
    sparse: true,
    unique: true,
    index: true
  },
  
  // OPTIONAL - only for email provider
  password: {
    type: String
  },
  
  // REQUIRED - primary identity
  authProvider: {
    type: AuthProviderSchema,
    required: true  // Now required for all users
  },
  
  // Square/Subscription
  squareCustomerId: { type: String, default: null },
  subscriptionId: { type: String, default: null },
  subscriptionType: {
    type: String,
    enum: ['amber', 'jamie-pro', null],
    default: null
  },
  
  // Backend-managed (auth server can ignore)
  app_preferences: {
    type: new mongoose.Schema({
      data: { type: mongoose.Schema.Types.Mixed, default: {} },
      schemaVersion: { type: Number, default: 20240320001 }
    }, { _id: false }),
    select: false,
    default: () => ({ data: {}, schemaVersion: 20240320001 })
  },
  mention_preferences: {
    type: new mongoose.Schema({
      pinned_mentions: { type: [PinnedMentionSchema], default: [] }
    }, { _id: false }),
    select: false,
    default: () => ({ pinned_mentions: [] })
  }
}, {
  timestamps: false,
  versionKey: '__v'
});

// Primary lookup: by provider + providerId
UserSchema.index(
  { 'authProvider.provider': 1, 'authProvider.providerId': 1 },
  { unique: true }
);

UserSchema.statics.findByAuthProvider = function(provider, providerId) {
  return this.findOne({
    'authProvider.provider': provider,
    'authProvider.providerId': providerId
  });
};

UserSchema.statics.findByEmail = function(email) {
  return this.findOne({ email });
};

UserSchema.statics.findByProviderId = function(providerId) {
  return this.findOne({ 'authProvider.providerId': providerId });
};

const User = mongoose.model('User', UserSchema);

module.exports = { User, UserSchema, AuthProviderSchema };
```

---

### 2. Create Provider Handlers

Create `auth/providers.js`:

```javascript
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const crypto = require('crypto');

// Store challenges temporarily (use Redis in production)
const nostrChallenges = new Map();

/**
 * Provider handlers - each validates credentials and returns normalized identity
 * 
 * @returns {{ providerId: string, email?: string, metadata?: object }}
 */

const providers = {
  
  // ═══════════════════════════════════════════════════════════
  // EMAIL PROVIDER
  // ═══════════════════════════════════════════════════════════
  email: {
    async validateSignup(credentials, existingUser = null) {
      const { email, password } = credentials;
      
      if (!email || !password) {
        throw new Error('Email and password required');
      }
      
      if (existingUser) {
        throw new Error('User already exists');
      }
      
      const saltRounds = 12;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      
      return {
        providerId: email,
        email: email,
        password: hashedPassword  // Only email provider has password
      };
    },
    
    async validateSignin(credentials, existingUser) {
      const { email, password } = credentials;
      
      if (!email || !password) {
        throw new Error('Email and password required');
      }
      
      if (!existingUser) {
        throw new Error('User not found');
      }
      
      const isMatch = await bcrypt.compare(password, existingUser.password);
      if (!isMatch) {
        throw new Error('Invalid password');
      }
      
      return {
        providerId: email,
        email: email
      };
    }
  },
  
  // ═══════════════════════════════════════════════════════════
  // GOOGLE PROVIDER
  // ═══════════════════════════════════════════════════════════
  google: {
    client: null,
    
    getClient() {
      if (!this.client) {
        this.client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
      }
      return this.client;
    },
    
    async validateSignup(credentials, existingUser = null) {
      return this.validateSignin(credentials, existingUser);
    },
    
    async validateSignin(credentials, existingUser = null) {
      const { idToken } = credentials;
      
      if (!idToken) {
        throw new Error('Google ID token required');
      }
      
      const ticket = await this.getClient().verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID
      });
      
      const payload = ticket.getPayload();
      const googleUserId = payload['sub'];
      const email = payload['email'];
      
      return {
        providerId: googleUserId,
        email: email,
        metadata: {
          name: payload['name'],
          picture: payload['picture']
        }
      };
    }
  },
  
  // ═══════════════════════════════════════════════════════════
  // TWITTER/X PROVIDER
  // ═══════════════════════════════════════════════════════════
  twitter: {
    async validateSignup(credentials, existingUser = null) {
      return this.validateSignin(credentials, existingUser);
    },
    
    async validateSignin(credentials, existingUser = null) {
      const { accessToken, accessSecret } = credentials;
      
      if (!accessToken || !accessSecret) {
        throw new Error('Twitter access token and secret required');
      }
      
      // Verify with Twitter API
      const Twitter = require('twitter-api-v2').default;
      const client = new Twitter({
        appKey: process.env.TWITTER_API_KEY,
        appSecret: process.env.TWITTER_API_SECRET,
        accessToken: accessToken,
        accessSecret: accessSecret
      });
      
      const { data: twitterUser } = await client.v2.me({ 
        'user.fields': ['id', 'username', 'name', 'profile_image_url'] 
      });
      
      return {
        providerId: twitterUser.id,
        email: null,  // Twitter doesn't provide email by default
        metadata: {
          username: twitterUser.username,
          name: twitterUser.name,
          picture: twitterUser.profile_image_url
        }
      };
    }
  },
  
  // ═══════════════════════════════════════════════════════════
  // NOSTR PROVIDER (NIP-07)
  // ═══════════════════════════════════════════════════════════
  nostr: {
    generateChallenge() {
      const challenge = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
      nostrChallenges.set(challenge, expiresAt);
      return challenge;
    },
    
    async validateSignup(credentials, existingUser = null) {
      return this.validateSignin(credentials, existingUser);
    },
    
    async validateSignin(credentials, existingUser = null) {
      const { npub, signature, challenge } = credentials;
      
      if (!npub || !signature || !challenge) {
        throw new Error('Nostr npub, signature, and challenge required');
      }
      
      // Verify challenge exists and hasn't expired
      const expiresAt = nostrChallenges.get(challenge);
      if (!expiresAt || Date.now() > expiresAt) {
        nostrChallenges.delete(challenge);
        throw new Error('Challenge expired or invalid');
      }
      nostrChallenges.delete(challenge);
      
      // Verify signature (using nostr-tools)
      const { nip19, verifySignature } = require('nostr-tools');
      
      // Decode npub to get pubkey
      const { type, data: pubkey } = nip19.decode(npub);
      if (type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      
      // Verify the signature matches the challenge
      // Note: Frontend should sign the challenge as a Nostr event
      const isValid = verifySignature({
        id: challenge,
        pubkey: pubkey,
        sig: signature,
        kind: 22242, // NIP-42 auth event kind
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: challenge
      });
      
      if (!isValid) {
        throw new Error('Invalid Nostr signature');
      }
      
      return {
        providerId: npub,
        email: null,  // Nostr users don't have email
        metadata: {
          pubkey: pubkey
        }
      };
    }
  }
};

module.exports = { providers, nostrChallenges };
```

---

### 3. Create Unified Auth Routes

Create `auth/routes.js`:

```javascript
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { providers } = require('./providers');
const { createSquareCustomer } = require('../square_apis/SquareCustomersAPI');

// Get User model (use shared schema)
const User = require('../models/shared/UserSchema').User;

/**
 * POST /auth/signup
 * 
 * Body: {
 *   provider: 'email' | 'google' | 'twitter' | 'nostr',
 *   credentials: { ... provider-specific ... }
 * }
 */
router.post('/signup', async (req, res) => {
  try {
    const { provider, credentials } = req.body;
    
    if (!provider || !credentials) {
      return res.status(400).json({ error: 'Provider and credentials required' });
    }
    
    if (!providers[provider]) {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }
    
    // Validate credentials with provider handler
    const identity = await providers[provider].validateSignup(credentials);
    
    // Check if user already exists
    const existingUser = await User.findByAuthProvider(provider, identity.providerId);
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists with this provider' });
    }
    
    // If provider gives email, check that email isn't taken by another provider
    if (identity.email) {
      const emailUser = await User.findByEmail(identity.email);
      if (emailUser) {
        return res.status(409).json({ 
          error: 'Email already registered with different provider' 
        });
      }
    }
    
    // Create Square customer if we have email
    let squareCustomerId = null;
    if (identity.email) {
      try {
        squareCustomerId = await createSquareCustomer(identity.email);
      } catch (e) {
        console.warn('[AUTH] Failed to create Square customer:', e.message);
      }
    }
    
    // Create user
    const user = new User({
      email: identity.email || null,
      password: identity.password || null,  // Only set for email provider
      authProvider: {
        provider: provider,
        providerId: identity.providerId,
        linkedAt: new Date()
      },
      squareCustomerId: squareCustomerId
    });
    
    await user.save();
    console.log(`[AUTH] Created user via ${provider}: ${identity.providerId}`);
    
    // Issue JWT
    const token = jwt.sign(
      {
        sub: identity.providerId,
        provider: provider,
        email: identity.email || null
      },
      process.env.CASCDR_AUTH_SECRET,
      { expiresIn: '365d' }
    );
    
    res.status(201).json({
      message: 'User created successfully',
      token,
      subscriptionValid: false,
      subscriptionType: null
    });
    
  } catch (error) {
    console.error('[AUTH] Signup error:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /auth/signin
 * 
 * Body: {
 *   provider: 'email' | 'google' | 'twitter' | 'nostr',
 *   credentials: { ... provider-specific ... }
 * }
 */
router.post('/signin', async (req, res) => {
  try {
    const { provider, credentials } = req.body;
    
    if (!provider || !credentials) {
      return res.status(400).json({ error: 'Provider and credentials required' });
    }
    
    if (!providers[provider]) {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }
    
    // For email provider, we need to find user first to check password
    let existingUser = null;
    if (provider === 'email' && credentials.email) {
      existingUser = await User.findByAuthProvider('email', credentials.email);
    }
    
    // Validate credentials with provider handler
    const identity = await providers[provider].validateSignin(credentials, existingUser);
    
    // Find user by provider
    let user = await User.findByAuthProvider(provider, identity.providerId);
    
    // For OAuth providers: auto-create user on first signin
    if (!user && provider !== 'email') {
      // Check email conflict
      if (identity.email) {
        const emailUser = await User.findByEmail(identity.email);
        if (emailUser) {
          return res.status(409).json({ 
            error: 'Email already registered with different provider' 
          });
        }
      }
      
      // Auto-create
      let squareCustomerId = null;
      if (identity.email) {
        try {
          squareCustomerId = await createSquareCustomer(identity.email);
        } catch (e) {
          console.warn('[AUTH] Failed to create Square customer:', e.message);
        }
      }
      
      user = new User({
        email: identity.email || null,
        authProvider: {
          provider: provider,
          providerId: identity.providerId,
          linkedAt: new Date()
        },
        squareCustomerId: squareCustomerId
      });
      
      await user.save();
      console.log(`[AUTH] Auto-created user via ${provider}: ${identity.providerId}`);
    }
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    // Check subscription status
    const { checkSubscriptionStatus } = require('../square_apis/SquareCustomersAPI');
    let subscriptionStatus = { isValid: false, type: null };
    if (user.subscriptionId) {
      subscriptionStatus = await checkSubscriptionStatus(
        user.subscriptionId, 
        user.subscriptionType
      );
    }
    
    // Issue JWT
    const token = jwt.sign(
      {
        sub: identity.providerId,
        provider: provider,
        email: identity.email || user.email || null
      },
      process.env.CASCDR_AUTH_SECRET,
      { expiresIn: '365d' }
    );
    
    console.log(`[AUTH] Signin via ${provider}: ${identity.providerId}`);
    
    res.status(200).json({
      message: 'Signed in successfully',
      token,
      subscriptionValid: subscriptionStatus.isValid,
      subscriptionType: subscriptionStatus.type
    });
    
  } catch (error) {
    console.error('[AUTH] Signin error:', error);
    res.status(401).json({ error: error.message });
  }
});

/**
 * GET /auth/nostr/challenge
 * 
 * Returns a challenge for Nostr NIP-07 authentication
 */
router.get('/nostr/challenge', (req, res) => {
  const challenge = providers.nostr.generateChallenge();
  res.json({ challenge });
});

module.exports = router;
```

---

### 4. Update Main Server

In `server.js`:

```javascript
// Add new auth routes
const authRoutes = require('./auth/routes');
app.use('/auth', authRoutes);

// Keep legacy routes for backwards compatibility (deprecate later)
// app.post('/signup', ...);  // Keep working but log deprecation warning
// app.post('/signin', ...);  // Keep working but log deprecation warning
```

---

### 5. Migrate Existing Users (One-Time Script)

Create `scripts/migrate-users-to-auth-provider.js`:

```javascript
/**
 * Migration script: Add authProvider to existing users
 * 
 * Run once after deploying new schema:
 * node scripts/migrate-users-to-auth-provider.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../models/shared/UserSchema');

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');
  
  // Find users without authProvider
  const usersToMigrate = await User.find({ 
    authProvider: { $exists: false } 
  }).select('email');
  
  console.log(`Found ${usersToMigrate.length} users to migrate`);
  
  let migrated = 0;
  let failed = 0;
  
  for (const user of usersToMigrate) {
    try {
      await User.updateOne(
        { _id: user._id },
        { 
          $set: { 
            authProvider: {
              provider: 'email',
              providerId: user.email,
              linkedAt: new Date()
            }
          }
        }
      );
      migrated++;
      if (migrated % 100 === 0) {
        console.log(`Migrated ${migrated}/${usersToMigrate.length}`);
      }
    } catch (e) {
      console.error(`Failed to migrate user ${user.email}:`, e.message);
      failed++;
    }
  }
  
  console.log(`Migration complete: ${migrated} migrated, ${failed} failed`);
  await mongoose.disconnect();
}

migrate().catch(console.error);
```

---

### 6. Update JWT Validation on Backend

The backend (pullthatupjamie-backend) needs to handle the new JWT structure:

**Old JWT payload:**
```json
{ "email": "user@example.com" }
```

**New JWT payload:**
```json
{ "sub": "user@example.com", "provider": "email", "email": "user@example.com" }
// or for Nostr:
{ "sub": "npub1abc...", "provider": "nostr", "email": null }
```

Backend should look up user by:
1. First try: `User.findByAuthProvider(payload.provider, payload.sub)`
2. Fallback (legacy): `User.findByEmail(payload.email)` if `payload.sub` doesn't exist

---

## API Reference

### POST /auth/signup

**Email:**
```json
{
  "provider": "email",
  "credentials": {
    "email": "user@example.com",
    "password": "secret123"
  }
}
```

**Google:**
```json
{
  "provider": "google",
  "credentials": {
    "idToken": "eyJhbGciOiJSUzI1NiIs..."
  }
}
```

**Twitter:**
```json
{
  "provider": "twitter",
  "credentials": {
    "accessToken": "...",
    "accessSecret": "..."
  }
}
```

**Nostr:**
```json
{
  "provider": "nostr",
  "credentials": {
    "npub": "npub1abc...",
    "signature": "...",
    "challenge": "..."
  }
}
```

### POST /auth/signin

Same body structure as signup.

### GET /auth/nostr/challenge

Returns:
```json
{ "challenge": "abc123..." }
```

---

## Environment Variables

```env
# Existing
MONGO_URI=...
CASCDR_AUTH_SECRET=...

# New for OAuth
GOOGLE_CLIENT_ID=...
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
```

---

## Testing Checklist

- [ ] Email signup creates user with `authProvider.provider = 'email'`
- [ ] Email signin works for new and migrated users
- [ ] Google signin creates/finds user correctly
- [ ] Twitter signin creates/finds user correctly
- [ ] Nostr challenge endpoint works
- [ ] Nostr signin creates/finds user correctly
- [ ] JWT contains `sub`, `provider`, `email` fields
- [ ] Email conflict between providers is rejected
- [ ] Migration script works on existing users
- [ ] Legacy `/signup` and `/signin` still work (with deprecation warning)
