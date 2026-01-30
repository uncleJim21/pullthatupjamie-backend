const { TwitterApi } = require('twitter-api-v2');
const { getAdminTwitterCredentials } = require('./userTwitterTokens');
const SocialPost = require('../models/SocialPost');

/**
 * Social Post Publisher - handles publishing to different platforms
 * Reuses existing Twitter logic from twitterRoutes.js
 */
class SocialPostPublisher {

    /**
     * Publish a social post to its designated platform
     */
    async publishPost(socialPost) {
        try {
            console.log(`Publishing post ${socialPost.postId} to ${socialPost.platform}`);

            // Update status to processing
            await SocialPost.findByIdAndUpdate(socialPost._id, {
                status: 'processing',
                processedAt: new Date(),
                $inc: { attemptCount: 1 }
            });

            let result;
            if (socialPost.platform === 'twitter') {
                result = await this.publishToTwitter(socialPost);
            } else if (socialPost.platform === 'nostr') {
                result = await this.publishToNostr(socialPost);
            } else {
                throw new Error(`Unsupported platform: ${socialPost.platform}`);
            }

            // Update post with success
            await SocialPost.findByIdAndUpdate(socialPost._id, {
                status: 'posted',
                postedAt: new Date(),
                error: null,
                ...result
            });

            console.log(`Successfully published post ${socialPost.postId} to ${socialPost.platform}`);
            return { success: true, ...result };

        } catch (error) {
            console.error(`Failed to publish post ${socialPost.postId}:`, error);

            // Update post with failure
            const shouldRetry = socialPost.attemptCount < socialPost.maxAttempts;
            await SocialPost.findByIdAndUpdate(socialPost._id, {
                status: shouldRetry ? 'failed' : 'cancelled',
                error: error.message,
                failedAt: new Date(),
                nextRetryAt: shouldRetry ? new Date(Date.now() + (30 * 60 * 1000)) : null // 30 min retry
            });

            throw error;
        }
    }

    /**
     * Publish to Twitter - uses identity-based token lookup
     */
    async publishToTwitter(socialPost) {
        try {
            // Build identity from post (supports both userId and email)
            const identity = {
                userId: socialPost.adminUserId,
                email: socialPost.adminEmail
            };
            
            // Get Twitter credentials using new identity-based lookup
            const { accessToken, oauth1Tokens } = await getAdminTwitterCredentials(identity);
            
            if (!accessToken) {
                throw new Error('Twitter not connected for this user. Please connect Twitter account first.');
            }

            // Create Twitter client
            const client = new TwitterApi(accessToken);

            // Test token validity (reusing existing pattern)
            const testUser = await client.v2.me();
            console.log('Twitter token valid for user:', testUser.data.username);

            let mediaIds = [];

            // Handle media upload if present (reuse existing OAuth 1.0a logic)
            if (socialPost.content.mediaUrl) {
                try {
                    console.log('Downloading media from CDN:', socialPost.content.mediaUrl);
                    
                    const response = await fetch(socialPost.content.mediaUrl, {
                        headers: {
                            'Accept': '*/*',
                            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
                        }
                    });
                    
                    if (!response.ok) {
                        throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
                    }
                    
                    const contentType = response.headers.get('content-type') || 'video/mp4';
                    const arrayBuffer = await response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    
                    console.log('Uploading media to Twitter using OAuth 1.0a...');
                    
                    // Use OAuth 1.0a for media uploads (required by Twitter)
                    const mediaId = await this.uploadMediaWithOAuth1a(buffer, contentType, oauth1Tokens);
                    mediaIds.push(mediaId);
                    
                    console.log('Media upload successful, media ID:', mediaId);
                    
                } catch (mediaError) {
                    console.error('Media upload error:', mediaError);
                    throw new Error(`Failed to upload media to Twitter: ${mediaError.message}`);
                }
            }

            // Prepare tweet payload
            const tweetPayload = {
                text: socialPost.content.text
            };

            if (mediaIds.length > 0) {
                tweetPayload.media = {
                    media_ids: mediaIds
                };
            }

            console.log('Posting tweet with payload:', tweetPayload);
            const tweet = await client.v2.tweet(tweetPayload);

            // Return data for database update
            return {
                'platformData.twitterPostId': tweet.data.id,
                'platformData.twitterPostUrl': `https://twitter.com/${testUser.data.username}/status/${tweet.data.id}`
            };

        } catch (error) {
            // Enhanced error handling from twitterRoutes.js
            if (error.code === 401 || 
                error.status === 401 ||
                error.message?.includes('401') ||
                error.message?.includes('Unauthorized')) {
                
                throw new Error('Twitter authentication expired. Please re-authenticate your Twitter account.');
            }

            throw error;
        }
    }

