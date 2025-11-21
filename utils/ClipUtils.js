const ffmpeg = require('fluent-ffmpeg');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs');
const axios = require('axios');
const { performance } = require('perf_hooks');
const VideoGenerator = require('./VideoGenerator');
const DigitalOceanSpacesManager = require('./DigitalOceanSpacesManager');
const { WorkProductV2, calculateLookupHash, calculateEditHash } = require('../models/WorkProductV2');
const SubtitleUtils = require('./SubtitleUtils');


class ClipUtils {
  constructor() {
    this.spacesManager = new DigitalOceanSpacesManager(
      process.env.SPACES_ENDPOINT,
      process.env.SPACES_CLIP_ACCESS_KEY_ID,
      process.env.SPACES_CLIP_SECRET_KEY,
      {
          maxRetries: 3,
          baseDelay: 1000,
          maxDelay: 10000,
          timeout: 30000
      }
    );
    
    // Memory management configuration
    this.memoryConfig = {
      maxMemoryUsage: 1024 * 1024 * 1024, // 1GB max memory usage
      largeFileThreshold: 100 * 1024 * 1024, // 100MB threshold for range extraction
      rangeBufferSize: 10 * 1024 * 1024, // 10MB buffer around extract range
      maxConcurrentProcessing: 2, // Limit concurrent processing
      cleanupIntervalMs: 30000, // 30 seconds cleanup interval
      // NEW: Smart chunking configuration
      smartChunkingThreshold: 50 * 1024 * 1024, // 50MB threshold for smart chunking
      maxChunkDuration: 600, // 10 minutes max duration for chunking
      chunkBufferMB: 1 // 1MB buffer before/after chunk
    };
    
    // Active processing tracking
    this.activeProcesses = new Map();
    this.tempFiles = new Set();
    
    // Start periodic cleanup
    this.startMemoryManagement();
  }

  truncateMiddle(str, maxLength, ellipsis = '...') {
    if (!str || str.length <= maxLength) return str;
    
    const ellipsisLength = ellipsis.length;
    const charsToShow = maxLength - ellipsisLength;
    
    // Calculate the front and back lengths
    // We want more characters at the front than the back
    const frontLength = Math.ceil(charsToShow * 0.6);
    const backLength = Math.floor(charsToShow * 0.4);
    
    // Get the front and back parts
    const front = str.substring(0, frontLength).trim();
    const back = str.substring(str.length - backLength).trim();
    
    return `${front}${ellipsis}${back}`;
  }

  /**
   * Memory management and monitoring utilities
   */
  startMemoryManagement() {
    // Periodic cleanup of temp files and memory monitoring
    this.cleanupInterval = setInterval(() => {
      this.performMemoryCleanup();
    }, this.memoryConfig.cleanupIntervalMs);
    
    console.log('[MEMORY] Memory management started');
  }
  
