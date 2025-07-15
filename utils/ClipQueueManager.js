// ClipQueueManager.js
const { EventEmitter } = require('events');
const { WorkProductV2 } = require('../models/WorkProductV2');
const QueueJob = require('../models/QueueJob');
const { v4: uuidv4 } = require('uuid');

class ClipQueueManager extends EventEmitter {
    constructor(options = {}, clipUtils, subtitleGenerator = null) {
        super();
        this.maxConcurrent = options.maxConcurrent || 2;
        this.clipUtils = clipUtils;
        this.subtitleGenerator = subtitleGenerator;
        
        // Instance identification
        this.instanceId = uuidv4();
        this.activeWorkers = 0;
        
        // Timing configuration
        this.jobTimeout = 10 * 60 * 1000; // 10 minutes
        this.heartbeatInterval = 30 * 1000; // 30 seconds
        this.pollInterval = 5 * 1000; // 5 seconds
        
        console.log(`[INFO] ClipQueueManager initialized with instanceId: ${this.instanceId}`);
        
        // Start background processes
        this.startHeartbeat();
        this.startJobPoller();
        this.reclaimOrphanedJobs();
    }

    // ✅ GUARANTEED TRANSFER: Add job to persistent database queue
    async enqueueClip(clipData, timestamps, lookupHash, subtitles = null) {
        try {
            // Check if job already exists
            const existingJob = await QueueJob.findOne({ lookupHash });
            if (existingJob) {
                if (existingJob.status === 'completed') {
                    return { status: 'completed', lookupHash };
                }
                if (existingJob.status === 'processing' || existingJob.status === 'queued') {
                    return { status: 'processing', lookupHash };
                }
                if (existingJob.status === 'failed' && existingJob.attempts >= existingJob.maxAttempts) {
                    // Reset failed job for retry
                    await QueueJob.findOneAndUpdate(
                        { lookupHash },
                        { 
                            status: 'queued',
                            attempts: 0,
                            lastError: null,
                            queuedAt: new Date()
                        }
                    );
                }
            } else {
                // Create new job in database
                await QueueJob.create({
                    lookupHash,
                    clipData,
                    timestamps,
                    subtitles,
                    status: 'queued',
                    queuedAt: new Date()
                });
                
                console.log(`[INFO] ✅ Job ${lookupHash} added to persistent queue`);
            }

            return { status: 'processing', lookupHash };
        } catch (error) {
            console.error(`[ERROR] Failed to enqueue job ${lookupHash}:`, error);
            throw error;
        }
    }

    // ✅ GUARANTEED TRANSFER: Poll database for available jobs
    async startJobPoller() {
        setInterval(async () => {
            if (this.activeWorkers < this.maxConcurrent) {
                await this.claimAndProcessNextJob();
            }
        }, this.pollInterval);
        
        console.log(`[INFO] Job poller started - checking every ${this.pollInterval/1000}s`);
    }

    // ✅ GUARANTEED TRANSFER: Atomic job claiming with MongoDB transactions
    async claimAndProcessNextJob() {
        const session = await QueueJob.startSession();
        
        try {
            await session.withTransaction(async () => {
                // Find and claim next available job atomically
                const job = await QueueJob.findOneAndUpdate(
                    { 
                        status: 'queued',
                        attempts: { $lt: 3 } // Don't retry failed jobs indefinitely
                    },
                    { 
                        status: 'processing',
                        instanceId: this.instanceId,
                        claimedAt: new Date(),
                        heartbeatAt: new Date(),
                        startedAt: new Date(),
                        $inc: { attempts: 1 }
                    },
                    { 
                        sort: { priority: -1, queuedAt: 1 }, // High priority first, then FIFO
                        new: true,
                        session
                    }
                );

                if (job) {
                    console.log(`[INFO] 🎯 Claimed job ${job.lookupHash} (attempt ${job.attempts})`);
                    
                    // Process the job outside the transaction
                    setImmediate(() => {
                        this.processClaimedJob(job).catch(err => {
                            console.error(`[ERROR] Failed to process claimed job ${job.lookupHash}:`, err);
                        });
                    });
                }
            });
        } catch (error) {
            console.error('[ERROR] Failed to claim job:', error);
        } finally {
            await session.endSession();
        }
    }

