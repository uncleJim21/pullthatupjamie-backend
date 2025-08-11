const { TwitterApi } = require('twitter-api-v2');
const { updateTwitterTokens, getTwitterTokens } = require('./ProPodcastUtils');

/**
 * TwitterService - Reusable Twitter posting functionality
 * Extracted from twitterRoutes.js for use by both API endpoints and scheduled posts
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
     * Refresh Twitter OAuth 2.0 token using stored refresh token
     */
    async refreshTwitterToken(adminEmail, currentRefreshToken) {
        try {
            console.log('🔄 REFRESH ATTEMPT:', {
                adminEmail,
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
                adminEmail,
                newAccessTokenLength: accessToken?.length,
                newRefreshTokenLength: refreshToken?.length,
                expiresIn
            });
            
            // Get existing tokens to preserve OAuth 1.0a tokens
            const existingTokens = await getTwitterTokens(adminEmail);
            
            // Update database with new OAuth 2.0 tokens while preserving OAuth 1.0a tokens
            await updateTwitterTokens(adminEmail, {
                ...existingTokens, // Keep existing OAuth 1.0a tokens
                oauthToken: accessToken,
                oauthTokenSecret: refreshToken || currentRefreshToken, // Use new refresh token if provided
                expiresAt: Date.now() + (expiresIn * 1000) // Calculate new expiration
            });

            // Ensure database update is complete by reading it back
            const updatedTokens = await getTwitterTokens(adminEmail);
            console.log('💾 DATABASE UPDATE VERIFIED:', {
                adminEmail,
                updatedAccessTokenMatches: updatedTokens?.oauthToken === accessToken,
                timestamp: new Date().toISOString()
            });

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

    /**
     * Execute operation with automatic token refresh on 401 errors
     */
    async executeWithTokenRefresh(adminEmail, operation) {
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
                console.log('Authentication error detected, attempting token refresh...');
                
                try {
                    // Get current tokens
                    const tokens = await getTwitterTokens(adminEmail);
                    if (!tokens?.oauthTokenSecret) {
                        console.log('No refresh token available for token refresh');
                        throw new Error('REFRESH_TOKEN_UNAVAILABLE');
                    }

                    // Attempt token refresh
                    const newAccessToken = await this.refreshTwitterToken(adminEmail, tokens.oauthTokenSecret);
                    
                    // Retry the operation with refreshed token
                    console.log('Token refreshed successfully, retrying operation...');
                    return await operation(newAccessToken);
                    
                } catch (refreshError) {
                    console.error('Token refresh failed:', refreshError.message);
                    
                    // Throw a specific error that indicates re-authentication is needed
                    const authError = new Error('Twitter authentication has expired and could not be refreshed. Please re-authenticate.');
                    authError.code = 'TWITTER_AUTH_EXPIRED';
                    authError.requiresReauth = true;
                    authError.originalError = error.message;
                    throw authError;
                }
            }
            
            // If it's not an auth error, just throw the original error
            throw error;
        }
    }

    /**
     * Upload media using OAuth 1.0a (required for media uploads)
     */
    async uploadMediaWithOAuth1a(buffer, contentType, tokens) {
        console.log('Starting OAuth 1.0a media upload...', {
            totalBytes: buffer.length,
            contentType
        });

        try {
            // Check if we have OAuth 1.0a tokens
            if (!tokens.oauth1AccessToken || !tokens.oauth1AccessSecret) {
                throw new Error('OAuth 1.0a tokens not found. Please authorize media uploads first via /api/twitter/oauth1-auth');
            }

            // Create OAuth 1.0a client using proper OAuth 1.0a tokens
            const oauth1Client = new TwitterApi({
                appKey: this.consumerKey,
                appSecret: this.consumerSecret,
                accessToken: tokens.oauth1AccessToken,    // Real OAuth 1.0a access token
                accessSecret: tokens.oauth1AccessSecret,  // Real OAuth 1.0a access secret
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
     * Core business logic extracted from /api/twitter/tweet endpoint
     * 
     * @param {string} adminEmail - Admin email for token lookup
     * @param {Object} tweetData - Tweet data
     * @param {string} tweetData.text - Tweet text content
     * @param {string} [tweetData.mediaUrl] - Optional media URL to attach
     * @returns {Promise<Object>} Tweet result with success status and data
     */
    async postTweet(adminEmail, { text, mediaUrl }) {
        try {
            if (!text) {
                throw new Error('Tweet text is required');
            }

            // Use retry wrapper for the entire tweet operation
            const result = await this.executeWithTokenRefresh(adminEmail, async (newAccessToken) => {
                console.log('🎯 TOKEN SELECTION:', {
                    hasNewAccessToken: !!newAccessToken,
                    usingNewToken: !!newAccessToken
                });

                // Prioritize the refreshed token from volatile memory to avoid race conditions
                let accessToken = newAccessToken;
                let tokens = null;

                if (!accessToken) {
                    // Only query database if we don't have a fresh token from refresh
                    tokens = await getTwitterTokens(adminEmail);
                    if (!tokens?.oauthToken) {
                        const error = new Error('No authentication tokens found. Please connect your Twitter account first.');
                        error.code = 'TWITTER_NOT_CONNECTED';
                        error.requiresReauth = true;
                        throw error;
                    }
                    accessToken = tokens.oauthToken;
                } else {
                    // We have a fresh token, but still need other token data for media uploads
                    tokens = await getTwitterTokens(adminEmail);
                }

                console.log('Using token source:', newAccessToken ? 'refreshed' : 'stored');

                if (!accessToken) {
                    const error = new Error('No valid access token available. Please re-authenticate.');
                    error.code = 'TWITTER_AUTH_EXPIRED';
                    error.requiresReauth = true;
                    throw error;
                }

                const client = new TwitterApi(accessToken);

                // Test token validity
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
                        
                        // Use OAuth 1.0a for media uploads (required for media uploads)
                        const mediaId = await this.uploadMediaWithOAuth1a(buffer, contentType, tokens);
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
                const tweetPayload = {
                    text
                };

                if (mediaIds.length > 0) {
                    tweetPayload.media = {
                        media_ids: mediaIds
                    };
                }

                console.log('Posting tweet with payload:', tweetPayload);
                const tweet = await client.v2.tweet(tweetPayload);
                return tweet;
            });

            return {
                success: true,
                message: 'Tweet posted successfully',
                tweet: result.data
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
}

module.exports = TwitterService;


