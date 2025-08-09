const SocialPost = require('../models/SocialPost');
const TwitterService = require('./TwitterService');
const NostrService = require('./NostrService');

/**
 * Social Post Processor - handles scheduled post processing
 * Uses TwitterService and NostrService for actual posting
 */
class SocialPostProcessor {
    constructor() {
        this.isProcessing = false;
        this.processingInterval = 60000; // Check every minute
        this.twitterService = new TwitterService();
        this.nostrService = new NostrService();
    }

    /**
     * Start the scheduled post processing service
     */
    start() {
        console.log('🚀 Starting social post processor...');
        
        // Run immediately on start
        this.processScheduledPosts();
        
        // Then run on interval
        setInterval(() => {
            if (!this.isProcessing) {
                this.processScheduledPosts();
            }
        }, this.processingInterval);
    }

    /**
     * Process all due scheduled posts
     */
    async processScheduledPosts() {
        this.isProcessing = true;
        
        try {
            const now = new Date();
            console.log('🔍 Checking for due social posts...');

            // Find posts that are due for processing
            const duePosts = await SocialPost.find({
                status: 'scheduled',
                scheduledFor: { $lte: now }
            }).limit(10); // Process in batches

            if (duePosts.length > 0) {
                console.log(`📋 Found ${duePosts.length} due posts to process`);
                
                for (const post of duePosts) {
                    await this.processPost(post);
                }
            }

            // Also check for retry posts
            const retryPosts = await SocialPost.find({
                status: 'failed',
                nextRetryAt: { $lte: now },
                attemptCount: { $lt: 3 } // Don't exceed max attempts
            }).limit(5);

            if (retryPosts.length > 0) {
                console.log(`🔄 Found ${retryPosts.length} posts to retry`);
                
                for (const post of retryPosts) {
                    await this.processPost(post);
                }
            }

        } catch (error) {
            console.error('❌ Error in processScheduledPosts:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Process individual social post directly using services
     */
    async processPost(post) {
        try {
            console.log(`🔄 Processing post ${post._id} for ${post.platform}`);

            // Mark as processing
            await SocialPost.findByIdAndUpdate(post._id, {
                status: 'processing',
                processedAt: new Date(),
                $inc: { attemptCount: 1 }
            });

            let result;
            
            if (post.platform === 'twitter') {
                // Use TwitterService
                result = await this.twitterService.postTweet(post.adminEmail, {
                    text: post.content.text,
                    mediaUrl: post.content.mediaUrl
                });
                
                // Update post with Twitter-specific data
                await SocialPost.findByIdAndUpdate(post._id, {
                    status: 'posted',
                    postedAt: new Date(),
                    'platformData.twitterPostId': result.tweet.id,
                    'platformData.twitterPostUrl': `https://twitter.com/i/web/status/${result.tweet.id}`
                });
                
            } else if (post.platform === 'nostr') {
                // Check if we have the required Nostr data
                if (!post.platformData?.nostrEventId || !post.platformData?.nostrSignature || !post.platformData?.nostrPubkey) {
                    throw new Error('Missing required Nostr data: eventId, signature, or pubkey');
                }

                // Create the signed event object
                const signedEvent = {
                    id: post.platformData.nostrEventId,
                    pubkey: post.platformData.nostrPubkey,
                    created_at: Math.floor(Date.now() / 1000),
                    kind: 1,
                    tags: [],
                    content: post.content.text,
                    sig: post.platformData.nostrSignature
                };

                // Use NostrService to post
                const relays = post.platformData.nostrRelays || this.nostrService.DEFAULT_RELAYS;
                result = await this.nostrService.postToNostr({ signedEvent, relays });
                
                // Check if Nostr posting was actually successful
                if (!result.success) {
                    throw new Error(`Nostr posting failed: ${result.message}. Failed relays: ${result.failedRelays.map(r => `${r.relay} (${r.error})`).join(', ')}`);
                }
                
                // Update post with Nostr-specific data
                await SocialPost.findByIdAndUpdate(post._id, {
                    status: 'posted',
                    postedAt: new Date(),
                    'platformData.nostrEventId': result.eventId,
                    'platformData.nostrPostUrl': result.primalUrl
                });
                
            } else {
                throw new Error(`Unsupported platform: ${post.platform}`);
            }

            console.log(`✅ Successfully posted to ${post.platform}: ${post._id}`);

        } catch (error) {
            console.error(`❌ Error processing post ${post._id}:`, error);

            // Calculate next retry time (exponential backoff)
            const nextRetryAt = new Date(Date.now() + Math.pow(2, post.attemptCount) * 60000); // 1min, 2min, 4min...

            // Update post status
            const updates = {
                status: 'failed',
                error: error.message,
                failedAt: new Date()
            };

            // Only set retry time if under max attempts
            if (post.attemptCount < post.maxAttempts) {
                updates.nextRetryAt = nextRetryAt;
                console.log(`📅 Will retry post ${post._id} at ${nextRetryAt.toISOString()}`);
            } else {
                console.log(`❌ Post ${post._id} exceeded max attempts (${post.maxAttempts}), giving up`);
            }

            await SocialPost.findByIdAndUpdate(post._id, updates);
        }
    }

    /**
     * Manual trigger for processing (useful for testing or manual intervention)
     */
    async triggerProcessing() {
        console.log('🚀 Manual trigger for social post processing');
        if (!this.isProcessing) {
            await this.processScheduledPosts();
        } else {
            console.log('⏳ Processing already in progress, skipping manual trigger');
        }
    }

    /**
     * Get processing statistics
     */
    async getStats() {
        try {
            const stats = await SocialPost.aggregate([
                {
                    $group: {
                        _id: { status: '$status', platform: '$platform' },
                        count: { $sum: 1 }
                    }
                },
                {
                    $group: {
                        _id: '$_id.status',
                        total: { $sum: '$count' },
                        platforms: {
                            $push: {
                                platform: '$_id.platform',
                                count: '$count'
                            }
                        }
                    }
                }
            ]);

            return {
                posts: stats,
                lastCheck: new Date()
            };

        } catch (error) {
            console.error('Error getting social post stats:', error);
            return { error: error.message };
        }
    }
}

module.exports = SocialPostProcessor;