    // ✅ GUARANTEED TRANSFER: Process claimed job with heartbeat
    async processClaimedJob(job) {
        this.activeWorkers++;
        
        try {
            console.log(`[INFO] 🚀 Processing job ${job.lookupHash} on instance ${this.instanceId}`);
            
            // Start heartbeat for this job
            const heartbeatTimer = setInterval(async () => {
                try {
                    await QueueJob.findOneAndUpdate(
                        { lookupHash: job.lookupHash, instanceId: this.instanceId },
                        { heartbeatAt: new Date() }
                    );
                } catch (err) {
                    console.error(`[ERROR] Heartbeat failed for ${job.lookupHash}:`, err);
                }
            }, this.heartbeatInterval);

            // Process the clip
            await this.processJobContent(job);
            
            // Mark as completed
            await QueueJob.findOneAndUpdate(
                { lookupHash: job.lookupHash },
                { 
                    status: 'completed',
                    completedAt: new Date(),
                    instanceId: null // Release ownership
                }
            );
            
            console.log(`[SUCCESS] ✅ Job ${job.lookupHash} completed successfully`);
            
            clearInterval(heartbeatTimer);
            
        } catch (error) {
            console.error(`[ERROR] Job ${job.lookupHash} failed:`, error);
            
            // Mark as failed or back to queued for retry
            const shouldRetry = job.attempts < job.maxAttempts;
            
            await QueueJob.findOneAndUpdate(
                { lookupHash: job.lookupHash },
                { 
                    status: shouldRetry ? 'queued' : 'failed',
                    lastError: error.message,
                    failedAt: shouldRetry ? undefined : new Date(),
                    instanceId: null, // Release ownership
                    $push: { 
                        errorHistory: {
                            attempt: job.attempts,
                            error: error.message,
                            timestamp: new Date()
                        }
                    }
                }
            );
            
            console.log(`[INFO] Job ${job.lookupHash} ${shouldRetry ? 'queued for retry' : 'marked as failed'}`);
            
        } finally {
            this.activeWorkers--;
        }
    }

    // Process the actual job content (same as before)
    async processJobContent(job) {
        // 1. Fetch accurate text
        let clipText = job.clipData.quote || "";
        const guid = job.clipData.additionalFields?.guid;
        const timeStart = job.timestamps ? job.timestamps[0] : job.clipData.timeContext?.start_time;
        const timeEnd = job.timestamps ? job.timestamps[1] : job.clipData.timeContext?.end_time;
        
        if (guid && timeStart !== undefined && timeEnd !== undefined) {
            try {
                const { getTextForTimeRange } = require('../agent-tools/pineconeTools.js');
                const accurateText = await getTextForTimeRange(guid, timeStart, timeEnd);
                if (accurateText) {
                    clipText = accurateText;
                    await WorkProductV2.findOneAndUpdate(
                        { lookupHash: job.lookupHash },
                        { 'result.clipText': clipText }
                    );
                }
            } catch (textError) {
                console.error(`[ERROR] Failed to fetch accurate text for ${job.lookupHash}:`, textError);
            }
        }
        
        // 2. Generate subtitles if needed
        let subtitles = job.subtitles;
        if (!subtitles && this.subtitleGenerator) {
            try {
                subtitles = await this.subtitleGenerator(job.clipData, timeStart, timeEnd);
                await WorkProductV2.findOneAndUpdate(
                    { lookupHash: job.lookupHash },
                    { 'result.hasSubtitles': subtitles != null && subtitles.length > 0 }
                );
            } catch (subtitleError) {
                console.error(`[ERROR] Failed to generate subtitles for ${job.lookupHash}:`, subtitleError);
                subtitles = null;
            }
        }
        
        // 3. Process the actual clip
        await this.clipUtils._backgroundProcessClip(
            job.clipData, 
            job.timestamps, 
            job.lookupHash,
            subtitles
        );
        
        // 4. Verify success
        const updatedClip = await WorkProductV2.findOne({ lookupHash: job.lookupHash });
        if (!updatedClip || !updatedClip.cdnFileId) {
            throw new Error('Clip processing completed but cdnFileId was not set in database');
        }
    }

    // ✅ GUARANTEED TRANSFER: Heartbeat to prove instance is alive
    startHeartbeat() {
        setInterval(async () => {
            try {
                // Update heartbeat for all jobs owned by this instance
                await QueueJob.updateMany(
                    { instanceId: this.instanceId, status: 'processing' },
                    { heartbeatAt: new Date() }
                );
            } catch (error) {
                console.error('[ERROR] Heartbeat update failed:', error);
            }
        }, this.heartbeatInterval);
        
        console.log(`[INFO] Heartbeat started - updating every ${this.heartbeatInterval/1000}s`);
    }

