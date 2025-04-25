// ClipQueueManager.js
const { EventEmitter } = require('events');
const { WorkProductV2 } = require('../models/WorkProductV2');

class ClipQueueManager extends EventEmitter {
    constructor(options = {}, clipUtils) {
        super();
        this.maxConcurrent = options.maxConcurrent || 2;
        this.maxQueueSize = options.maxQueueSize || 100;
        this.processingQueue = new Map(); // Currently processing clips
        this.waitingQueue = []; // Clips waiting to be processed
        this.activeWorkers = 0;
        this.clipUtils = clipUtils; // Store the clipUtils reference
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
                // Pass subtitles to the background process
                await this.clipUtils._backgroundProcessClip(
                    job.clipData, 
                    job.timestamps, 
                    job.lookupHash,
                    job.subtitles
                );
                return; // Success, exit the retry loop
            } catch (error) {
                lastError = error;
                console.error(`[ERROR] Process attempt ${attempt}/${job.maxAttempts} failed:`, error);
                
                if (attempt < job.maxAttempts) {
                    // Wait before retrying (exponential backoff)
                    const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
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