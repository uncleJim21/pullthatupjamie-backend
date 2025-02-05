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
      process.env.SPACES_CLIP_SECRET_KEY
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

    const outputPath = `/tmp/clip-${Date.now()}.mp3`; // Ensure temp path is valid
    console.log(`[DEBUG] Extracting audio to: ${outputPath}`);

    return new Promise((resolve, reject) => {
        if (!audioUrl) {
            console.error('[ERROR] extractAudioClip - Missing audio URL!');
            return reject(new Error('extractAudioClip failed: Missing audio URL'));
        }

        ffmpeg(audioUrl)
            .setStartTime(startTime)
            .setDuration(endTime - startTime)
            .audioCodec('libmp3lame')
            .toFormat('mp3')
            .on('start', command => console.log('[DEBUG] FFmpeg started:', command))
            .on('progress', progress => console.log('[DEBUG] FFmpeg progress:', progress.percent?.toFixed(2) + '%'))
            .on('error', err => {
                console.error('[ERROR] FFmpeg processing failed:', err);
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
    try {
      const response = await axios({
        url,
        responseType: 'arraybuffer',
        timeout: 10000, // 10 second timeout
        validateStatus: status => status === 200 // Only accept 200 status
      });
      
      const tempPath = path.join(os.tmpdir(), `temp-${Date.now()}.jpg`);
      await fs.promises.writeFile(tempPath, response.data);
      console.log('Image downloaded successfully to:', tempPath);
      return tempPath;
    } catch (error) {
      console.error('Error downloading image:', error.message);
      throw new Error(`Failed to download image: ${error.message}`);
    }
  }

  async generateShareableVideo(clipData, audioPath) {
    let profileImagePath = null;
    console.log('Starting video generation process');
    
    try {
      console.log('Downloading profile image...');
      profileImagePath = await this.downloadImage(clipData.episodeImage);
      
      const watermarkPath = path.join(__dirname, '../assets/watermark.png');
      console.log('Checking watermark existence...');
      if (!fs.existsSync(watermarkPath)) {
        throw new Error('Watermark file not found at: ' + watermarkPath);
      }

      const outputPath = path.join(os.tmpdir(), `${clipData.shareLink}.mp4`);
      console.log('Video will be saved to:', outputPath);

      const generator = new VideoGenerator({
        audioPath,
        profileImagePath,
        watermarkPath,
        title: this.truncateMiddle(clipData.creator,40),
        subtitle: this.truncateMiddle(clipData.episode,40),
        outputPath
      });

      console.log('Starting video generation...');
      await generator.generateVideo();
      console.log('Video generation completed');
      
      return outputPath;
    } catch (error) {
      console.error('Error in video generation:', error);
      throw error;
    } finally {
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
                return existingClip.cdnFileId;
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
            timestamps?.[0] || clipData.timeContext.start_time,
            timestamps?.[1] || clipData.timeContext.end_time
        );

        console.log(`[DEBUG] Generating video for ${lookupHash}`);
        const videoPath = await this.generateShareableVideo(clipData, audioPath);

        console.log(`[DEBUG] Uploading to CDN for ${lookupHash}`);
        const cdnFileId = `clips/${clipData.additionalFields.feedId}/${clipData.additionalFields.guid}-clip.mp4`;

        const videoBuffer = await fs.promises.readFile(videoPath);
        const uploadedUrl = await this.spacesManager.uploadFile(
            process.env.SPACES_CLIP_BUCKET_NAME,
            cdnFileId,
            videoBuffer,
            'video/mp4'
        );

        console.log(`[DEBUG] Upload successful for ${lookupHash}: ${uploadedUrl}`);

        // ✅ Update MongoDB with final URL
        await WorkProductV2.findOneAndUpdate({ lookupHash }, { cdnFileId: uploadedUrl });

        console.log(`[DEBUG] Processing complete for ${lookupHash}`);
    } catch (error) {
        console.error(`[ERROR] _backgroundProcessClip CRASHED for ${lookupHash}:`, error);
    }
  }

}

module.exports = ClipUtils;