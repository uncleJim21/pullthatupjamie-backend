// ClipQueueManager.js
const { EventEmitter } = require('events');
const { WorkProductV2 } = require('../models/WorkProductV2');

class ClipQueueManager extends EventEmitter {
    constructor(options = {}, clipUtils, subtitleGenerator = null) {
        super();
        this.maxConcurrent = options.maxConcurrent || 2;
        this.maxQueueSize = options.maxQueueSize || 100;
        this.processingQueue = new Map(); // Currently processing clips
        this.waitingQueue = []; // Clips waiting to be processed
        this.activeWorkers = 0;
        this.clipUtils = clipUtils; // Store the clipUtils reference
        this.subtitleGenerator = subtitleGenerator; // Store the subtitle generation function
    }

    async enqueueClip(clipData, timestamps, lookupHash, subtitles = null) {
        // Check if clip is already being processed
        if (this.processingQueue.has(lookupHash)) {
            console.log(`[INFO] Clip ${lookupHash} already processing`);
            return { status: 'processing', lookupHash };
        }

        // Check if queue is full
        if (this.waitingQueue.length >= this.maxQueueSize) {
            throw new Error('Queue is full, please try again later');
        }

        console.log(`[INFO] Enqueueing clip with ${subtitles ? subtitles.length : 0} subtitles`);

        // Create job object
        const job = {
            clipData,
            timestamps,
            lookupHash,
            subtitles,
            attempts: 0,
            maxAttempts: 3,
            addedAt: Date.now()
        };

        // If we can process immediately, do so
        if (this.activeWorkers < this.maxConcurrent) {
            await this.processJob(job);
        } else {
            // Otherwise add to waiting queue
            this.waitingQueue.push(job);
            console.log(`[INFO] Queued clip ${lookupHash}, position: ${this.waitingQueue.length}`);
        }

        return { status: 'processing', lookupHash };
    }

    async processJob(job) {
        this.activeWorkers++;
        this.processingQueue.set(job.lookupHash, job);

        try {
            // Update MongoDB status to processing
            await WorkProductV2.findOneAndUpdate(
                { lookupHash: job.lookupHash },
                { status: 'processing' },
                { upsert: true }
            );

            console.log(`[INFO] Processing job with ${job.subtitles ? job.subtitles.length : 0} subtitles`);
            
            // Process the clip
            await this._processClipWithRetry(job);

            // Cleanup
            this.processingQueue.delete(job.lookupHash);
            this.activeWorkers--;

            // Process next job if available
            this.processNextInQueue();
        } catch (error) {
            console.error(`[ERROR] Failed to process clip ${job.lookupHash}:`, error);
            
            // Update MongoDB with failure status
            await WorkProductV2.findOneAndUpdate(
                { lookupHash: job.lookupHash },
                { 
                    status: 'failed',
                    error: error.message
                }
            );

            // Cleanup and process next
            this.processingQueue.delete(job.lookupHash);
            this.activeWorkers--;
            this.processNextInQueue();
        }
    }