    // ✅ GUARANTEED TRANSFER: Reclaim jobs from dead instances
    async reclaimOrphanedJobs() {
        try {
            const cutoffTime = new Date(Date.now() - this.jobTimeout);
            
            const orphanedJobs = await QueueJob.find({
                status: 'processing',
                $or: [
                    { heartbeatAt: { $lt: cutoffTime } },
                    { heartbeatAt: { $exists: false } },
                    { claimedAt: { $lt: cutoffTime } }
                ]
            });
            
            if (orphanedJobs.length > 0) {
                console.log(`[INFO] 🔄 Reclaiming ${orphanedJobs.length} orphaned jobs`);
                
                // Reset orphaned jobs to queued status
                await QueueJob.updateMany(
                    {
                        status: 'processing',
                        $or: [
                            { heartbeatAt: { $lt: cutoffTime } },
                            { heartbeatAt: { $exists: false } },
                            { claimedAt: { $lt: cutoffTime } }
                        ]
                    },
                    {
                        status: 'queued',
                        instanceId: null,
                        claimedAt: null,
                        heartbeatAt: null,
                        startedAt: null
                    }
                );
                
                console.log(`[INFO] ✅ Successfully reclaimed ${orphanedJobs.length} jobs for processing`);
            } else {
                console.log('[INFO] No orphaned jobs found');
            }
        } catch (error) {
            console.error('[ERROR] Failed to reclaim orphaned jobs:', error);
        }
    }

    // ✅ GUARANTEED TRANSFER: Graceful shutdown with job release
    async shutdown() {
        console.log(`[INFO] 🛑 Instance ${this.instanceId} shutting down gracefully...`);
        
        // Release all claimed jobs back to queue
        const releasedJobs = await QueueJob.updateMany(
            { instanceId: this.instanceId, status: 'processing' },
            { 
                status: 'queued',
                instanceId: null,
                claimedAt: null,
                heartbeatAt: null,
                startedAt: null
            }
        );
        
        console.log(`[INFO] ✅ Released ${releasedJobs.modifiedCount} jobs back to queue`);
        
        // Wait for current processing to complete (up to 30 seconds)
        const shutdownTimeout = 30000;
        const startTime = Date.now();
        
        while (this.activeWorkers > 0 && (Date.now() - startTime) < shutdownTimeout) {
            console.log(`[INFO] Waiting for ${this.activeWorkers} jobs to complete...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log(`[INFO] ✅ Instance ${this.instanceId} shutdown complete`);
    }

    async getQueueStatus() {
        const [queueStats, instanceJobs] = await Promise.all([
            QueueJob.aggregate([
                { $group: { _id: '$status', count: { $sum: 1 } } }
            ]),
            QueueJob.find({ instanceId: this.instanceId, status: 'processing' })
        ]);
        
        return {
            instanceId: this.instanceId,
            activeWorkers: this.activeWorkers,
            maxConcurrent: this.maxConcurrent,
            queueStats: queueStats.reduce((acc, stat) => {
                acc[stat._id] = stat.count;
                return acc;
            }, {}),
            processingJobs: instanceJobs.map(job => job.lookupHash)
        };
    }

    async getEstimatedWaitTime(lookupHash) {
        try {
            // Check if job is currently being processed
            const processingJob = await QueueJob.findOne({ 
                lookupHash, 
                status: 'processing' 
            });
            
            if (processingJob) {
                return {
                    position: 0,
                    estimatedWaitTime: "Currently processing"
                };
            }

            // Check if it's in the queue
            const queuedJob = await QueueJob.findOne({ 
                lookupHash, 
                status: 'queued' 
            });
            
            if (queuedJob) {
                // Count jobs ahead in queue (older queuedAt times)
                const jobsAhead = await QueueJob.countDocuments({
                    status: 'queued',
                    queuedAt: { $lt: queuedJob.queuedAt }
                });
                
                return {
                    position: jobsAhead + 1,
                    estimatedWaitTime: `Queue position: ${jobsAhead + 1}`
                };
            }

            // Check if it's completed
            const completedJob = await QueueJob.findOne({ 
                lookupHash, 
                status: 'completed' 
            });
            
            if (completedJob) {
                return {
                    position: 0,
                    estimatedWaitTime: "Completed"
                };
            }

            // Check if it failed
            const failedJob = await QueueJob.findOne({ 
                lookupHash, 
                status: 'failed' 
            });
            
            if (failedJob) {
                return {
                    position: -1,
                    estimatedWaitTime: "Failed"
                };
            }

            // Not found in queue
            return {
                position: -1,
                estimatedWaitTime: "Unknown"
            };
        } catch (error) {
            console.error(`[ERROR] Failed to get estimated wait time for ${lookupHash}:`, error);
            return {
                position: -1,
                estimatedWaitTime: "Error"
            };
        }
    }
}

module.exports = ClipQueueManager;