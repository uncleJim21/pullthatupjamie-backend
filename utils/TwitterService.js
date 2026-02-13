const { TwitterApi } = require('twitter-api-v2');
const { 
    getAdminTwitterCredentials, 
    persistTwitterTokens 
} = require('./userTwitterTokens');

/**
 * TwitterService - Reusable Twitter posting functionality
 * 
 * Now uses User.twitterTokens (encrypted) instead of ProPodcastDetails.
 * Automatically migrates legacy tokens on first use.
 */
class TwitterService {
    constructor() {
        // Initialize with environment variables
        this.clientId = process.env.TWITTER_CLIENT_ID;
        this.clientSecret = process.env.TWITTER_CLIENT_SECRET;
        this.consumerKey = process.env.TWITTER_CONSUMER_KEY;
        this.consumerSecret = process.env.TWITTER_CONSUMER_SECRET;
    }

    /**
     * Upload media using OAuth 1.0a (required for media uploads)
     */
    async uploadMediaWithOAuth1a(buffer, contentType, oauth1Tokens) {
        console.log('Starting OAuth 1.0a media upload...', {
            totalBytes: buffer.length,
            contentType
        });

        try {
            // Check if we have OAuth 1.0a tokens
            if (!oauth1Tokens?.oauth1AccessToken || !oauth1Tokens?.oauth1AccessSecret) {
                throw new Error('OAuth 1.0a tokens not found. Please authorize media uploads first via /api/twitter/oauth1-auth');
            }

            // Create OAuth 1.0a client using proper OAuth 1.0a tokens
            const oauth1Client = new TwitterApi({
                appKey: this.consumerKey,
                appSecret: this.consumerSecret,
                accessToken: oauth1Tokens.oauth1AccessToken,
                accessSecret: oauth1Tokens.oauth1AccessSecret,
            });
            
            console.log('Uploading media with OAuth 1.0a...');
            
            // Use the built-in chunked upload method with OAuth 1.0a
            const mediaId = await oauth1Client.v1.uploadMedia(buffer, {
                mimeType: contentType,
                chunkLength: 5 * 1024 * 1024, // 5MB chunks
                target: 'tweet',
                additionalOwners: undefined,
                maxConcurrentUploads: 1,
                shared: false
            });
            
            console.log('OAuth 1.0a media upload successful, media ID:', mediaId);
            return mediaId;
        } catch (error) {
            console.error('OAuth 1.0a media upload error:', {
                message: error.message,
                code: error.code,
                data: error.data,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Post a tweet with optional media
     * 
     * Now uses encrypted tokens from User.twitterTokens.
     * Automatically migrates legacy tokens from ProPodcastDetails on first use.
     * 
     * @param {string} adminEmail - Admin email for token lookup
     * @param {Object} tweetData - Tweet data
     * @param {string} tweetData.text - Tweet text content
     * @param {string} [tweetData.mediaUrl] - Optional media URL to attach
     * @returns {Promise<Object>} Tweet result with success status and data
     */
    async postTweet(adminIdentity, { text, mediaUrl }) {
        try {
            if (!text) {
                throw new Error('Tweet text is required');
            }

            // Normalize identity (supports both string email and { userId, email } object)
            const identity = typeof adminIdentity === 'string' 
                ? { email: adminIdentity } 
                : adminIdentity;

            console.log(`📤 TwitterService.postTweet for:`, JSON.stringify(identity));

            // Get credentials (handles migration + decryption + refresh)
            const { user, accessToken, needsSave, oauth1Tokens } = await getAdminTwitterCredentials(identity);

            // Create Twitter client
            const client = new TwitterApi(accessToken);

            // Verify token validity
            console.log('Testing token validity...');
            const testUser = await client.v2.me();
            console.log('Token is valid for user:', testUser.data.username);

            let mediaIds = [];
            
            // Upload media to Twitter if provided
            if (mediaUrl) {
                try {
                    console.log('Downloading media from URL:', mediaUrl);
                    const response = await fetch(mediaUrl, {
                        headers: {
                            'Accept': '*/*',
                            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
                        }
                    });
                    
                    if (!response.ok) {
                        throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
                    }
                    
                    const contentType = response.headers.get('content-type') || 'video/mp4';
                    console.log('Media content type:', contentType);
                    
                    const arrayBuffer = await response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    console.log('Media buffer size:', buffer.length, 'bytes');
                    
                    console.log('Uploading media to Twitter using OAuth 1.0a...');
                    
                    // Use OAuth 1.0a for media uploads
                    const mediaId = await this.uploadMediaWithOAuth1a(buffer, contentType, oauth1Tokens);
                    mediaIds.push(mediaId);
                    
                    console.log('Media upload successful, media ID:', mediaId);
                } catch (error) {
                    console.error('Media upload error details:', {
                        message: error.message,
                        code: error.code,
                        data: error.data,
                        stack: error.stack
                    });
                    throw new Error(`Failed to upload media to Twitter: ${error.message}`);
                }
            }

            // Post the tweet with media if available
            const tweetPayload = { text };

            if (mediaIds.length > 0) {
                tweetPayload.media = {
                    media_ids: mediaIds
                };
            }

            console.log('Posting tweet with payload:', tweetPayload);
            const tweet = await client.v2.tweet(tweetPayload);

            // Persist tokens if they were refreshed
            if (needsSave) {
                await persistTwitterTokens(user);
                console.log('💾 Refreshed tokens persisted');
            }

            console.log('✅ Tweet posted successfully:', tweet.data.id);

            return {
                success: true,
                message: 'Tweet posted successfully',
                tweet: tweet.data
            };

        } catch (error) {
            console.error('Error posting tweet:', error);
            
            // Re-throw with structured error info for caller to handle
            const structuredError = new Error(error.message);
            structuredError.code = error.code;
            structuredError.requiresReauth = error.requiresReauth;
            structuredError.originalError = error.originalError;
            throw structuredError;
        }
    }

    /**
     * Execute operation with automatic token refresh on 401 errors
     * @param {Object|string} identity - Identity object { userId, email } or legacy email string
     * @param {Function} operation - Async function to execute, receives new access token on retry
     */
    async executeWithTokenRefresh(identity, operation) {
        // Normalize identity - support both object and legacy email string
        const normalizedIdentity = typeof identity === 'string' 
            ? { userId: null, email: identity }
            : identity;
        const { userId, email } = normalizedIdentity;
        const identifier = email || userId || 'unknown';
        
        try {
            // First attempt with current token
            return await operation();
        } catch (error) {
            // Check if it's an authentication/authorization error
            const isAuthError = error.code === 401 || 
                               error.status === 401 ||
                               error.message?.includes('401') ||
                               error.message?.includes('Unauthorized') ||
                               error.message?.includes('Invalid or expired');

            if (isAuthError) {
                console.log('Authentication error detected, attempting token refresh for:', identifier);
                
                try {
                    // Get current tokens using identity-based lookup
                    const { decryptToken } = require('./userTwitterTokens');
                    const creds = await getAdminTwitterCredentials(normalizedIdentity);
                    
                    if (!creds?.refreshToken) {
                        console.log('No refresh token available for token refresh');
                        throw new Error('REFRESH_TOKEN_UNAVAILABLE');
                    }

                    // Decrypt the refresh token
                    const decryptedRefreshToken = decryptToken(creds.refreshToken);

                    // Attempt token refresh
                    const newAccessToken = await this.refreshToken(normalizedIdentity, decryptedRefreshToken);
                    
                    // Retry the operation with refreshed token
                    console.log('Token refreshed successfully, retrying operation...');
                    return await operation(newAccessToken);
                    
                } catch (refreshError) {
                    console.error('Token refresh failed:', refreshError.message);
                    
                    // Throw a specific error that indicates re-authentication is needed
                    const authError = new Error('Twitter authentication has expired and could not be refreshed. Please re-authenticate.');
                    authError.code = 'TWITTER_AUTH_EXPIRED';
                    authError.requiresReauth = true;
                    throw authError;
                }
            }
            
            // Not an auth error, just re-throw
            throw error;
        }
    }

    /**
     * Refresh Twitter OAuth 2.0 token using stored refresh token
     * @param {Object} identity - Identity object { userId, email }
     * @param {string} currentRefreshToken - The current refresh token (decrypted)
     */
    async refreshToken(identity, currentRefreshToken) {
        const { userId, email } = identity;
        const identifier = email || userId || 'unknown';
        
        try {
            console.log('🔄 REFRESH ATTEMPT:', {
                userId,
                email,
                currentRefreshTokenLength: currentRefreshToken?.length,
                timestamp: new Date().toISOString()
            });
            
            const client = new TwitterApi({
                clientId: this.clientId,
                clientSecret: this.clientSecret,
            });

            // Use the refresh token to get a new access token
            const { accessToken, refreshToken, expiresIn } = await client.refreshOAuth2Token(currentRefreshToken);
            
            console.log('✅ REFRESH SUCCESS:', {
                identifier,
                newAccessTokenLength: accessToken?.length,
                newRefreshTokenLength: refreshToken?.length,
                expiresIn
            });
            
            // Update tokens in User.twitterTokens (the new canonical location)
            const { User } = require('../models/shared/UserSchema');
            const { encryptToken } = require('./userTwitterTokens');
            
            let dbUser = null;
            if (userId) {
                dbUser = await User.findById(userId);
            } else if (email) {
                dbUser = await User.findOne({ email });
            }
            
            if (dbUser) {
                // Preserve existing OAuth 1.0a tokens and metadata
                const existingTokens = dbUser.twitterTokens || {};
                dbUser.twitterTokens = {
                    ...existingTokens,
                    accessToken: encryptToken(accessToken),
                    refreshToken: encryptToken(refreshToken || currentRefreshToken),
                    expiresAt: new Date(Date.now() + (expiresIn * 1000))
                };
                await dbUser.save();
                
                console.log('💾 DATABASE UPDATE VERIFIED:', {
                    identifier,
                    updatedSuccessfully: true,
                    timestamp: new Date().toISOString()
                });
            } else {
                console.warn('⚠️ Could not find user to update tokens:', identifier);
            }

            console.log('Database updated with refreshed tokens');
            return accessToken;
            
        } catch (error) {
            console.error('Token refresh failed:', {
                message: error.message,
                code: error.code,
                data: error.data
            });
            throw error;
        }
    }
}

module.exports = TwitterService;