    async _processClipWithRetry(job) {
        let lastError = null;
        
        for (let attempt = 1; attempt <= job.maxAttempts; attempt++) {
            try {
                console.log(`[INFO] Starting background processing for ${job.lookupHash} (attempt ${attempt})`);
                
                // 1. Fetch accurate text in background
                let clipText = job.clipData.quote || "";
                const guid = job.clipData.additionalFields?.guid;
                const timeStart = job.timestamps ? job.timestamps[0] : job.clipData.timeContext?.start_time;
                const timeEnd = job.timestamps ? job.timestamps[1] : job.clipData.timeContext?.end_time;
                
                if (guid && timeStart !== undefined && timeEnd !== undefined) {
                    console.log(`[INFO] Fetching accurate text for ${job.lookupHash}...`);
                    try {
                        // Import getTextForTimeRange dynamically to avoid circular dependencies
                        const { getTextForTimeRange } = require('../agent-tools/pineconeTools.js');
                        const accurateText = await getTextForTimeRange(guid, timeStart, timeEnd);
                        if (accurateText) {
                            clipText = accurateText;
                            console.log(`[INFO] Retrieved accurate text (${accurateText.length} chars) for ${job.lookupHash}`);
                            
                            // Update the database with accurate text
                            await WorkProductV2.findOneAndUpdate(
                                { lookupHash: job.lookupHash },
                                { 'result.clipText': clipText }
                            );
                        }
                    } catch (textError) {
                        console.error(`[ERROR] Failed to fetch accurate text for ${job.lookupHash}:`, textError);
                        // Continue with original quote
                    }
                }
                
                // 2. Generate subtitles in background if not provided and generator is available
                let subtitles = job.subtitles;
                if (!subtitles && this.subtitleGenerator) {
                    console.log(`[INFO] Generating subtitles in background for ${job.lookupHash}`);
                    try {
                        subtitles = await this.subtitleGenerator(job.clipData, timeStart, timeEnd);
                        console.log(`[INFO] Generated ${subtitles ? subtitles.length : 0} subtitles for ${job.lookupHash}`);
                        
                        // Update the database with subtitle info
                        await WorkProductV2.findOneAndUpdate(
                            { lookupHash: job.lookupHash },
                            { 'result.hasSubtitles': subtitles != null && subtitles.length > 0 }
                        );
                    } catch (subtitleError) {
                        console.error(`[ERROR] Failed to generate subtitles for ${job.lookupHash}:`, subtitleError);
                        subtitles = null; // Continue without subtitles
                    }
                }
                
                // 3. Process the actual clip with all the data
                console.log(`[INFO] Processing clip with ${subtitles ? subtitles.length : 0} subtitles for ${job.lookupHash}`);
                await this.clipUtils._backgroundProcessClip(
                    job.clipData, 
                    job.timestamps, 
                    job.lookupHash,
                    subtitles
                );
                
                console.log(`[INFO] Successfully completed processing for ${job.lookupHash}`);
                return; // Success, exit the retry loop
            } catch (error) {
                lastError = error;
                console.error(`[ERROR] Process attempt ${attempt}/${job.maxAttempts} failed for ${job.lookupHash}:`, error);
                
                if (attempt < job.maxAttempts) {
                    // Wait before retrying (exponential backoff)
                    const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
                    console.log(`[INFO] Waiting ${backoffMs}ms before retry ${attempt + 1} for ${job.lookupHash}`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                }
            }
        }
        
        // If we get here, all attempts failed
        throw lastError || new Error('Failed to process clip after multiple attempts');
    }

    processNextInQueue() {
        if (this.waitingQueue.length > 0 && this.activeWorkers < this.maxConcurrent) {
            const nextJob = this.waitingQueue.shift();
            this.processJob(nextJob).catch(err => {
                console.error(`[ERROR] Failed to process next job:`, err);
            });
        }
    }

    getQueueStatus() {
        return {
            activeWorkers: this.activeWorkers,
            queuedJobs: this.waitingQueue.length,
            processingJobs: Array.from(this.processingQueue.keys())
        };
    }

    async getEstimatedWaitTime(lookupHash) {
        // If this hash is already being processed
        if (this.processingQueue.has(lookupHash)) {
            return {
                position: 0,
                estimatedWaitTime: "Currently processing"
            };
        }

        // Check if it's in the waiting queue
        const queuePosition = this.waitingQueue.findIndex(job => job.lookupHash === lookupHash);
        
        if (queuePosition !== -1) {
            // Return queue position (1-based for user-friendliness)
            return {
                position: queuePosition + 1,
                estimatedWaitTime: `Queue position: ${queuePosition + 1}`
            };
        }

        // Not found in either queue
        return {
            position: -1,
            estimatedWaitTime: "Unknown"
        };
    }
}

module.exports = ClipQueueManager;