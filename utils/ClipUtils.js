const ffmpeg = require('fluent-ffmpeg');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs');
const axios = require('axios');
const VideoGenerator = require('./VideoGenerator');
const DigitalOceanSpacesManager = require('./DigitalOceanSpacesManager');

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

  async extractAudioClip(audioUrl, startTime, endTime, outputPath) {
    console.log('Starting audio extraction...', { startTime, endTime });
    
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(audioUrl)
        .setStartTime(startTime)
        .setDuration(endTime - startTime)
        .audioCodec('libmp3lame')
        .toFormat('mp3')
        .on('start', command => {
          console.log('FFmpeg process started:', command);
        })
        .on('progress', progress => {
          console.log('Audio extraction progress:', progress.percent?.toFixed(2) + '%');
        })
        .on('end', () => {
          console.log('Audio extraction completed');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
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
        title: this.truncateMiddle(clipData.creator,25),
        subtitle: this.truncateMiddle(clipData.episode,30),
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

  async processClip(clipData) {
    console.log('Starting clip processing:', clipData.shareLink);
    const tmpDir = os.tmpdir();
    const audioPath = path.join(tmpDir, `${clipData.shareLink}.mp3`);
    let videoPath = null;
    
    try {
      // Step 1: Extract audio
      console.log('Step 1: Extracting audio clip');
      await this.extractAudioClip(
        clipData.audioUrl,
        clipData.timeContext.start_time,
        clipData.timeContext.end_time,
        audioPath
      );

      // Step 2: Generate video
      console.log('Step 2: Generating shareable video');
      videoPath = await this.generateShareableVideo(clipData, audioPath);

      // Step 3: Upload to CDN
      console.log('Step 3: Uploading to CDN');
      const fileName = `clips/${clipData.shareLink}.mp4`;
      const videoBuffer = await fs.promises.readFile(videoPath);
      console.log('Video file read, size:', videoBuffer.length);
      
      const videoUrl = await this.spacesManager.uploadFile(
        process.env.SPACES_CLIP_BUCKET_NAME,
        fileName,
        videoBuffer,
        'video/mp4'
      );
      
      console.log('Upload completed:', videoUrl);
      return videoUrl;
    } catch (error) {
      console.error('Error processing clip:', error);
      throw error;
    } finally {
      // Cleanup
      const cleanupPromises = [];
      
      if (fs.existsSync(audioPath)) {
        cleanupPromises.push(
          fs.promises.unlink(audioPath)
            .then(() => console.log('Cleaned up audio file:', audioPath))
            .catch(err => console.error('Error cleaning up audio:', err))
        );
      }
      
      if (videoPath && fs.existsSync(videoPath)) {
        cleanupPromises.push(
          fs.promises.unlink(videoPath)
            .then(() => console.log('Cleaned up video file:', videoPath))
            .catch(err => console.error('Error cleaning up video:', err))
        );
      }
      
      if (cleanupPromises.length > 0) {
        await Promise.all(cleanupPromises).catch(error => {
          console.error('Cleanup error:', error);
        });
      }
    }
  }
}

module.exports = ClipUtils;