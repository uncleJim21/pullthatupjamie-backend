const SocialPost = require('../models/SocialPost');
const SocialPostPublisher = require('./SocialPostPublisher');
const QueueJob = require('../models/QueueJob');

/**
 * Social Post Processor - handles scheduled post processing
 * Integrates with existing QueueJob system for scalability
 */
class SocialPostProcessor {
    constructor() {
        this.isProcessing = false;
        this.processingInterval = 60000; // Check every minute
        this.publisher = new SocialPostPublisher();
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
                    await this.queuePostForProcessing(post);
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
                    await this.queuePostForProcessing(post);
                }
            }

            // Process queued social post jobs
            await this.processQueuedJobs();

        } catch (error) {
            console.error('❌ Error in processScheduledPosts:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Queue a post for processing using existing QueueJob system
     */
    async queuePostForProcessing(post) {
        try {
            console.log(`📤 Queueing post ${post.postId} for ${post.platform}`);

            // Check if already queued
            const existingJob = await QueueJob.findOne({
                lookupHash: post.postId,
                status: { $in: ['queued', 'processing'] }
            });

            if (existingJob) {
                console.log(`⏭️  Post ${post.postId} already queued, skipping`);
                return;
            }

            // Create queue job (integrating with existing system)
            const queueJob = new QueueJob({
                lookupHash: post.postId,
                status: 'queued',
                priority: 0,
                
                // Store social post data in the existing clipData field
                clipData: {
                    type: 'social-post',
                    postId: post.postId,
                    platform: post.platform,
                    adminEmail: post.adminEmail,
                    content: post.content,
                    platformData: post.platformData,
                    attemptCount: post.attemptCount
                }
            });

            await queueJob.save();
            console.log(`✅ Post ${post.postId} queued successfully`);

        } catch (error) {
            console.error(`❌ Error queueing post ${post.postId}:`, error);
            
            // Mark post as failed if we can't queue it
            await SocialPost.findByIdAndUpdate(post._id, {
                status: 'failed',
                error: `Failed to queue: ${error.message}`,
                failedAt: new Date()
            });
        }
    }

    /**
     * Process queued social post jobs
     */
    async processQueuedJobs() {
        try {
            // Find queued social post jobs
            const queuedJobs = await QueueJob.find({
                status: 'queued',
                'clipData.type': 'social-post'
            }).sort({ priority: -1, queuedAt: 1 }).limit(3); // Process up to 3 at a time

            for (const job of queuedJobs) {
                await this.processQueueJob(job);
            }

        } catch (error) {
            console.error('❌ Error processing queued social post jobs:', error);
        }
    }

    /**
     * Process individual queue job
     */
    async processQueueJob(queueJob) {
        try {
            const { postId } = queueJob.clipData;
            console.log(`🔄 Processing queued job for post ${postId}`);

            // Update job status to processing
            await QueueJob.findByIdAndUpdate(queueJob._id, {
                status: 'processing',
                startedAt: new Date(),
                instanceId: process.env.INSTANCE_ID || 'main',
                heartbeatAt: new Date()
            });

            // Get the current post data
            const post = await SocialPost.findOne({ postId });
            if (!post) {
                throw new Error(`Post ${postId} not found`);
            }

            // Skip if already posted or cancelled
            if (post.status === 'posted' || post.status === 'cancelled') {
                console.log(`⏭️  Post ${postId} already ${post.status}, skipping`);
                await QueueJob.findByIdAndUpdate(queueJob._id, {
                    status: 'completed',
                    completedAt: new Date()
                });
                return;
            }

            // Publish the post
            await this.publisher.publishPost(post);

            // Mark job as completed
            await QueueJob.findByIdAndUpdate(queueJob._id, {
                status: 'completed',
                completedAt: new Date()
            });

            console.log(`✅ Successfully processed post ${postId}`);

        } catch (error) {
            console.error(`❌ Error processing queue job ${queueJob._id}:`, error);

            // Update job with error
            await QueueJob.findByIdAndUpdate(queueJob._id, {
                status: 'failed',
                failedAt: new Date(),
                lastError: error.message,
                $push: {
                    errorHistory: {
                        attempt: queueJob.attempts + 1,
                        error: error.message,
                        timestamp: new Date()
                    }
                },
                $inc: { attempts: 1 }
            });

            // The SocialPost status will be updated by the publisher
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

            const queueStats = await QueueJob.aggregate([
                {
                    $match: { 'clipData.type': 'social-post' }
                },
                {
                    $group: {
                        _id: '$status',
                        count: { $sum: 1 }
                    }
                }
            ]);

            return {
                posts: stats,
                queue: queueStats,
                lastCheck: new Date()
            };

        } catch (error) {
            console.error('Error getting social post stats:', error);
            return { error: error.message };
        }
    }
}

module.exports = SocialPostProcessor;
