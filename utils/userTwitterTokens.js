/**
 * User Twitter Token Utilities
 * 
 * Helper functions for managing encrypted Twitter OAuth tokens
 * stored in User.twitterTokens (for user sign-in flow).
 * 
 * This is separate from ProPodcastUtils which handles tokens
 * for podcast admin posting (stored in ProPodcastDetails).
 */

const crypto = require('crypto');
const { TwitterApi } = require('twitter-api-v2');
const { User } = require('../models/shared/UserSchema');
const { ProPodcastDetails } = require('../models/ProPodcastDetails');

// ============================================
// ENCRYPTION / DECRYPTION
// ============================================

/**
 * Encrypt a token with AES-256-CBC
 * Uses JAMIE_TO_AUTH_SERVER_HMAC_SECRET as the key
 * 
 * @param {string} text - Plain text token to encrypt
 * @returns {string} Encrypted token in format "iv:ciphertext"
 */
function encryptToken(text) {
  if (!text) return null;
  
  const SECRET = process.env.JAMIE_TO_AUTH_SERVER_HMAC_SECRET;
  if (!SECRET) {
    throw new Error('JAMIE_TO_AUTH_SERVER_HMAC_SECRET not configured');
  }
  
  const key = crypto.createHash('sha256').update(SECRET).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a token that was encrypted with AES-256-CBC
 * Uses JAMIE_TO_AUTH_SERVER_HMAC_SECRET as the key
 * 
 * @param {string} encrypted - Encrypted token in format "iv:ciphertext"
 * @returns {string} Decrypted plain text token
 */
function decryptToken(encrypted) {
  if (!encrypted || !encrypted.includes(':')) {
    // Not encrypted, return as-is (backwards compatibility)
    return encrypted;
  }
  
  const SECRET = process.env.JAMIE_TO_AUTH_SERVER_HMAC_SECRET;
  if (!SECRET) {
    throw new Error('JAMIE_TO_AUTH_SERVER_HMAC_SECRET not configured');
  }
  
  const [ivHex, encryptedText] = encrypted.split(':');
  const key = crypto.createHash('sha256').update(SECRET).digest();
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ============================================
// MIGRATION: ProPodcastDetails → User.twitterTokens
// ============================================

/**
 * Find a user by identity (supports multiple lookup methods)
 * 
 * @param {Object} identity - { userId, email }
 * @returns {Promise<User|null>}
 */
async function findUserByAdminIdentity(identity) {
  const { userId, email } = identity;
  
  if (userId) {
    const user = await User.findById(userId);
    if (user) return user;
  }
  
  if (email) {
    const user = await User.findOne({ email });
    if (user) return user;
  }
  
  return null;
}

/**
 * Find ProPodcastDetails by admin identity (supports both userId and email)
 * 
 * @param {Object} identity - { userId, email }
 * @returns {Promise<Object|null>}
 */
async function findPodcastByAdminIdentity(identity) {
  const { userId, email } = identity;
  
  const query = { $or: [] };
  if (userId) query.$or.push({ adminUserId: userId });
  if (email) query.$or.push({ adminEmail: email });
  
  if (query.$or.length === 0) return null;
  
  return ProPodcastDetails.findOne(query).lean();
}

/**
 * Migrate Twitter tokens from ProPodcastDetails to User.twitterTokens
 * This is a one-time migration that runs on first access.
 * 
 * @param {Object} identity - { userId, email } - Admin identity
 * @returns {Promise<Object|null>} The migrated user, or null if no migration needed
 */
async function migrateTokensFromProPodcast(identity) {
  const { userId, email } = identity;
  if (!userId && !email) return null;
  
  console.log(`🔄 Checking for token migration: userId=${userId}, email=${email}`);
  
  // 1. Find user
  const user = await findUserByAdminIdentity(identity);
  if (!user) {
    console.log(`   No user found for identity`);
    return null;
  }
  
  // 2. Check if user already has twitterTokens
  if (user.twitterTokens?.accessToken) {
    console.log(`   User already has twitterTokens, no migration needed`);
    return user;
  }
  
  // 3. Check ProPodcastDetails for legacy tokens
  const podcast = await findPodcastByAdminIdentity(identity);
  if (!podcast?.twitterTokens?.oauthToken) {
    console.log(`   No legacy tokens found in ProPodcastDetails`);
    return user;
  }
  
  console.log(`   📦 Found legacy tokens in ProPodcastDetails, migrating...`);
  
  // 4. Migrate tokens to User (encrypted)
  const legacyTokens = podcast.twitterTokens;
  
  user.twitterTokens = {
    accessToken: encryptToken(legacyTokens.oauthToken),
    refreshToken: legacyTokens.oauthTokenSecret ? encryptToken(legacyTokens.oauthTokenSecret) : null,
    expiresAt: legacyTokens.expiresAt ? new Date(legacyTokens.expiresAt) : null,
    twitterUsername: legacyTokens.twitterUsername,
    twitterId: legacyTokens.twitterId
  };
  
  // Also set up authProvider if not already set (for email-based users)
  if (!user.authProvider?.provider && email) {
    user.authProvider = {
      provider: 'email',
      providerId: email,
      linkedAt: new Date()
    };
  }
  
  await user.save();
  console.log(`   ✅ Migrated tokens to User.twitterTokens (encrypted)`);
  
  // 5. Clear OAuth 2.0 tokens from ProPodcastDetails, but KEEP OAuth 1.0a tokens (for media uploads)
  // Use same query that found the podcast
  const updateQuery = { $or: [] };
  if (userId) updateQuery.$or.push({ adminUserId: userId });
  if (email) updateQuery.$or.push({ adminEmail: email });
  
  await ProPodcastDetails.findOneAndUpdate(
    updateQuery,
    { 
      $unset: { 
        'twitterTokens.oauthToken': 1,
        'twitterTokens.oauthTokenSecret': 1,
        'twitterTokens.expiresAt': 1,
        'twitterTokens.twitterId': 1,
        'twitterTokens.twitterUsername': 1
      }
    }
  );
  console.log(`   🗑️ Cleared OAuth 2.0 tokens from ProPodcastDetails (OAuth 1.0a preserved for media)`);
  
  return user;
}

/**
 * Get Twitter credentials for an admin (with auto-migration)
 * This is the main entry point for the admin/podcast posting flow.
 * 
 * Supports both:
 * - String email (legacy): getAdminTwitterCredentials('admin@example.com')
 * - Identity object: getAdminTwitterCredentials({ userId: '...', email: '...' })
 * 
 * @param {string|Object} adminIdentity - Admin email (string) or identity object { userId, email }
 * @returns {Promise<Object>} { user, accessToken, refreshToken, needsSave, oauth1Tokens }
 */
async function getAdminTwitterCredentials(adminIdentity) {
  // Normalize to identity object
  const identity = typeof adminIdentity === 'string' 
    ? { email: adminIdentity } 
    : adminIdentity;
  
  // First, ensure any legacy tokens are migrated
  let user = await migrateTokensFromProPodcast(identity);
  
  // If no user was found/returned, try finding by identity
  if (!user) {
    user = await findUserByAdminIdentity(identity);
  }
  
  if (!user) {
    const error = new Error(`No user found for admin identity: ${JSON.stringify(identity)}`);
    error.code = 'USER_NOT_FOUND';
    throw error;
  }
  
  // Check for Twitter tokens
  if (!user.twitterTokens?.accessToken) {
    const error = new Error('No Twitter tokens found. Please connect your Twitter account.');
    error.code = 'TWITTER_NOT_CONNECTED';
    error.requiresReauth = true;
    throw error;
  }
  
  // Decrypt tokens
  let accessToken, refreshToken;
  try {
    accessToken = decryptToken(user.twitterTokens.accessToken);
    refreshToken = user.twitterTokens.refreshToken 
      ? decryptToken(user.twitterTokens.refreshToken) 
      : null;
  } catch (decryptError) {
    const error = new Error('Failed to decrypt Twitter tokens.');
    error.code = 'TOKEN_DECRYPT_FAILED';
    error.originalError = decryptError.message;
    throw error;
  }
  
  // Check if token is expired and needs refresh
  let needsSave = false;
  
  if (user.twitterTokens.expiresAt && new Date() > user.twitterTokens.expiresAt) {
    console.log('🔄 Admin Twitter token expired, attempting refresh...');
    
    if (!refreshToken) {
      const error = new Error('Access token expired and no refresh token available.');
      error.code = 'TWITTER_AUTH_EXPIRED';
      error.requiresReauth = true;
      throw error;
    }
    
    try {
      const refreshClient = new TwitterApi({
        clientId: process.env.TWITTER_CLIENT_ID,
        clientSecret: process.env.TWITTER_CLIENT_SECRET,
      });
      
      const { 
        accessToken: newAccessToken, 
        refreshToken: newRefreshToken, 
        expiresIn 
      } = await refreshClient.refreshOAuth2Token(refreshToken);
      
      accessToken = newAccessToken;
      refreshToken = newRefreshToken || refreshToken;
      
      // Update user with new encrypted tokens
      user.twitterTokens.accessToken = encryptToken(newAccessToken);
      user.twitterTokens.refreshToken = encryptToken(refreshToken);
      user.twitterTokens.expiresAt = new Date(Date.now() + (expiresIn * 1000));
      
      needsSave = true;
      console.log('✅ Admin Twitter token refreshed');
      
    } catch (refreshError) {
      console.error('❌ Admin token refresh failed:', refreshError.message);
      const error = new Error('Could not refresh expired token. Please re-authenticate.');
      error.code = 'TOKEN_REFRESH_FAILED';
      error.requiresReauth = true;
      throw error;
    }
  }
  
  // Check for OAuth 1.0a tokens (for media uploads)
  // First check User.twitterTokens (new location), then fallback to ProPodcastDetails
  let oauth1Tokens = null;
  
  if (user.twitterTokens?.oauth1AccessToken && user.twitterTokens?.oauth1AccessSecret) {
    // OAuth 1.0a tokens are in User (encrypted)
    try {
      oauth1Tokens = {
        oauth1AccessToken: decryptToken(user.twitterTokens.oauth1AccessToken),
        oauth1AccessSecret: decryptToken(user.twitterTokens.oauth1AccessSecret)
      };
      console.log('📷 Found OAuth 1.0a tokens in User.twitterTokens');
    } catch (e) {
      console.error('Failed to decrypt OAuth 1.0a tokens:', e.message);
    }
  } else {
    // Fallback: check ProPodcastDetails (legacy location)
    const podcast = await findPodcastByAdminIdentity(identity);
    if (podcast?.twitterTokens?.oauth1AccessToken && podcast?.twitterTokens?.oauth1AccessSecret) {
      oauth1Tokens = {
        oauth1AccessToken: podcast.twitterTokens.oauth1AccessToken,
        oauth1AccessSecret: podcast.twitterTokens.oauth1AccessSecret
      };
      console.log('📷 Found OAuth 1.0a tokens in ProPodcastDetails (legacy)');
    } else {
      console.log('⚠️ No OAuth 1.0a tokens found - media uploads will require authorization');
    }
  }
  
  return {
    user,
    accessToken,
    refreshToken,
    needsSave,
    oauth1Tokens
  };
}

// ============================================
// USER LOOKUP
// ============================================

/**
 * Find a user by various identifiers from JWT payload
 * 
 * @param {Object} identity - JWT payload or similar object
 * @param {string} [identity.email] - User's email
 * @param {string} [identity.provider] - Auth provider (twitter, nostr, etc.)
 * @param {string} [identity.sub] - Provider-specific user ID
 * @param {string} [identity.providerId] - Alternative to sub
 * @returns {Promise<Object|null>} User document or null
 */
async function findUserByIdentity(identity) {
  if (identity.email) {
    return User.findOne({ email: identity.email });
  } else if (identity.provider && (identity.sub || identity.providerId)) {
    return User.findOne({
      'authProvider.provider': identity.provider,
      'authProvider.providerId': identity.sub || identity.providerId
    });
  }
  return null;
}

// ============================================
// TOKEN PREPARATION (Before tweeting)
// ============================================

/**
 * Prepare Twitter credentials for posting
 * Fetches user, decrypts tokens, handles refresh if expired
 * 
 * @param {Object} identity - JWT payload with user identification
 * @returns {Promise<Object>} { user, accessToken, refreshToken, needsSave: boolean }
 * @throws {Error} If user not found, no tokens, or refresh fails
 */
async function prepareTwitterCredentials(identity) {
  // 1. Find the user
  const user = await findUserByIdentity(identity);
  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }
  
  // 2. Check for Twitter tokens
  if (!user.twitterTokens?.accessToken) {
    const error = new Error('User does not have Twitter tokens. Please sign in via Twitter.');
    error.code = 'TWITTER_NOT_CONNECTED';
    error.requiresReauth = true;
    throw error;
  }
  
  // 3. Decrypt tokens
  let accessToken, refreshToken;
  try {
    accessToken = decryptToken(user.twitterTokens.accessToken);
    refreshToken = user.twitterTokens.refreshToken 
      ? decryptToken(user.twitterTokens.refreshToken) 
      : null;
  } catch (decryptError) {
    const error = new Error('Failed to decrypt Twitter tokens. Check JAMIE_TO_AUTH_SERVER_HMAC_SECRET.');
    error.code = 'TOKEN_DECRYPT_FAILED';
    error.originalError = decryptError.message;
    throw error;
  }
  
  // 4. Check if token is expired and needs refresh
  let needsSave = false;
  
  if (user.twitterTokens.expiresAt && new Date() > user.twitterTokens.expiresAt) {
    console.log('🔄 Twitter access token expired, attempting refresh...');
    
    if (!refreshToken) {
      const error = new Error('Access token expired and no refresh token available. Please re-authenticate.');
      error.code = 'TWITTER_AUTH_EXPIRED';
      error.requiresReauth = true;
      throw error;
    }
    
    try {
      const refreshClient = new TwitterApi({
        clientId: process.env.TWITTER_CLIENT_ID,
        clientSecret: process.env.TWITTER_CLIENT_SECRET,
      });
      
      const { 
        accessToken: newAccessToken, 
        refreshToken: newRefreshToken, 
        expiresIn 
      } = await refreshClient.refreshOAuth2Token(refreshToken);
      
      // Update with new tokens
      accessToken = newAccessToken;
      refreshToken = newRefreshToken || refreshToken;
      
      // Update user object (caller should save)
      user.twitterTokens.accessToken = encryptToken(newAccessToken);
      user.twitterTokens.refreshToken = encryptToken(refreshToken);
      user.twitterTokens.expiresAt = new Date(Date.now() + (expiresIn * 1000));
      
      needsSave = true;
      console.log('✅ Twitter token refreshed successfully');
      
    } catch (refreshError) {
      console.error('❌ Twitter token refresh failed:', refreshError.message);
      const error = new Error('Could not refresh expired token. Please re-authenticate.');
      error.code = 'TOKEN_REFRESH_FAILED';
      error.requiresReauth = true;
      error.originalError = refreshError.message;
      throw error;
    }
  }
  
  // 5. Also retrieve OAuth 1.0a tokens if available (for media uploads)
  let oauth1Tokens = null;
  if (user.twitterTokens?.oauth1AccessToken && user.twitterTokens?.oauth1AccessSecret) {
    try {
      oauth1Tokens = {
        oauth1AccessToken: decryptToken(user.twitterTokens.oauth1AccessToken),
        oauth1AccessSecret: decryptToken(user.twitterTokens.oauth1AccessSecret)
      };
      console.log('📷 OAuth 1.0a tokens available for media uploads');
    } catch (e) {
      console.warn('⚠️ Failed to decrypt OAuth 1.0a tokens:', e.message);
    }
  } else {
    console.log('ℹ️ No OAuth 1.0a tokens - media uploads will require authorization');
  }
  
  return {
    user,
    accessToken,
    refreshToken,
    needsSave,
    oauth1Tokens
  };
}

// ============================================
// TOKEN PERSISTENCE (After tweeting)
// ============================================

/**
 * Persist Twitter tokens after a successful operation
 * Call this if prepareTwitterCredentials returned needsSave: true
 * 
 * @param {Object} user - Mongoose user document (already updated by prepareTwitterCredentials)
 * @returns {Promise<void>}
 */
async function persistTwitterTokens(user) {
  await user.save();
  console.log('💾 Twitter tokens persisted for user:', user._id);
}

/**
 * Update and persist new Twitter tokens for a user
 * Use this when you have fresh tokens (e.g., after OAuth callback)
 * 
 * @param {Object} user - Mongoose user document
 * @param {Object} tokens - Token data
 * @param {string} tokens.accessToken - Plain text access token
 * @param {string} tokens.refreshToken - Plain text refresh token
 * @param {number} tokens.expiresIn - Seconds until expiration
 * @param {string} [tokens.twitterUsername] - Twitter handle
 * @param {string} [tokens.twitterId] - Twitter user ID
 * @returns {Promise<void>}
 */
async function updateUserTwitterTokens(user, tokens) {
  user.twitterTokens = {
    accessToken: encryptToken(tokens.accessToken),
    refreshToken: encryptToken(tokens.refreshToken),
    expiresAt: new Date(Date.now() + (tokens.expiresIn * 1000)),
    twitterUsername: tokens.twitterUsername || user.twitterTokens?.twitterUsername,
    twitterId: tokens.twitterId || user.twitterTokens?.twitterId
  };
  
  await user.save();
  console.log('💾 Twitter tokens updated for user:', user._id);
}

// ============================================
// CONVENIENCE: Full tweet flow
// ============================================

/**
 * Post a tweet using user's encrypted Twitter credentials
 * Handles: user lookup, decryption, refresh, posting, and persistence
 * 
 * @param {Object} identity - JWT payload with user identification
 * @param {string} text - Tweet text
 * @returns {Promise<Object>} { success, tweet, postedAs }
 */
async function postTweetAsUser(identity, text) {
  // Prepare credentials (handles refresh if needed)
  const { user, accessToken, needsSave } = await prepareTwitterCredentials(identity);
  
  // Create Twitter client
  const twitterClient = new TwitterApi(accessToken);
  
  // Verify and post
  const me = await twitterClient.v2.me();
  const tweet = await twitterClient.v2.tweet({ text });
  
  // Persist tokens if they were refreshed
  if (needsSave) {
    await persistTwitterTokens(user);
  }
  
  return {
    success: true,
    tweet: tweet.data,
    postedAs: {
      username: me.data.username,
      id: me.data.id
    }
  };
}

module.exports = {
  // Encryption
  encryptToken,
  decryptToken,
  
  // User lookup
  findUserByIdentity,
  
  // Token management
  prepareTwitterCredentials,
  persistTwitterTokens,
  updateUserTwitterTokens,
  
  // Migration & Admin flow
  migrateTokensFromProPodcast,
  getAdminTwitterCredentials,
  
  // Convenience
  postTweetAsUser
};
