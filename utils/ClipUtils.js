const ffmpeg = require('fluent-ffmpeg');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs');
const axios = require('axios');
const VideoGenerator = require('./VideoGenerator');
const DigitalOceanSpacesManager = require('./DigitalOceanSpacesManager');
const { WorkProductV2, calculateLookupHash } = require('../models/WorkProductV2');


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
        
        // Wait for video generation to complete before proceeding
        console.log(`[DEBUG] Waiting for video generation to complete for ${lookupHash}`);
        await videoGenerator.generateVideo();
        
        // Verify the video file exists and is complete
        if (!fs.existsSync(videoPath)) {
            throw new Error(`Video file not found at ${videoPath} after generation completed`);
        }
        
        // Get file stats to ensure it's not empty
        const stats = fs.statSync(videoPath);
        if (stats.size === 0) {
            throw new Error(`Generated video file is empty: ${videoPath}`);
        }
        
        console.log(`[DEBUG] Video generation complete for ${lookupHash}. File size: ${stats.size} bytes`);
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

}

module.exports = ClipUtils;