  stopMemoryManagement() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    console.log('[MEMORY] Memory management stopped');
  }
  
  getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
      rss: usage.rss, // Resident Set Size
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers
    };
  }
  
  checkMemoryPressure() {
    const usage = this.getMemoryUsage();
    const totalUsage = usage.rss;
    
    if (totalUsage > this.memoryConfig.maxMemoryUsage) {
      console.warn(`[MEMORY] High memory usage detected: ${Math.round(totalUsage / 1024 / 1024)}MB`);
      return true;
    }
    return false;
  }
  
  async performMemoryCleanup() {
    const debugPrefix = `[MEMORY-CLEANUP][${Date.now()}]`;
    
    try {
      // Check memory usage
      const usage = this.getMemoryUsage();
      const totalMB = Math.round(usage.rss / 1024 / 1024);
      
      if (totalMB > 500) { // Log when usage is high
        console.log(`${debugPrefix} Memory usage: ${totalMB}MB, Active processes: ${this.activeProcesses.size}`);
      }
      
      // Clean up orphaned temp files
      const orphanedFiles = [];
      for (const filePath of this.tempFiles) {
        try {
          if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            const ageMs = Date.now() - stats.mtime.getTime();
            
            // Remove files older than 1 hour
            if (ageMs > 60 * 60 * 1000) {
              await fs.promises.unlink(filePath);
              orphanedFiles.push(filePath);
            }
          }
        } catch (err) {
          // File already removed or permission error
          orphanedFiles.push(filePath);
        }
      }
      
      // Remove from tracking
      orphanedFiles.forEach(file => this.tempFiles.delete(file));
      
      if (orphanedFiles.length > 0) {
        console.log(`${debugPrefix} Cleaned up ${orphanedFiles.length} orphaned temp files`);
      }
      
      // Force garbage collection if available and memory pressure is high
      if (global.gc && this.checkMemoryPressure()) {
        console.log(`${debugPrefix} Forcing garbage collection due to memory pressure`);
        global.gc();
      }
      
    } catch (error) {
      console.error(`${debugPrefix} Cleanup error: ${error.message}`);
    }
  }
  
  registerTempFile(filePath) {
    this.tempFiles.add(filePath);
  }
  
  unregisterTempFile(filePath) {
    this.tempFiles.delete(filePath);
  }
  
  async cleanupTempFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
      this.unregisterTempFile(filePath);
    } catch (error) {
      console.warn(`[CLEANUP] Failed to clean up ${filePath}: ${error.message}`);
    }
  }

  async extractAudioClip(audioUrl, startTime, endTime) {
    console.log('[DEBUG] extractAudioClip - Inputs:', { audioUrl, startTime, endTime });

    // Add validation for start and end times
    if (startTime === undefined || startTime === null) {
        startTime = 0;
    }
    if (endTime === undefined || endTime === null) {
        throw new Error('End time is required for clip extraction');
    }

    // Validate times are within reasonable bounds
    if (startTime < 0 || endTime < 0 || endTime <= startTime) {
        throw new Error('Invalid time range');
    }

    const outputPath = `/tmp/clip-${Date.now()}.mp3`; 
    console.log(`[DEBUG] Extracting audio to: ${outputPath}`);

    return new Promise((resolve, reject) => {
        if (!audioUrl) {
            console.error('[ERROR] extractAudioClip - Missing audio URL!');
            return reject(new Error('extractAudioClip failed: Missing audio URL'));
        }

        // Round to nearest whole number
        const formattedStartTime = Math.round(startTime);
        const duration = Math.round(endTime - startTime);

        console.log('[DEBUG] Using rounded times:', { formattedStartTime, duration });

        ffmpeg(audioUrl)
            .seekInput(formattedStartTime)
            .duration(duration)
            .outputOptions([
                '-y',                    // Overwrite output files
                '-vn',                   // Disable video
                '-acodec', 'libmp3lame', // Use MP3 codec
                '-ar', '44100',          // Set audio rate
                '-ac', '2',              // Set audio channels (stereo)
                '-b:a', '128k'           // Set bitrate
            ])
            .toFormat('mp3')
            .on('start', command => console.log('[DEBUG] FFmpeg started:', command))
            .on('stderr', stderrLine => console.log('[DEBUG] FFmpeg stderr:', stderrLine))
            .on('progress', progress => console.log('[DEBUG] FFmpeg progress:', progress.percent?.toFixed(2) + '%'))
            .on('error', err => {
                console.error('[ERROR] FFmpeg processing failed:', err);
                console.error('[ERROR] FFmpeg error details:', err.message);
                reject(new Error(`FFmpeg failed: ${err.message}`));
            })
            .on('end', () => {
                console.log('[DEBUG] FFmpeg extraction completed:', outputPath);
                resolve(outputPath);
            })
            .save(outputPath);
    });
}


  async downloadImage(url) {
    console.log('Downloading image:', url);
    
    const maxRetries = 3;
    const timeoutMs = 30000; // 30 seconds timeout
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios({
                url,
                responseType: 'arraybuffer',
                timeout: timeoutMs,
                validateStatus: status => status === 200 
            });
            
            const tempPath = path.join(os.tmpdir(), `temp-${Date.now()}.jpg`);
            await fs.promises.writeFile(tempPath, response.data);
            console.log('Image downloaded successfully to:', tempPath);
            return tempPath;
        } catch (error) {
            console.error(`Error downloading image (attempt ${attempt}/${maxRetries}):`, error.message);
            
            if (attempt === maxRetries) {
                // Use fallback image on final retry
                const fallbackImagePath = path.join(__dirname, '../assets/default-episode-image.jpg');
                if (fs.existsSync(fallbackImagePath)) {
                    console.log('Using fallback image');
                    return fallbackImagePath;
                }
                throw new Error(`Failed to download image after ${maxRetries} attempts: ${error.message}`);
            }
            
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
  }

  async generateShareableVideo(clipData, audioPath, subtitles = null) {
    let profileImagePath = null;
    let videoGenerator = null;
    
    try {
        console.log('Downloading profile image...');
        profileImagePath = await this.downloadImage(clipData.episodeImage);
        
        const watermarkPath = path.join(__dirname, '../assets/watermark.png');
        if (!fs.existsSync(watermarkPath)) {
            throw new Error('Watermark file not found at: ' + watermarkPath);
        }

        const outputPath = path.join(os.tmpdir(), `${clipData.shareLink}.mp4`);
        
        // Enhanced subtitle debugging
        if (subtitles && subtitles.length > 0) {
            console.log(`[INFO] Adding ${subtitles.length} subtitles to video`);
            console.log(`[DEBUG] First 3 subtitles (before adjustment): ${JSON.stringify(subtitles.slice(0, 3))}`);
            
            // Validate subtitle format
            const validSubtitles = subtitles.filter(s => 
                s && typeof s === 'object' && 
                typeof s.start === 'number' && 
                typeof s.end === 'number' && 
                typeof s.text === 'string' &&
                s.start <= s.end
            );
            
            if (validSubtitles.length !== subtitles.length) {
                console.warn(`[WARN] Found ${subtitles.length - validSubtitles.length} invalid subtitles that will be skipped`);
                subtitles = validSubtitles;
            }
            
            // Sort subtitles by start time
            subtitles.sort((a, b) => a.start - b.start);
            
            // *CRITICAL FIX*: Always adjust subtitle timestamps to be relative to clip start
            // Get clip start time
            const clipStartTime = clipData.timeContext?.start_time ?? 0;
            
            if (subtitles[0].start > 10) { // This indicates absolute timestamps (not 0-based)
                console.log(`[INFO] Adjusting subtitle timestamps from absolute to relative (first start: ${subtitles[0].start})`);
                
                // Adjust all timestamps to be relative to clip start
                subtitles = subtitles.map(subtitle => ({
                    ...subtitle,
                    start: Math.max(0, subtitle.start - clipStartTime),
                    end: Math.max(0, subtitle.end - clipStartTime)
                }));
                
                console.log(`[DEBUG] First 3 subtitles (after adjustment): ${JSON.stringify(subtitles.slice(0, 3))}`);
            }
        } else {
            console.log('[INFO] No subtitles provided for video');
            subtitles = []; // Ensure subtitles is an array even if null
        }
        
        // Create new instance for this specific video
        videoGenerator = new VideoGenerator({
            audioPath,
            profileImagePath,
            watermarkPath,
            title: this.truncateMiddle(clipData.creator, 30),
            subtitle: this.truncateMiddle(clipData.episode, 80),
            outputPath,
            creator: clipData.creator,
            subtitles: subtitles,  // Pass subtitles to VideoGenerator
            frameRate: 30  // Increase frame rate for smoother subtitle display
        });

        console.log('Starting video generation...');
        await videoGenerator.generateVideo();
        console.log('Video generation completed');
        
        return { videoPath: outputPath, videoGenerator };
    } catch (error) {
        console.error('Error in video generation:', error);
        throw error;
    } finally {
        // Clean up downloaded profile image
        if (profileImagePath && fs.existsSync(profileImagePath)) {
            try {
                await fs.promises.unlink(profileImagePath);
                console.log('Cleaned up profile image:', profileImagePath);
            } catch (err) {
                console.error('Error cleaning up profile image:', err);
            }
        }
    }
}


  /**
   * Handles the full lifecycle of clip generation.
   * Returns a `lookupHash` immediately and starts processing asynchronously.
   *
   * @param {Object} clipData - The clip metadata.
   * @param {Array} timestamps - Optional override timestamps.
   * @param {Array} subtitles - Optional subtitles array.
   * @returns {string} - lookupHash to poll.
   */
  async processClip(clipData, timestamps = null, subtitles = null) {
    console.log(`[DEBUG] processClip started for: ${JSON.stringify(clipData,null,2)}`);
    
    // Log if we have subtitles
    if (subtitles && subtitles.length > 0) {
        console.log(`[DEBUG] Processing clip with ${subtitles.length} subtitles`);
    }

    // Compute lookupHash
    const lookupHash = calculateLookupHash(clipData, timestamps);
    console.log(`[DEBUG] Generated lookupHash: ${lookupHash}`);

    try {
        // Check MongoDB for existing clip
        let existingClip = await WorkProductV2.findOne({ lookupHash });

        if (existingClip) {
            if (existingClip.cdnFileId) {
                console.log(`[DEBUG] Clip already exists, returning cached URL: ${existingClip.cdnFileId}`);
                return { status: 'done', lookupHash };
            } else {
                console.log(`[DEBUG] Clip is still processing, returning lookupHash: ${lookupHash}`);
                return { status: 'processing', lookupHash };
            }
        }

        // ✅ Create MongoDB entry to track processing
        await WorkProductV2.create({
            type: 'ptuj-clip',
            lookupHash,
            cdnFileId: null,
            result: {
                hasSubtitles: subtitles != null && subtitles.length > 0
            }
        });

        console.log(`[DEBUG] WorkProductV2 entry created for ${lookupHash}`);

        // ✅ Return lookupHash immediately
        const response = { status: 'processing', lookupHash };

        // 🚀 Force background job to run immediately
        this._backgroundProcessClip(clipData, timestamps, lookupHash, subtitles).catch(err => {
            console.error(`[ERROR] _backgroundProcessClip FAILED:`, err);
        });

        return response;
    } catch (error) {
        console.error(`[ERROR] processClip failed:`, error);
        throw error;
    }
  }

  

  /**
   * Handles actual audio extraction, video processing, and CDN upload.
   *
   * @param {Object} clipData
   * @param {Array} timestamps
   * @param {string} lookupHash
   * @param {Array} subtitles Optional subtitles array
   */
  async _backgroundProcessClip(clipData, timestamps, lookupHash, subtitles = null) {
    console.log(`[DEBUG] _backgroundProcessClip STARTED for ${lookupHash}`);
    
    try {
        console.log(`[HARD DEBUG] _backgroundProcessClip running at:`, new Date().toISOString());

        // Force an initial log to prove it's running
        console.log(`[DEBUG] Extracting audio for ${lookupHash}`);
        
        // Debug subtitles if provided
        if (subtitles && subtitles.length > 0) {
            console.log(`[DEBUG] Processing clip with ${subtitles.length} subtitles`);
            console.log(`[DEBUG] First subtitle (original): ${JSON.stringify(subtitles[0])}`);
            console.log(`[DEBUG] Last subtitle (original): ${JSON.stringify(subtitles[subtitles.length-1])}`);
        } else {
            console.log(`[DEBUG] No subtitles provided for clip ${lookupHash}`);
        }

        const audioPath = await this.extractAudioClip(
          clipData.audioUrl,
          timestamps?.[0] ?? clipData.timeContext?.start_time ?? 0,
          timestamps?.[1] ?? clipData.timeContext?.end_time ?? (clipData.timeContext?.start_time + 30) // fallback to 30 sec clip
        );
        
        console.log(`[DEBUG] Audio extraction complete for ${lookupHash}, path: ${audioPath}`);
        
        // Calculate clip duration for verification
        const clipStartTime = timestamps?.[0] ?? clipData.timeContext?.start_time ?? 0;
        const clipEndTime = timestamps?.[1] ?? clipData.timeContext?.end_time ?? (clipData.timeContext?.start_time + 30);
        const clipDuration = clipEndTime - clipStartTime;
        
        console.log(`[DEBUG] Clip duration: ${clipDuration}s (${clipStartTime} to ${clipEndTime})`);
        
        // ALWAYS adjust subtitle timestamps for consistency - this is critical
        if (subtitles && subtitles.length > 0) {
            console.log(`[INFO] Adjusting all subtitle timestamps to be relative to clip start time (${clipStartTime})`);
            
            // Adjust all subtitle timestamps relative to clip start time
            subtitles = subtitles.map(subtitle => ({
                ...subtitle,
                start: Math.max(0, subtitle.start - clipStartTime),
                end: Math.min(clipDuration, subtitle.end - clipStartTime)
            }))
            // Filter out subtitles outside the clip duration
            .filter(subtitle => subtitle.start < clipDuration && subtitle.end > 0);
            
            console.log(`[DEBUG] After adjustment: ${subtitles.length} subtitles remain in clip timeframe`);
            if (subtitles.length > 0) {
                console.log(`[DEBUG] First subtitle (adjusted): ${JSON.stringify(subtitles[0])}`);
                console.log(`[DEBUG] Last subtitle (adjusted): ${JSON.stringify(subtitles[subtitles.length-1])}`);
            }
        }
        
        console.log(`[DEBUG] Generating video for ${lookupHash}`);
        const { videoPath, videoGenerator } = await this.generateShareableVideo(clipData, audioPath, subtitles);

        console.log(`[DEBUG] Uploading to CDN for ${lookupHash}`);
        const cdnFileId = `clips/${clipData.additionalFields.feedId}/${clipData.additionalFields.guid}/${lookupHash}-clip.mp4`;

        const videoBuffer = await fs.promises.readFile(videoPath);
        const uploadedUrl = await this.spacesManager.uploadFile(
            process.env.SPACES_CLIP_BUCKET_NAME,
            cdnFileId,
            videoBuffer,
            'video/mp4'
        );

        console.log(`[DEBUG] Video upload successful for ${lookupHash}: ${uploadedUrl}`);

        console.log(`[DEBUG] Saving preview image for ${lookupHash}`);

        // Define preview filename based on video path
        const previewFileName = `${lookupHash}-preview.png`;
        const previewCdnFileId = cdnFileId.replace('.mp4', '-preview.png');

        // Determine first frame
        const previewFramePath = videoPath.replace('.mp4', '-preview.png');
        const previewImagePath = path.join(os.tmpdir(), previewFileName);

        // Copy the frame as a preview image
        if (fs.existsSync(previewFramePath)) {
            fs.copyFileSync(previewFramePath, previewImagePath);
            console.log(`[INFO] Preview frame saved: ${previewImagePath}`);
        } else {
            console.warn(`[WARN] First frame missing: ${previewFramePath}`);
        }

        if (fs.existsSync(previewImagePath)) {
            const previewBuffer = await fs.promises.readFile(previewImagePath);
            const previewUploadedUrl = await this.spacesManager.uploadFile(
                process.env.SPACES_CLIP_BUCKET_NAME,
                previewCdnFileId,
                previewBuffer,
                'image/png'
            );
        
            console.log(`[DEBUG] Preview uploaded for ${lookupHash}: ${previewUploadedUrl}`);
        
            // ✅ Update MongoDB with preview URL and subtitle info
            const updatedClip = await WorkProductV2.findOneAndUpdate(
                { lookupHash },
                { 
                    $set: { 
                        cdnFileId: uploadedUrl,
                        'result.previewImageId': previewUploadedUrl,
                        'result.hasSubtitles': subtitles != null && subtitles.length > 0
                    }
                },
                { new: true }
            );
            console.log(`[DEBUG] Updated MongoDB entry:`, updatedClip);                        
        } else {
            console.warn(`[WARN] No preview image found for ${lookupHash}, skipping upload.`);
        }        
        
        console.log(`[DEBUG] Processing complete for ${lookupHash}`);
    } catch (error) {
        console.error(`[ERROR] _backgroundProcessClip CRASHED for ${lookupHash}:`, error);
    }
  }

  /**
   * Validates that a CDN URL belongs to our storage buckets or well-known podcast hosting services
   * @param {string} cdnUrl - The CDN URL to validate
   * @returns {boolean} - True if URL is from our CDN or trusted podcast hosting service
   */
  validateOurCdnUrl(cdnUrl) {
    if (!cdnUrl || typeof cdnUrl !== 'string') {
      return false;
    }

    // Our own CDN buckets
    const allowedDomains = [
      process.env.SPACES_BUCKET_NAME + '.' + process.env.SPACES_ENDPOINT,
      process.env.SPACES_CLIP_BUCKET_NAME + '.' + process.env.SPACES_ENDPOINT,
    ].filter(Boolean); // Remove any undefined values

    // Well-known podcast hosting services that support video
    const trustedPodcastHosts = [
      'feeds.fountain.fm',           // Fountain
      'media.transistor.fm',         // Transistor
      'www.buzzsprout.com',          // Buzzsprout
      'traffic.libsyn.com',          // Libsyn
      'mcdn.podbean.com',            // Podbean
      'anchor.fm',                   // Anchor/Spotify
      's3.castbox.fm',               // Castbox
      'media.rss.com',               // RSS.com
      'media.castos.com',            // Castos
      'player.captivate.fm',         // Captivate
      'cdn.simplecast.com',          // Simplecast
      'media.blubrry.com',           // Blubrry
      'api.spreaker.com',            // Spreaker
      'media.zencast.fm',            // Zencast
      'media.redcircle.com',         // RedCircle
      'cdn.podigee.com',             // Podigee
      'media.fireside.fm',           // Fireside
      'static.adorilabs.com',        // Adori
      'content.production.cdn.art19.com', // Art19
      'dts.podtrac.com',             // Podtrac
      'chrt.fm',                     // Chartable
      'claritaspod.com',             // Claritas
      'pdst.fm',                     // Podscribe
      'feeds.megaphone.fm',          // Megaphone
      'traffic.omny.fm',             // Omny Studio
      'dovetail.prxu.org',           // Dovetail/PRX
    ];

    const allAllowedDomains = [...allowedDomains, ...trustedPodcastHosts];

    return allAllowedDomains.some(domain => cdnUrl.includes(domain));
  }

  /**
   * Checks if a CDN file exists and gets its metadata
   * @param {string} cdnUrl - The CDN URL to check
   * @returns {Object} - File metadata including size, type, etc.
   */
  async validateCdnFile(cdnUrl) {
    const debugPrefix = `[EDIT-VIDEO][${Date.now()}]`;
    console.log(`${debugPrefix} Validating CDN file: ${cdnUrl}`);

    try {
      // Make a HEAD request to check file existence without downloading
      const response = await axios({
        method: 'head',
        url: cdnUrl,
        timeout: 10000,
        validateStatus: status => status === 200
      });

      const contentType = response.headers['content-type'] || '';
      const contentLength = parseInt(response.headers['content-length'] || '0');
      
      // Check if it's a video, audio, or streaming format
      const isVideo = contentType.startsWith('video/');
      const isAudio = contentType.startsWith('audio/');
      const isHLS = contentType === 'application/vnd.apple.mpegurl' || contentType === 'application/x-mpegURL';
      const isDASH = contentType === 'application/dash+xml';
      const isStreaming = isHLS || isDASH;
      
      if (!isVideo && !isAudio && !isStreaming) {
        throw new Error(`Unsupported file type: ${contentType}`);
      }

      // Check file size (2GB limit) - skip for streaming formats (they don't have a fixed size)
      const maxSize = 2 * 1024 * 1024 * 1024; // 2GB
      if (!isStreaming && contentLength > maxSize) {
        throw new Error(`File too large: ${contentLength} bytes (max: ${maxSize})`);
      }

      console.log(`${debugPrefix} File validation successful: ${contentType}, ${contentLength} bytes${isStreaming ? ' (streaming format)' : ''}`);
      
      return {
        exists: true,
        contentType,
        contentLength,
        isVideo,
        isAudio,
        isStreaming,
        isHLS,
        isDASH
      };
    } catch (error) {
      console.error(`${debugPrefix} File validation failed: ${error.message}`);
      throw new Error(`CDN file validation failed: ${error.message}`);
    }
  }

  /**
   * Main orchestrator for video edit requests
   * TODO: Consider quota limits for video editing in future releases
   * 
   * @param {string} cdnUrl - Source CDN URL
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds  
   * @param {boolean} useSubtitles - Whether to include subtitles
   * @param {string} feedId - Feed ID for organizing uploads
   * @param {Array} clientSubtitles - Optional client-provided subtitles
   * @returns {Object} - Status and lookup hash
   */
  async processEditRequest(cdnUrl, startTime, endTime, useSubtitles = false, feedId = 'unknown', clientSubtitles = null) {
    const debugPrefix = `[EDIT-VIDEO][${Date.now()}]`;
    console.log(`${debugPrefix} Processing edit request: ${cdnUrl}, ${startTime}s-${endTime}s`);

    try {
      // Validate inputs
      if (!this.validateOurCdnUrl(cdnUrl)) {
        throw new Error('CDN URL must be from our storage buckets');
      }

      const duration = endTime - startTime;
      if (duration <= 0) {
        throw new Error('End time must be greater than start time');
      }

      if (duration > 600) { // 10 minutes max
        throw new Error('Edit duration cannot exceed 10 minutes');
      }

      // Validate CDN file exists
      await this.validateCdnFile(cdnUrl);

      // Generate deterministic hash
      const lookupHash = calculateEditHash(cdnUrl, startTime, endTime, useSubtitles);
      console.log(`${debugPrefix} Generated lookupHash: ${lookupHash}`);

      // Check for existing edit
      const existingEdit = await WorkProductV2.findOne({ lookupHash });
      if (existingEdit) {
        if (existingEdit.cdnFileId) {
          console.log(`${debugPrefix} Edit already exists: ${existingEdit.cdnFileId}`);
          return { status: 'completed', lookupHash, url: existingEdit.cdnFileId };
        } else {
          console.log(`${debugPrefix} Edit already processing: ${lookupHash}`);
          return { status: 'processing', lookupHash, pollUrl: `/api/edit-status/${lookupHash}` };
        }
      }

      // Extract parent filename for tracking
      // DETERMINISTIC ALGORITHM - Frontend can replicate this
      const urlParts = cdnUrl.split('/');
      const parentFileName = urlParts[urlParts.length - 1];
      let parentFileBase = parentFileName.replace(/\.[^/.]+$/, ""); // Remove extension
      
      // For external URLs (not our CDN), create a deterministic hash identifier
      // Algorithm: MD5 hash of URL (without query params), prefixed with 'ext-'
      const allowedDomains = [
        process.env.SPACES_BUCKET_NAME + '.' + process.env.SPACES_ENDPOINT,
        process.env.SPACES_CLIP_BUCKET_NAME + '.' + process.env.SPACES_ENDPOINT,
      ].filter(Boolean);
      
      const isOurCdn = allowedDomains.some(domain => cdnUrl.includes(domain));
      
      if (!isOurCdn) {
        // DETERMINISTIC: Hash the full URL without query params
        const crypto = require('crypto');
        const urlWithoutQuery = cdnUrl.split('?')[0];
        parentFileBase = 'ext-' + crypto.createHash('md5').update(urlWithoutQuery).digest('hex').substring(0, 16);
        console.log(`${debugPrefix} Generated deterministic ID for external URL: ${parentFileBase} from ${urlWithoutQuery}`);
      }
      
      // Create database entry
      await WorkProductV2.create({
        type: 'video-edit',
        lookupHash,
        status: 'queued',
        cdnFileId: null,
        result: {
          originalUrl: cdnUrl,
          parentFileName: parentFileName,
          parentFileBase: parentFileBase,
          editStart: startTime,
          editEnd: endTime,
          editDuration: duration,
          useSubtitles: useSubtitles,
          processingStrategy: 'full', // Phase 1: full download
          feedId: feedId
        }
      });

      // Invalidate cache for this parent file
      if (global.editChildrenCache) {
        global.editChildrenCache.invalidate(parentFileBase);
        console.log(`${debugPrefix} Invalidated cache for parentFileBase: ${parentFileBase}`);
      }

      console.log(`${debugPrefix} Database entry created for ${lookupHash}`);

      // Start background processing
      this._backgroundProcessEdit(cdnUrl, startTime, endTime, lookupHash, useSubtitles, feedId, clientSubtitles).catch(err => {
        console.error(`${debugPrefix} Background processing failed:`, err);
        // Update database with error status
        WorkProductV2.findOneAndUpdate(
          { lookupHash },
          { status: 'failed', error: err.message }
        ).catch(dbErr => console.error(`${debugPrefix} Error updating database: ${dbErr.message}`));
      });

      return { 
        status: 'processing', 
        lookupHash, 
        pollUrl: `/api/edit-status/${lookupHash}`,
        parentFileBase, // Include this so client knows how to query for children
        parentFileName
      };

    } catch (error) {
      console.error(`${debugPrefix} Edit request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Smart extraction strategy selector - uses FFmpeg's HTTP streaming for efficiency
   * 
   * @param {string} cdnUrl - Source CDN URL
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds
   * @param {string} lookupHash - Unique identifier
   * @param {Object} fileMetadata - File size and type info
   * @returns {string} - Path to extracted segment
   */
  async _smartExtractSegment(cdnUrl, startTime, endTime, lookupHash, fileMetadata) {
    const debugPrefix = `[SMART-EXTRACT][${lookupHash}]`;
    const duration = endTime - startTime;
    const fileSize = fileMetadata.contentLength;
    
    console.log(`${debugPrefix} File size: ${Math.round(fileSize / 1024 / 1024)}MB, Duration: ${duration}s, Type: ${fileMetadata.contentType}`);
    
    // For HLS streams (m3u8), always use FFmpeg HTTP streaming (no download needed)
    // FFmpeg has native HLS support and will handle the playlist + segments automatically
    if (fileMetadata.isHLS || fileMetadata.isStreaming) {
      console.log(`${debugPrefix} Detected HLS/streaming format - using FFmpeg direct streaming`);
      try {
        return await this._extractWithFFmpegHttpStream(cdnUrl, startTime, endTime, lookupHash);
      } catch (streamError) {
        console.error(`${debugPrefix} FFmpeg streaming failed for HLS: ${streamError.message}`);
        throw new Error(`HLS stream processing failed: ${streamError.message}`);
      }
    }
    
    // For MP4 files, use FFmpeg's HTTP streaming with seek - much more efficient
    // This avoids downloading the full file while maintaining compatibility
    if (fileMetadata.contentType === 'video/mp4' && duration < 300) { // Under 5 minutes
      console.log(`${debugPrefix} Using FFmpeg HTTP streaming with seek (no download required)`);
      try {
        return await this._extractWithFFmpegHttpStream(cdnUrl, startTime, endTime, lookupHash);
      } catch (streamError) {
        console.warn(`${debugPrefix} HTTP streaming failed, falling back to full download: ${streamError.message}`);
        return await this._extractWithFullDownload(cdnUrl, startTime, endTime, lookupHash);
      }
    } else {
      console.log(`${debugPrefix} Using full download strategy (file type or duration requires it)`);
      return await this._extractWithFullDownload(cdnUrl, startTime, endTime, lookupHash);
    }
  }
  
  /**
   * Extract video segment using FFmpeg's built-in HTTP streaming
   * This is the most efficient method - FFmpeg seeks directly via HTTP without downloading the full file
   * 
   * @param {string} cdnUrl - Source CDN URL
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds
   * @param {string} lookupHash - Unique identifier
   * @returns {string} - Path to extracted segment
   */
  async _extractWithFFmpegHttpStream(cdnUrl, startTime, endTime, lookupHash) {
    const debugPrefix = `[FFMPEG-HTTP-STREAM][${lookupHash}]`;
    const startMemory = this.getMemoryUsage();
    const duration = endTime - startTime;
    
    try {
      console.time(`${debugPrefix} HttpStream`);
      console.log(`${debugPrefix} Extracting ${duration}s segment directly via HTTP streaming`);
      
      const outputPath = path.join(os.tmpdir(), `edit-stream-${Date.now()}.mp4`);
      this.registerTempFile(outputPath);
      
      // Use FFmpeg to extract directly from HTTP URL or HLS stream
      // FFmpeg will seek to the position and only download what's needed
      // For HLS, FFmpeg will automatically handle the playlist and download segments
      // Optimized settings for consistent performance across different hardware
      await new Promise((resolve, reject) => {
        ffmpeg(cdnUrl)
          .inputOptions([
            '-ss', startTime.toString(), // Accurate seeking - seek to exact timestamp
            '-accurate_seek' // Enable accurate seeking to avoid keyframe issues
          ])
          .duration(duration)
          .outputOptions([
            '-y', // Overwrite output files
            '-c:v', 'libx264', // Video codec
            '-preset', 'veryfast', // Much faster encoding, minimal quality loss
            '-crf', '23', // Good quality
            '-c:a', 'aac', // Audio codec (can't copy from HLS, needs re-encoding)
            '-movflags', '+faststart', // Optimize for streaming
            '-pix_fmt', 'yuv420p', // Ensure compatibility
            '-avoid_negative_ts', 'make_zero', // Handle timestamp issues
            '-threads', '0' // Use all available CPU cores
          ])
          .toFormat('mp4')
          .on('start', command => console.log(`${debugPrefix} FFmpeg started: ${command}`))
          .on('progress', progress => {
            if (progress.percent) {
              console.log(`${debugPrefix} Progress: ${progress.percent.toFixed(1)}%`);
            }
          })
          .on('error', err => {
            console.error(`${debugPrefix} FFmpeg error: ${err.message}`);
            reject(new Error(`HTTP stream extraction failed: ${err.message}`));
          })
          .on('end', () => {
            console.log(`${debugPrefix} Extraction completed`);
            resolve();
          })
          .save(outputPath);
      });
      
      console.timeEnd(`${debugPrefix} HttpStream`);
      
      const endMemory = this.getMemoryUsage();
      const memoryDelta = Math.round((endMemory.rss - startMemory.rss) / 1024 / 1024);
      console.log(`${debugPrefix} HTTP streaming complete, memory delta: ${memoryDelta}MB`);
      
      return outputPath;
      
    } catch (error) {
      console.error(`${debugPrefix} HTTP streaming failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * NEW: Smart chunking with true HTTP range requests
   * Downloads only the necessary byte ranges instead of full file
   * 
   * NOTE: This approach is fundamentally flawed for MP4 files because MP4 requires
   * the moov atom (metadata) to be present. Use FFmpeg HTTP streaming instead.
   * Keeping this for reference but it's deprecated.
   * 
   * @param {string} cdnUrl - Source CDN URL
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds
   * @param {string} lookupHash - Unique identifier
   * @param {Object} fileMetadata - File size and type info
   * @returns {string} - Path to extracted segment
   */
  async _extractWithSmartChunking(cdnUrl, startTime, endTime, lookupHash, fileMetadata) {
    const debugPrefix = `[SMART-CHUNKING][${lookupHash}]`;
    const startMemory = this.getMemoryUsage();
    
    try {
      console.time(`${debugPrefix} SmartChunking`);
      
      // Calculate approximate byte ranges for the time segment
      const fileSize = fileMetadata.contentLength;
      const totalDuration = await this._getVideoDurationFromUrl(cdnUrl);
      const duration = endTime - startTime;
      
      // Estimate byte positions (rough approximation)
      const bytesPerSecond = fileSize / totalDuration;
      const bufferBytes = this.memoryConfig.chunkBufferMB * 1024 * 1024;
      const startByte = Math.max(0, Math.floor(startTime * bytesPerSecond) - bufferBytes); // Configurable buffer before
      const endByte = Math.min(fileSize - 1, Math.ceil(endTime * bytesPerSecond) + bufferBytes); // Configurable buffer after
      
      console.log(`${debugPrefix} Downloading bytes ${startByte}-${endByte} (${Math.round((endByte - startByte) / 1024 / 1024)}MB) of ${Math.round(fileSize / 1024 / 1024)}MB file`);
      
      // Download only the chunk we need
      const chunkPath = path.join(os.tmpdir(), `edit-chunk-${Date.now()}.tmp`);
      this.registerTempFile(chunkPath);
      
      await this._downloadByteRange(cdnUrl, chunkPath, startByte, endByte);
      
      // Extract the exact segment from the chunk
      const outputPath = path.join(os.tmpdir(), `edit-range-${Date.now()}.mp4`);
      this.registerTempFile(outputPath);
      
      // Adjust start time relative to chunk start
      const chunkStartTime = startByte / bytesPerSecond;
      const adjustedStartTime = Math.max(0, startTime - chunkStartTime);
      const adjustedEndTime = Math.min(duration, endTime - chunkStartTime);
      
      await this._extractSegmentWithFFmpeg(chunkPath, outputPath, adjustedStartTime, adjustedEndTime);
      
      // Cleanup chunk file
      await this.cleanupTempFile(chunkPath);
      
      console.timeEnd(`${debugPrefix} SmartChunking`);
      
      const endMemory = this.getMemoryUsage();
      const memoryDelta = Math.round((endMemory.rss - startMemory.rss) / 1024 / 1024);
      console.log(`${debugPrefix} Smart chunking complete, memory delta: ${memoryDelta}MB`);
      
      return outputPath;
      
    } catch (error) {
      console.error(`${debugPrefix} Smart chunking failed: ${error.message}`);
      throw error; // Let caller handle fallback
    }
  }

  /**
   * Download a specific byte range from a URL using HTTP range requests
   * 
   * @param {string} url - Source URL
   * @param {string} outputPath - Local file path to save to
   * @param {number} startByte - Start byte position
   * @param {number} endByte - End byte position
   */
  async _downloadByteRange(url, outputPath, startByte, endByte) {
    const debugPrefix = `[BYTE-RANGE-DOWNLOAD]`;
    console.log(`${debugPrefix} Downloading range ${startByte}-${endByte}`);
    
    return new Promise(async (resolve, reject) => {
      try {
        const response = await axios({
          method: 'get',
          url: url,
          headers: {
            'Range': `bytes=${startByte}-${endByte}`
          },
          responseType: 'stream',
          timeout: 300000 // 5 minutes
        });
        
        if (response.status !== 206) {
          throw new Error(`Expected HTTP 206 (Partial Content), got ${response.status}`);
        }
        
        const writer = fs.createWriteStream(outputPath);
        let downloadedBytes = 0;
        
        response.data.on('data', (chunk) => {
          downloadedBytes += chunk.length;
        });
        
        response.data.pipe(writer);
        
        writer.on('finish', () => {
          console.log(`${debugPrefix} Downloaded ${Math.round(downloadedBytes / 1024 / 1024)}MB`);
          resolve();
        });
        
        writer.on('error', reject);
        response.data.on('error', reject);
        
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Get video duration from URL without downloading the full file
   * Uses FFprobe with HTTP range requests to get metadata
   * 
   * @param {string} url - Video URL
   * @returns {number} - Duration in seconds
   */
  async _getVideoDurationFromUrl(url) {
    const { promisify } = require('util');
    const exec = promisify(require('child_process').exec);
    
    try {
      // Use FFprobe to get duration from URL without downloading
      const { stdout } = await exec(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${url}"`
      );
      return parseFloat(stdout.trim());
    } catch (error) {
      console.warn(`Failed to get duration from URL, using fallback: ${error.message}`);
      // Fallback: assume 1 hour duration for calculation
      return 3600;
    }
  }

  /**
   * Range-based extraction using HTTP range requests and streaming
   * 
   * @param {string} cdnUrl - Source CDN URL
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds
   * @param {string} lookupHash - Unique identifier
   * @returns {string} - Path to extracted segment
   */
  async _extractWithRangeRequests(cdnUrl, startTime, endTime, lookupHash) {
    const debugPrefix = `[RANGE-EXTRACT][${lookupHash}]`;
    const startMemory = this.getMemoryUsage();
    
    try {
      console.time(`${debugPrefix} RangeExtraction`);
      
      // Use FFmpeg's built-in HTTP range capabilities
      const outputPath = path.join(os.tmpdir(), `edit-range-${Date.now()}.mp4`);
      this.registerTempFile(outputPath);
      
      await this._extractSegmentWithFFmpegRange(cdnUrl, outputPath, startTime, endTime);
      
      console.timeEnd(`${debugPrefix} RangeExtraction`);
      
      const endMemory = this.getMemoryUsage();
      const memoryDelta = Math.round((endMemory.rss - startMemory.rss) / 1024 / 1024);
      console.log(`${debugPrefix} Range extraction complete, memory delta: ${memoryDelta}MB`);
      
      return outputPath;
      
    } catch (error) {
      console.error(`${debugPrefix} Range extraction failed: ${error.message}`);
      // Fallback to full download
      console.log(`${debugPrefix} Falling back to full download`);
      return await this._extractWithFullDownload(cdnUrl, startTime, endTime, lookupHash);
    }
  }
  
  /**
   * Full download extraction with memory management
   * 
   * @param {string} cdnUrl - Source CDN URL
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds
   * @param {string} lookupHash - Unique identifier
   * @returns {string} - Path to extracted segment
   */
  async _extractWithFullDownload(cdnUrl, startTime, endTime, lookupHash) {
    const debugPrefix = `[FULL-DOWNLOAD][${lookupHash}]`;
    const startMemory = this.getMemoryUsage();
    
    try {
      console.time(`${debugPrefix} FullDownload`);
      
      // Check memory pressure before download
      if (this.checkMemoryPressure()) {
        throw new Error('Cannot proceed: memory pressure too high');
      }
      
      const tempSourcePath = path.join(os.tmpdir(), `edit-source-${Date.now()}.tmp`);
      this.registerTempFile(tempSourcePath);
      
      // Download with streaming and memory monitoring
      console.log(`${debugPrefix} Downloading source file`);
      await this._downloadFileWithMemoryManagement(cdnUrl, tempSourcePath, lookupHash);
      
      // Get duration and validate
      const actualDuration = await this._getFileDuration(tempSourcePath);
      console.log(`${debugPrefix} Source duration: ${actualDuration}s`);
      
      if (endTime > actualDuration) {
        throw new Error(`End time (${endTime}s) exceeds video duration (${actualDuration}s)`);
      }
      
      // Extract segment
      const outputPath = path.join(os.tmpdir(), `edit-output-${Date.now()}.mp4`);
      this.registerTempFile(outputPath);
      
      await this._extractSegmentWithFFmpeg(tempSourcePath, outputPath, startTime, endTime);
      
      // Cleanup source file immediately
      await this.cleanupTempFile(tempSourcePath);
      
      console.timeEnd(`${debugPrefix} FullDownload`);
      
      const endMemory = this.getMemoryUsage();
      const memoryDelta = Math.round((endMemory.rss - startMemory.rss) / 1024 / 1024);
      console.log(`${debugPrefix} Full download complete, memory delta: ${memoryDelta}MB`);
      
      return outputPath;
      
    } catch (error) {
      console.error(`${debugPrefix} Full download failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Memory-managed file download with progress monitoring
   */
  async _downloadFileWithMemoryManagement(cdnUrl, outputPath, lookupHash) {
    const debugPrefix = `[DOWNLOAD][${lookupHash}]`;
    
    return new Promise(async (resolve, reject) => {
      try {
        const response = await axios({
          method: 'get',
          url: cdnUrl,
          responseType: 'stream',
          timeout: 300000 // 5 minutes
        });
        
        const writer = fs.createWriteStream(outputPath);
        let downloadedBytes = 0;
        let lastMemoryCheck = Date.now();
        
        response.data.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          
          // Check memory every 10MB downloaded
          if (downloadedBytes % (10 * 1024 * 1024) === 0 || Date.now() - lastMemoryCheck > 5000) {
            if (this.checkMemoryPressure()) {
              writer.destroy();
              reject(new Error('Download aborted due to memory pressure'));
              return;
            }
            lastMemoryCheck = Date.now();
          }
        });
        
        response.data.pipe(writer);
        
        writer.on('finish', () => {
          console.log(`${debugPrefix} Downloaded ${Math.round(downloadedBytes / 1024 / 1024)}MB`);
          resolve();
        });
        
        writer.on('error', reject);
        response.data.on('error', reject);
        
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * FFmpeg extraction using HTTP range requests (no local download)
   */
  async _extractSegmentWithFFmpegRange(inputUrl, outputPath, startTime, endTime) {
    const debugPrefix = `[FFMPEG-RANGE][${Date.now()}]`;
    const duration = endTime - startTime;
    
    console.log(`${debugPrefix} Range-extracting ${duration}s from ${startTime}s to ${endTime}s`);
    
    return new Promise((resolve, reject) => {
      ffmpeg(inputUrl)
        .seekInput(startTime)
        .duration(duration)
        .outputOptions([
          '-y', // Overwrite output files
          '-c:v', 'libx264', // Video codec
          '-c:a', 'aac', // Audio codec
          '-movflags', '+faststart', // Optimize for streaming
          '-pix_fmt', 'yuv420p', // Ensure compatibility
          '-reconnect', '1', // Enable reconnection
          '-reconnect_streamed', '1', // Enable reconnection for streams
          '-reconnect_delay_max', '5' // Max reconnection delay
        ])
        .toFormat('mp4')
        .on('start', command => console.log(`${debugPrefix} FFmpeg started: ${command}`))
        .on('progress', progress => {
          if (progress.percent) {
            console.log(`${debugPrefix} Progress: ${progress.percent.toFixed(1)}%`);
          }
        })
        .on('error', err => {
          console.error(`${debugPrefix} FFmpeg error: ${err.message}`);
          reject(new Error(`Range extraction failed: ${err.message}`));
        })
        .on('end', () => {
          console.log(`${debugPrefix} Range extraction completed`);
          resolve();
        })
        .save(outputPath);
    });
  }

  /**
   * Background processing for video editing - Phase 1: Full download strategy
   * 
   * @param {string} cdnUrl - Source CDN URL
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds
   * @param {string} lookupHash - Unique identifier for this edit
   * @param {boolean} useSubtitles - Whether to include subtitles
   * @param {string} feedId - Feed ID for organizing uploads
   * @param {Array} clientSubtitles - Optional client-provided subtitles
   */
  async _backgroundProcessEdit(cdnUrl, startTime, endTime, lookupHash, useSubtitles = false, feedId = 'unknown', clientSubtitles = null) {
    const debugPrefix = `[EDIT-VIDEO-BG][${lookupHash}]`;
    console.log(`${debugPrefix} Starting Phase 2 background processing`);

    // Register this process for tracking
    const processInfo = {
      lookupHash,
      startTime: Date.now(),
      cdnUrl,
      editRange: `${startTime}s-${endTime}s`,
      memoryAtStart: this.getMemoryUsage()
    };
    this.activeProcesses.set(lookupHash, processInfo);

    let outputPath = null;

    try {
      // Update status to processing
      await WorkProductV2.findOneAndUpdate(
        { lookupHash },
        { 
          status: 'processing',
          'result.processingStrategy': 'phase2-smart'
        }
      );

      // Get file metadata for smart extraction strategy
      const fileMetadata = await this.validateCdnFile(cdnUrl);
      
      // Use smart extraction (Phase 2)
      console.log(`${debugPrefix} Using smart extraction strategy`);
      outputPath = await this._smartExtractSegment(cdnUrl, startTime, endTime, lookupHash, fileMetadata);

      console.log(`${debugPrefix} Segment extracted to: ${outputPath}`);

      // SUBTITLE PROCESSING FOR EDIT-VIDEO
      // DESIGN NOTE: This subtitle processing is specific to edit-video workflow.
      // It uses SRT + FFmpeg approach for performance. If we switch to Canvas rendering,
      // we would replace this section with SubtitleUtils.renderSubtitlesWithCanvas().
      
      let finalVideoPath = outputPath; // Default to extracted video
      
      if (useSubtitles) {
        console.log(`${debugPrefix} Processing subtitles for video edit`);
        
        try {
          // Step 1: Extract GUID from CDN URL (for fallback auto-generation)
          const guid = SubtitleUtils.extractGuidFromCdnUrl(cdnUrl);
          
          // Step 2: Process subtitles using new flexible method
          console.log(`${debugPrefix} Processing subtitles (client provided: ${!!clientSubtitles}, GUID available: ${!!guid})`);
          const subtitles = await SubtitleUtils.processSubtitlesForVideoEdit(clientSubtitles, guid, startTime, endTime);
          
          if (subtitles && subtitles.length > 0) {
            console.log(`${debugPrefix} Generated ${subtitles.length} subtitles`);
            
            // Step 3: Create SRT file
            const srtPath = path.join(os.tmpdir(), `${lookupHash}-subtitles.srt`);
            await SubtitleUtils.createSRTFile(subtitles, srtPath);
            
            // Step 4: Use FFmpeg to burn subtitles into video
            const videoWithSubtitlesPath = path.join(os.tmpdir(), `${lookupHash}-with-subtitles.mp4`);
            await this._extractSegmentWithSubtitles(outputPath, videoWithSubtitlesPath, srtPath);
            
            // Step 5: Update final video path and cleanup original
            finalVideoPath = videoWithSubtitlesPath;
            await this.cleanupTempFile(outputPath); // Clean up original extracted video
            
            console.log(`${debugPrefix} Subtitles successfully added to video`);
            
            // Extract text content from subtitles for clipText
            const clipText = SubtitleUtils.extractTextFromSubtitles(subtitles);
            console.log(`${debugPrefix} Extracted clipText (${clipText.length} chars): "${clipText.substring(0, 100)}${clipText.length > 100 ? '...' : ''}"`);
            
            // Update database with subtitle info and clipText
            await WorkProductV2.findOneAndUpdate(
              { lookupHash },
              { 
                'result.hasSubtitles': true,
                'result.subtitleCount': subtitles.length,
                'result.subtitleMethod': clientSubtitles ? 'client-provided' : 'auto-generated',
                'result.clipText': clipText,
                'result.textSource': 'subtitles'
              }
            );
            
          } else {
            console.log(`${debugPrefix} No subtitles found for the specified time range`);
            
            // Update database to indicate subtitle attempt was made
            await WorkProductV2.findOneAndUpdate(
              { lookupHash },
              { 
                'result.hasSubtitles': false,
                'result.subtitleCount': 0,
                'result.subtitleMethod': clientSubtitles ? 'client-provided' : 'auto-generated'
              }
            );
          }
          
        } catch (subtitleError) {
          console.error(`${debugPrefix} Subtitle processing failed: ${subtitleError.message}`);
          
          // Don't fail the entire operation if subtitles fail
          // Just log the error and continue without subtitles
          await WorkProductV2.findOneAndUpdate(
            { lookupHash },
            { 
              'result.hasSubtitles': false,
              'result.subtitleError': subtitleError.message,
              'result.subtitleMethod': clientSubtitles ? 'client-provided' : 'auto-generated'
            }
          );
        }
      }

      // Extract parent filename from CDN URL for directory structure
      const urlParts = cdnUrl.split('/');
      const parentFileName = urlParts[urlParts.length - 1];
      const parentFileBase = parentFileName.replace(/\.[^/.]+$/, ""); // Remove extension
      
      // Upload to CDN in parent-children structure
      const cdnFileId = `jamie-pro/${feedId}/uploads/${parentFileBase}-children/${lookupHash}.mp4`;
      
      // Read final video file with memory management
      if (this.checkMemoryPressure()) {
        throw new Error('Memory pressure too high for upload');
      }
      
      const outputBuffer = await fs.promises.readFile(finalVideoPath);
      
      const uploadedUrl = await this.spacesManager.uploadFile(
        process.env.SPACES_CLIP_BUCKET_NAME,
        cdnFileId,
        outputBuffer,
        'video/mp4'
      );

      console.log(`${debugPrefix} Uploaded to CDN: ${uploadedUrl}`);

      // Calculate processing metrics
      const endMemory = this.getMemoryUsage();
      const processingTime = Date.now() - processInfo.startTime;
      const memoryDelta = Math.round((endMemory.rss - processInfo.memoryAtStart.rss) / 1024 / 1024);

      // Update database with completion and metrics
      await WorkProductV2.findOneAndUpdate(
        { lookupHash },
        { 
          status: 'completed',
          cdnFileId: uploadedUrl,
          'result.completedAt': new Date(),
          'result.processingTimeMs': processingTime,
          'result.memoryDeltaMB': memoryDelta,
          'result.strategy': processInfo.strategy || 'smart-auto'
        }
      );

      // Cleanup temp files
      if (finalVideoPath && finalVideoPath !== outputPath) {
        await this.cleanupTempFile(finalVideoPath);
      }
      if (outputPath) {
        await this.cleanupTempFile(outputPath);
      }

      console.log(`${debugPrefix} Processing completed successfully in ${processingTime}ms, memory delta: ${memoryDelta}MB`);

    } catch (error) {
      console.error(`${debugPrefix} Processing failed: ${error.message}`);
      
      // Cleanup temp files on error
      if (outputPath) {
        await this.cleanupTempFile(outputPath);
      }
      
      // Update database with error
      await WorkProductV2.findOneAndUpdate(
        { lookupHash },
        { 
          status: 'failed',
          error: error.message,
          'result.failedAt': new Date()
        }
      ).catch(dbErr => console.error(`${debugPrefix} Failed to update error status: ${dbErr.message}`));
      
      throw error;
    } finally {
      // Remove from active processes
      this.activeProcesses.delete(lookupHash);
    }
  }

  /**
   * Get the duration of a video file using FFprobe
   * 
   * @param {string} filePath - Path to the video file
   * @returns {number} - Duration in seconds
   */
  async _getFileDuration(filePath) {
    const { promisify } = require('util');
    const exec = promisify(require('child_process').exec);
    
    try {
      const { stdout } = await exec(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
      );
      return parseFloat(stdout.trim());
    } catch (error) {
      throw new Error(`Failed to get file duration: ${error.message}`);
    }
  }

  /**
   * Get processing statistics and memory usage
   */
  getProcessingStats() {
    const usage = this.getMemoryUsage();
    return {
      memoryUsage: {
        rss: Math.round(usage.rss / 1024 / 1024), // MB
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
        external: Math.round(usage.external / 1024 / 1024) // MB
      },
      activeProcesses: this.activeProcesses.size,
      trackedTempFiles: this.tempFiles.size,
      config: {
        maxMemoryMB: Math.round(this.memoryConfig.maxMemoryUsage / 1024 / 1024),
        largeFileThresholdMB: Math.round(this.memoryConfig.largeFileThreshold / 1024 / 1024),
        maxConcurrent: this.memoryConfig.maxConcurrentProcessing
      },
      activeProcessDetails: Array.from(this.activeProcesses.values()).map(process => ({
        lookupHash: process.lookupHash,
        editRange: process.editRange,
        runningTimeMs: Date.now() - process.startTime,
        startMemoryMB: Math.round(process.memoryAtStart.rss / 1024 / 1024)
      }))
    };
  }
  
  /**
   * Graceful shutdown - cleanup all resources
   */
  async shutdown() {
    const debugPrefix = `[CLIPUTILS-SHUTDOWN]`;
    console.log(`${debugPrefix} Starting graceful shutdown`);
    
    try {
      // Stop memory management
      this.stopMemoryManagement();
      
      // Wait for active processes to complete (with timeout)
      const maxWaitMs = 30000; // 30 seconds
      const startWait = Date.now();
      
      while (this.activeProcesses.size > 0 && (Date.now() - startWait) < maxWaitMs) {
        console.log(`${debugPrefix} Waiting for ${this.activeProcesses.size} active processes to complete...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      if (this.activeProcesses.size > 0) {
        console.warn(`${debugPrefix} ${this.activeProcesses.size} processes still active after timeout`);
      }
      
      // Cleanup all tracked temp files
      const tempFileArray = Array.from(this.tempFiles);
      console.log(`${debugPrefix} Cleaning up ${tempFileArray.length} temp files`);
      
      await Promise.all(tempFileArray.map(async (filePath) => {
        try {
          await this.cleanupTempFile(filePath);
        } catch (error) {
          console.warn(`${debugPrefix} Failed to cleanup ${filePath}: ${error.message}`);
        }
      }));
      
      console.log(`${debugPrefix} Shutdown completed`);
      
    } catch (error) {
      console.error(`${debugPrefix} Shutdown error: ${error.message}`);
    }
  }

  /**
   * Extract a video segment using FFmpeg
   * 
   * @param {string} inputPath - Path to source file
   * @param {string} outputPath - Path for output file
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds
   */
  async _extractSegmentWithFFmpeg(inputPath, outputPath, startTime, endTime) {
    const debugPrefix = `[FFMPEG-EXTRACT][${Date.now()}]`;
    const duration = endTime - startTime;

    console.log(`${debugPrefix} Extracting ${duration}s segment from ${startTime}s to ${endTime}s`);

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions([
          '-ss', startTime.toString(), // Accurate seeking
          '-accurate_seek' // Enable accurate seeking to avoid keyframe issues
        ])
        .duration(duration)
        .outputOptions([
          '-y', // Overwrite output files
          '-c:v', 'libx264', // Video codec
          '-c:a', 'aac', // Audio codec  
          '-movflags', '+faststart', // Optimize for streaming
          '-pix_fmt', 'yuv420p' // Ensure compatibility
        ])
        .toFormat('mp4')
        .on('start', command => console.log(`${debugPrefix} FFmpeg started: ${command}`))
        .on('progress', progress => {
          if (progress.percent) {
            console.log(`${debugPrefix} Progress: ${progress.percent.toFixed(1)}%`);
          }
        })
        .on('error', err => {
          console.error(`${debugPrefix} FFmpeg error: ${err.message}`);
          reject(new Error(`Video processing failed: ${err.message}`));
        })
        .on('end', () => {
          console.log(`${debugPrefix} FFmpeg extraction completed`);
          resolve();
        })
        .save(outputPath);
    });
  }

  /**
   * Burn subtitles into a video using FFmpeg's subtitle filter
   * 
   * DESIGN NOTE: This method uses FFmpeg's subtitle filter for performance.
   * If we switch to Canvas rendering, this method would be replaced with
   * a call to SubtitleUtils.renderSubtitlesWithCanvas().
   * 
   * @param {string} inputPath - Path to source video file
   * @param {string} outputPath - Path for output video with subtitles
   * @param {string} srtPath - Path to SRT subtitle file
   */
  async _extractSegmentWithSubtitles(inputPath, outputPath, srtPath) {
    const debugPrefix = `[FFMPEG-SUBTITLES][${Date.now()}]`;
    console.log(`${debugPrefix} Burning subtitles into video`);

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-y', // Overwrite output files
          '-vf', `subtitles=${srtPath.replace(/\\/g, '/')}:force_style='FontSize=24,Bold=1,FontName=Impact,PrimaryColour=&H00FFFFFF,OutlineColour=&H00303030,Outline=0.5,Shadow=0,MarginV=30,Alignment=2'`, // Large Impact font, white text, subtle dark gray outline, centered at bottom
          '-c:v', 'libx264', // Video codec
          '-c:a', 'aac', // Audio codec
          '-movflags', '+faststart', // Optimize for streaming
          '-pix_fmt', 'yuv420p', // Ensure compatibility
          '-sn' // Strip any existing subtitle streams from input
        ])
        .toFormat('mp4')
        .on('start', command => console.log(`${debugPrefix} FFmpeg started: ${command}`))
        .on('progress', progress => {
          if (progress.percent) {
            console.log(`${debugPrefix} Progress: ${progress.percent.toFixed(1)}%`);
          }
        })
        .on('error', err => {
          console.error(`${debugPrefix} FFmpeg subtitle error: ${err.message}`);
          reject(new Error(`Subtitle processing failed: ${err.message}`));
        })
        .on('end', () => {
          console.log(`${debugPrefix} FFmpeg subtitle processing completed`);
          resolve();
        })
        .save(outputPath);
    });
  }

}

module.exports = ClipUtils;