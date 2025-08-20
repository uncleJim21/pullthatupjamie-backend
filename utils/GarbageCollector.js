const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { WorkProductV2 } = require('../models/WorkProductV2');
const QueueJob = require('../models/QueueJob');
const { printLog } = require('../constants');

const execAsync = promisify(exec);

class GarbageCollector {
    constructor() {
        this.isRunning = false;
        this.lastRun = null;
        this.cleanupInterval = 24 * 60 * 60 * 1000; // 24 hours
        this.tempDirectories = [
            '/tmp',
            path.join(process.cwd(), 'temp')
        ];
        
        // Conservative cleanup settings
        this.minFileAge = 2 * 60 * 60 * 1000; // 2 hours minimum age
        this.maxFileAge = 7 * 24 * 60 * 60 * 1000; // 7 days maximum age
        this.safeExtensions = ['.mp4', '.mp3', '.wav', '.png', '.jpg', '.jpeg'];
        
        console.log('[INFO] GarbageCollector initialized');
    }

    async start() {
        if (this.isRunning) {
            console.log('[INFO] GarbageCollector already running');
            return;
        }

        this.isRunning = true;
        console.log('[INFO] Starting GarbageCollector...');

        // Run initial cleanup
        await this.runCleanup();

        // Schedule periodic cleanup
        setInterval(async () => {
            await this.runCleanup();
        }, this.cleanupInterval);

        console.log(`[INFO] GarbageCollector scheduled to run every ${this.cleanupInterval / (60 * 60 * 1000)} hours`);
    }

    async runCleanup() {
        if (this.isRunning) {
            console.log('[INFO] GarbageCollector cleanup already in progress, skipping...');
            return;
        }

        this.isRunning = true;
        const startTime = Date.now();

        try {
            console.log('[INFO] 🧹 Starting garbage collection...');
            
            // Get active jobs to avoid cleaning up files in use
            const activeJobs = await this.getActiveJobs();
            console.log(`[INFO] Found ${activeJobs.length} active jobs to protect`);

            // Clean up temp directories
            await this.cleanupTempDirectories(activeJobs);

            // Clean up orphaned database records
            await this.cleanupOrphanedRecords();

            // Clean up old video generation directories
            await this.cleanupVideoDirectories(activeJobs);

            const duration = Date.now() - startTime;
            console.log(`[INFO] ✅ Garbage collection completed in ${duration}ms`);
            this.lastRun = new Date();

        } catch (error) {
            console.error('[ERROR] Garbage collection failed:', error);
        } finally {
            this.isRunning = false;
        }
    }