    /**
     * Upload media using OAuth 1.0a
     * @param {Buffer} buffer - Media buffer
     * @param {string} contentType - MIME type
     * @param {Object} oauth1Tokens - { oauth1AccessToken, oauth1AccessSecret }
     */
    async uploadMediaWithOAuth1a(buffer, contentType, oauth1Tokens) {
        console.log('Starting OAuth 1.0a media upload...', {
            totalBytes: buffer.length,
            contentType
        });

        try {
            // Check if we have OAuth 1.0a tokens
            if (!oauth1Tokens?.oauth1AccessToken || !oauth1Tokens?.oauth1AccessSecret) {
                throw new Error('OAuth 1.0a tokens not found. Media uploads require additional Twitter authorization.');
            }

            // Create OAuth 1.0a client
            const oauth1Client = new TwitterApi({
                appKey: process.env.TWITTER_CONSUMER_KEY,
                appSecret: process.env.TWITTER_CONSUMER_SECRET,
                accessToken: oauth1Tokens.oauth1AccessToken,
                accessSecret: oauth1Tokens.oauth1AccessSecret,
            });
            
            console.log('Uploading media with OAuth 1.0a...');
            
            // Use the built-in chunked upload method (reusing existing pattern)
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
                data: error.data
            });
            throw error;
        }
    }

    /**
     * Publish to Nostr - placeholder using user-provided signature
     */
    async publishToNostr(socialPost) {
        try {
            // Check if we have required Nostr data
            if (!socialPost.platformData.nostrSignature || !socialPost.platformData.nostrPubkey) {
                throw new Error('Nostr signature and pubkey required. Please provide signature from your Nostr extension.');
            }

            console.log('Publishing to Nostr with user-provided signed event...');
            
            // Build content with media URL if present
            let content = socialPost.content.text;
            if (socialPost.content.mediaUrl) {
                content += `\n\n${socialPost.content.mediaUrl}`;
            }

            // Create the signed event that should have been provided by the frontend
            // In practice, this would come from the user's browser extension
            const signedEvent = {
                id: socialPost.platformData.nostrEventId || 'temp_id',
                pubkey: socialPost.platformData.nostrPubkey,
                created_at: Math.floor(Date.now() / 1000),
                kind: 1,
                tags: socialPost.content.mediaUrl ? [['r', socialPost.content.mediaUrl]] : [],
                content: content,
                sig: socialPost.platformData.nostrSignature
            };

            // Call our internal Nostr API endpoint
            const nostrResponse = await fetch('http://localhost:4132/api/nostr/post', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.INTERNAL_API_TOKEN || 'internal'}`
                },
                body: JSON.stringify({
                    signedEvent,
                    relays: socialPost.platformData.nostrRelays || undefined
                })
            });

            if (!nostrResponse.ok) {
                const errorData = await nostrResponse.json();
                throw new Error(`Nostr API error: ${errorData.message || 'Unknown error'}`);
            }

            const nostrResult = await nostrResponse.json();

            if (!nostrResult.success) {
                throw new Error(`Nostr publishing failed: ${nostrResult.message}`);
            }

            console.log(`Nostr post published successfully to ${nostrResult.stats.successful}/${nostrResult.stats.total} relays`);

            // Return data for database update
            return {
                'platformData.nostrEventId': nostrResult.eventId,
                'platformData.nostrRelays': nostrResult.publishedRelays
            };

        } catch (error) {
            throw error;
        }
    }
}

module.exports = SocialPostPublisher;
