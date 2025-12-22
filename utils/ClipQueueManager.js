// ClipQueueManager.js
const { EventEmitter } = require('events');
const { WorkProductV2 } = require('../models/WorkProductV2');
const QueueJob = require('../models/QueueJob');
const { v4: uuidv4 } = require('uuid');
const { DEBUG_MODE, printLog } = require('../constants');

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
        if(!DEBUG_MODE) {
            this.startHeartbeat();
            this.startJobPoller();
            this.reclaimOrphanedJobs();
        }
        else{
            printLog(`[INFO] DEBUG_MODE is enabled, skipping heartbeat and job poller`);
        }
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

    // Enhanced processJobContent with detailed error handling and stage tracking
    async processJobContent(job) {
        let processingStage = 'initialization';
        const logPrefix = `[CLIP-PROCESSING][${job.lookupHash}]`;
        
        try {
            console.log(`${logPrefix} Starting processing with ${job.attempts} attempts`);
            
            // Stage 1: Extract basic parameters and validate
            processingStage = 'parameter-extraction';
            let clipText = job.clipData.quote || "";

            // Core identity for this clip
            const guid = job.clipData.additionalFields?.guid;

            // Time selection precedence:
            // 1) Explicit user timestamps (job.timestamps)
            // 2) Time context on the clip (derived from Pinecone metadata)
            // 3) Fallback to a default 0–30s window
            let timeStart = job.timestamps && job.timestamps.length > 0
                ? job.timestamps[0]
                : job.clipData.timeContext?.start_time;

            let timeEnd = job.timestamps && job.timestamps.length > 1
                ? job.timestamps[1]
                : job.clipData.timeContext?.end_time;

            if (timeStart === undefined || timeStart === null ||
                timeEnd === undefined || timeEnd === null) {
                console.warn(`${logPrefix} [${processingStage}] Missing or incomplete time parameters (start=${timeStart}, end=${timeEnd}); defaulting to 0–30s window for processing`);
                timeStart = 0;
                timeEnd = 30;
            }

            console.log(`${logPrefix} [${processingStage}] Extracted params - GUID: ${guid}, Time: ${timeStart}-${timeEnd}`);
            
            if (!guid) {
                throw new Error(`Missing podcast GUID in clip data`);
            }
            
            // Stage 2: Fetch accurate text from Pinecone
            processingStage = 'text-fetching';
            if (guid && timeStart !== undefined && timeEnd !== undefined) {
                try {
                    console.log(`${logPrefix} [${processingStage}] Fetching accurate text from Pinecone...`);
                    const { getTextForTimeRange } = require('../agent-tools/pineconeTools.js');
                    const accurateText = await getTextForTimeRange(guid, timeStart, timeEnd);
                    if (accurateText && accurateText.length > 0) {
                        clipText = accurateText;
                        await WorkProductV2.findOneAndUpdate(
                            { lookupHash: job.lookupHash },
                            { 
                                'result.clipText': clipText,
                                'result.textSource': 'pinecone',
                                lastUpdated: new Date()
                            }
                        );
                        console.log(`${logPrefix} [${processingStage}] Successfully updated clip text (${clipText.length} chars)`);
                    } else {
                        console.warn(`${logPrefix} [${processingStage}] No accurate text found, using original quote`);
                    }
                } catch (textError) {
                    console.error(`${logPrefix} [${processingStage}] FAILED: ${textError.message}`);
                    // Mark the specific failure but don't stop processing
                    await WorkProductV2.findOneAndUpdate(
                        { lookupHash: job.lookupHash },
                        { 
                            'result.textSource': 'original',
                            'result.textFetchError': textError.message,
                            lastUpdated: new Date()
                        }
                    );
                }
            }
            
            // Stage 3: Generate subtitles if needed
            processingStage = 'subtitle-generation';
            let subtitles = job.subtitles;
            if (!subtitles && this.subtitleGenerator) {
                try {
                    console.log(`${logPrefix} [${processingStage}] Generating subtitles...`);
                    subtitles = await this.subtitleGenerator(job.clipData, timeStart, timeEnd);
                    const hasSubtitles = subtitles != null && subtitles.length > 0;
                    
                    await WorkProductV2.findOneAndUpdate(
                        { lookupHash: job.lookupHash },
                        { 
                            'result.hasSubtitles': hasSubtitles,
                            'result.subtitleCount': hasSubtitles ? subtitles.length : 0,
                            lastUpdated: new Date()
                        }
                    );
                    console.log(`${logPrefix} [${processingStage}] Successfully generated ${subtitles?.length || 0} subtitles`);
                } catch (subtitleError) {
                    console.error(`${logPrefix} [${processingStage}] FAILED: ${subtitleError.message}`);
                    // Mark subtitle failure but continue processing
                    await WorkProductV2.findOneAndUpdate(
                        { lookupHash: job.lookupHash },
                        { 
                            'result.hasSubtitles': false,
                            'result.subtitleError': subtitleError.message,
                            lastUpdated: new Date()
                        }
                    );
                    subtitles = null;
                }
            }
            
            // Stage 4: Process the actual video clip (CRITICAL STAGE)
            processingStage = 'video-processing';
            console.log(`${logPrefix} [${processingStage}] Starting video processing...`);
            
            try {
                await this.clipUtils._backgroundProcessClip(
                    job.clipData, 
                    job.timestamps, 
                    job.lookupHash,
                    subtitles
                );
                console.log(`${logPrefix} [${processingStage}] Video processing completed`);
            } catch (videoError) {
                console.error(`${logPrefix} [${processingStage}] CRITICAL FAILURE: ${videoError.message}`);
                
                // Update both collections with failure status
                await Promise.all([
                    WorkProductV2.findOneAndUpdate(
                        { lookupHash: job.lookupHash },
                        { 
                            status: 'failed',
                            'result.videoProcessingError': videoError.message,
                            'result.failedAt': new Date(),
                            lastUpdated: new Date()
                        }
                    ),
                    QueueJob.findOneAndUpdate(
                        { lookupHash: job.lookupHash },
                        { 
                            lastError: `Video processing failed: ${videoError.message}`,
                            failedAt: new Date()
                        }
                    )
                ]);
                
                throw new Error(`Video processing failed: ${videoError.message}`);
            }
            
            // Stage 5: Verify success and CDN upload
            processingStage = 'verification';
            console.log(`${logPrefix} [${processingStage}] Verifying completion...`);
            
            const updatedClip = await WorkProductV2.findOne({ lookupHash: job.lookupHash });
            if (!updatedClip) {
                throw new Error('WorkProductV2 record not found after processing');
            }
            
            if (!updatedClip.cdnFileId || updatedClip.cdnFileId.trim() === '') {
                console.error(`${logPrefix} [${processingStage}] CRITICAL: CDN upload failed`);
                
                // Mark as failed in both collections
                await Promise.all([
                    WorkProductV2.findOneAndUpdate(
                        { lookupHash: job.lookupHash },
                        { 
                            status: 'failed',
                            'result.uploadError': 'CDN upload failed - no file ID returned',
                            'result.failedAt': new Date(),
                            lastUpdated: new Date()
                        }
                    ),
                    QueueJob.findOneAndUpdate(
                        { lookupHash: job.lookupHash },
                        { 
                            lastError: 'CDN upload failed - no file ID returned',
                            failedAt: new Date()
                        }
                    )
                ]);
                
                throw new Error('CDN upload failed - no file ID returned');
            }
            
            // SUCCESS: Update final completion status
            processingStage = 'completion';
            await WorkProductV2.findOneAndUpdate(
                { lookupHash: job.lookupHash },
                { 
                    status: 'completed',
                    'result.completedAt': new Date(),
                    'result.processingStages': ['parameter-extraction', 'text-fetching', 'subtitle-generation', 'video-processing', 'verification', 'completion'],
                    lastUpdated: new Date()
                }
            );
            
            console.log(`${logPrefix} [${processingStage}] ✅ Successfully completed! CDN URL: ${updatedClip.cdnFileId}`);
            
        } catch (error) {
            console.error(`${logPrefix} [${processingStage}] 🔥 PROCESSING FAILED: ${error.message}`);
            
            // Ensure both collections are marked as failed
            try {
                await Promise.all([
                    WorkProductV2.findOneAndUpdate(
                        { lookupHash: job.lookupHash },
                        { 
                            status: 'failed',
                            'result.failedAt': new Date(),
                            'result.lastError': error.message,
                            'result.failedStage': processingStage,
                            lastUpdated: new Date()
                        }
                    ),
                    QueueJob.findOneAndUpdate(
                        { lookupHash: job.lookupHash },
                        { 
                            lastError: `Failed at stage ${processingStage}: ${error.message}`,
                            failedAt: new Date()
                        }
                    )
                ]);
            } catch (updateError) {
                console.error(`${logPrefix} [${processingStage}] Failed to update failure status: ${updateError.message}`);
            }
            
            // Re-throw the original error for the retry logic
            throw error;
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