    async getActiveJobs() {
        try {
            // Get jobs that are currently being processed
            const processingJobs = await QueueJob.find({
                status: 'processing',
                heartbeatAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } // Active in last 10 minutes
            });

            // Get jobs that are queued
            const queuedJobs = await QueueJob.find({
                status: 'queued'
            });

            // Get completed jobs from the last hour (to be extra safe)
            const recentCompletedJobs = await WorkProductV2.find({
                status: 'completed',
                'result.completedAt': { $gt: new Date(Date.now() - 60 * 60 * 1000) }
            });

            return [
                ...processingJobs.map(job => job.lookupHash),
                ...queuedJobs.map(job => job.lookupHash),
                ...recentCompletedJobs.map(job => job.lookupHash)
            ];
        } catch (error) {
            console.error('[ERROR] Failed to get active jobs:', error);
            return [];
        }
    }

    async cleanupTempDirectories(activeJobs) {
        for (const tempDir of this.tempDirectories) {
            try {
                if (!await this.directoryExists(tempDir)) {
                    continue;
                }

                console.log(`[INFO] Cleaning up temp directory: ${tempDir}`);
                const files = await fs.readdir(tempDir);
                let cleanedCount = 0;
                let protectedCount = 0;

                for (const file of files) {
                    const filePath = path.join(tempDir, file);
                    
                    try {
                        const stats = await fs.stat(filePath);
                        const fileAge = Date.now() - stats.mtime.getTime();

                        // Skip if file is too new
                        if (fileAge < this.minFileAge) {
                            continue;
                        }

                        // Check if file might be related to active jobs
                        if (this.isFileRelatedToActiveJob(file, activeJobs)) {
                            protectedCount++;
                            continue;
                        }

                        // Clean up files that are old enough but not too old (between minFileAge and maxFileAge)
                        if (fileAge >= this.minFileAge && fileAge <= this.maxFileAge) {
                            if (stats.isDirectory()) {
                                await fs.rmdir(filePath, { recursive: true });
                            } else {
                                await fs.unlink(filePath);
                            }
                            cleanedCount++;
                        }

                    } catch (fileError) {
                        // Skip files we can't access
                        continue;
                    }
                }

                console.log(`[INFO] Cleaned up ${cleanedCount} files, protected ${protectedCount} files in ${tempDir}`);

            } catch (error) {
                console.error(`[ERROR] Failed to clean up temp directory ${tempDir}:`, error);
            }
        }
    }

    async cleanupVideoDirectories(activeJobs) {
        try {
            // Look for video-gen-* directories in /tmp
            const videoGenPattern = /^video-gen-[\w-]+$/;
            const tempDir = '/tmp';
            
            if (!await this.directoryExists(tempDir)) {
                return;
            }

            const files = await fs.readdir(tempDir);
            const videoDirs = files.filter(file => videoGenPattern.test(file));
            
            let cleanedCount = 0;
            let protectedCount = 0;

            for (const dir of videoDirs) {
                const dirPath = path.join(tempDir, dir);
                
                try {
                    const stats = await fs.stat(dirPath);
                    const dirAge = Date.now() - stats.mtime.getTime();

                    // Skip if directory is too new
                    if (dirAge < this.minFileAge) {
                        continue;
                    }

                    // Check if directory might be related to active jobs
                    if (this.isFileRelatedToActiveJob(dir, activeJobs)) {
                        protectedCount++;
                        continue;
                    }

                    // Only clean up old directories
                    if (dirAge > this.maxFileAge) {
                        await fs.rmdir(dirPath, { recursive: true });
                        cleanedCount++;
                    }

                } catch (dirError) {
                    // Skip directories we can't access
                    continue;
                }
            }

            console.log(`[INFO] Cleaned up ${cleanedCount} video directories, protected ${protectedCount} directories`);

        } catch (error) {
            console.error('[ERROR] Failed to clean up video directories:', error);
        }
    }

    async cleanupOrphanedRecords() {
        try {
            // Find records that are stuck in processing for more than 24 hours
            const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
            
            const stuckRecords = await WorkProductV2.find({
                status: 'processing',
                'result.lastUpdated': { $lt: cutoffTime }
            });

            if (stuckRecords.length > 0) {
                console.log(`[INFO] Found ${stuckRecords.length} stuck records, resetting to queued`);
                
                // Reset stuck records to queued status
                await WorkProductV2.updateMany(
                    {
                        status: 'processing',
                        'result.lastUpdated': { $lt: cutoffTime }
                    },
                    {
                        status: 'queued',
                        'result.lastError': 'Reset by garbage collector - stuck in processing',
                        'result.resetAt': new Date()
                    }
                );
            }

            // Clean up old failed records (older than 30 days)
            const oldCutoffTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const oldFailedRecords = await WorkProductV2.find({
                status: 'failed',
                'result.failedAt': { $lt: oldCutoffTime }
            });

            if (oldFailedRecords.length > 0) {
                console.log(`[INFO] Found ${oldFailedRecords.length} old failed records, archiving`);
                
                // Archive old failed records
                await WorkProductV2.updateMany(
                    {
                        status: 'failed',
                        'result.failedAt': { $lt: oldCutoffTime }
                    },
                    {
                        status: 'archived',
                        'result.archivedAt': new Date()
                    }
                );
            }

        } catch (error) {
            console.error('[ERROR] Failed to clean up orphaned records:', error);
        }
    }

    isFileRelatedToActiveJob(filename, activeJobs) {
        // Check if filename contains any active job hashes
        return activeJobs.some(jobHash => filename.includes(jobHash));
    }

    async directoryExists(dirPath) {
        try {
            await fs.access(dirPath);
            return true;
        } catch {
            return false;
        }
    }

    async getDiskUsage() {
        try {
            const { stdout } = await execAsync('df -h /tmp');
            return stdout;
        } catch (error) {
            return `Could not get disk usage: ${error.message}`;
        }
    }

    async stop() {
        this.isRunning = false;
        console.log('[INFO] GarbageCollector stopped');
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            lastRun: this.lastRun,
            nextRun: this.lastRun ? new Date(this.lastRun.getTime() + this.cleanupInterval) : null
        };
    }
}

module.exports = GarbageCollector;
