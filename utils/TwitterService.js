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
    async postTweet(adminEmail, { text, mediaUrl }) {
        try {
            if (!text) {
                throw new Error('Tweet text is required');
            }

            console.log(`📤 TwitterService.postTweet for: ${adminEmail}`);

            // Get credentials (handles migration + decryption + refresh)
            const { user, accessToken, needsSave, oauth1Tokens } = await getAdminTwitterCredentials(adminEmail);

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
}

module.exports = TwitterService;


