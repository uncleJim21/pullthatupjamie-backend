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

    async enqueueClip(clipData, timestamps, lookupHash) {
        // Check if clip is already being processed
        if (this.processingQueue.has(lookupHash)) {
            console.log(`[INFO] Clip ${lookupHash} already processing`);
            return { status: 'processing', lookupHash };
        }

        // Check if queue is full
        if (this.waitingQueue.length >= this.maxQueueSize) {
            throw new Error('Queue is full, please try again later');
        }

        // Create job object
        const job = {
            clipData,
            timestamps,
            lookupHash,
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
        while (job.attempts < job.maxAttempts) {
            try {
                job.attempts++;
                await this.clipUtils._backgroundProcessClip(
                    job.clipData,
                    job.timestamps,
                    job.lookupHash
                );
                return;
            } catch (error) {
                if (job.attempts >= job.maxAttempts) {
                    throw error;
                }
                // Wait before retry with exponential backoff
                await new Promise(resolve => 
                    setTimeout(resolve, Math.pow(2, job.attempts) * 1000)
                );
            }
        }
    }

    processNextInQueue() {
        if (this.waitingQueue.length > 0 && this.activeWorkers < this.maxConcurrent) {
            const nextJob = this.waitingQueue.shift();
            this.processJob(nextJob);
        }
    }

    getQueueStatus() {
        return {
            activeWorkers: this.activeWorkers,
            queuedJobs: this.waitingQueue.length,
            processingJobs: Array.from(this.processingQueue.keys())
        };
    }

    // Method to check estimated wait time for a clip
    async getEstimatedWaitTime(lookupHash) {
        const queuePosition = this.waitingQueue.findIndex(job => job.lookupHash === lookupHash);
        
        if (queuePosition === -1) {
            // Check if it's currently processing
            if (this.processingQueue.has(lookupHash)) {
                return 'Currently processing';
            }
            return 'Not found in queue';
        }

        // Estimate based on queue position and average processing time
        const avgProcessingTime = 120; // seconds, adjust based on actual metrics
        const estimatedWait = Math.ceil((queuePosition / this.maxConcurrent) * avgProcessingTime);
        
        return `Approximately ${estimatedWait} seconds`;
    }
}

module.exports = ClipQueueManager;