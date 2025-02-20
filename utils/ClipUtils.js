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

  async generateShareableVideo(clipData, audioPath) {
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
        
        // Create new instance for this specific video
        videoGenerator = new VideoGenerator({
            audioPath,
            profileImagePath,
            watermarkPath,
            title: this.truncateMiddle(clipData.creator, 30),
            subtitle: this.truncateMiddle(clipData.episode, 80),
            outputPath
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
   * @returns {string} - lookupHash to poll.
   */
  async processClip(clipData, timestamps = null) {
    console.log(`[DEBUG] processClip started for: ${JSON.stringify(clipData,null,2)}`);

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
        });

        console.log(`[DEBUG] WorkProductV2 entry created for ${lookupHash}`);

        // ✅ Return lookupHash immediately
        const response = { status: 'processing', lookupHash };

        // 🚀 Force background job to run immediately
        this._backgroundProcessClip(clipData, timestamps, lookupHash).catch(err => {
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
   */
  async _backgroundProcessClip(clipData, timestamps, lookupHash) {
    console.log(`[DEBUG] _backgroundProcessClip STARTED for ${lookupHash}`);
    
    try {
        console.log(`[HARD DEBUG] _backgroundProcessClip running at:`, new Date().toISOString());

        // Force an initial log to prove it's running
        console.log(`[DEBUG] Extracting audio for ${lookupHash}`);

        const audioPath = await this.extractAudioClip(
          clipData.audioUrl,
          timestamps?.[0] ?? clipData.timeContext?.start_time ?? 0,
          timestamps?.[1] ?? clipData.timeContext?.end_time ?? (clipData.timeContext?.start_time + 30) // fallback to 30 sec clip
      );
        console.log(`[DEBUG] Generating video for ${lookupHash}`);
        const { videoPath, videoGenerator } = await this.generateShareableVideo(clipData, audioPath);


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

        // ✅ Update MongoDB with final URL
        await WorkProductV2.findOneAndUpdate({ lookupHash }, { cdnFileId: uploadedUrl });
        

        // Determine first frame
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
        
            // ✅ Update MongoDB with preview URL
            const updatedClip = await WorkProductV2.findOneAndUpdate(
                { lookupHash },
                { 
                    $set: { 
                        cdnFileId: uploadedUrl, // ✅ Keep cdnFileId at the top level
                        "result.previewImageId": previewUploadedUrl // ✅ Store previewImageId inside result
                    }
                },
                { new: true, upsert: true }
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