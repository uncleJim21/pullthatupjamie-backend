// test-server-subtitles.js
require('dotenv').config();
const path = require('path');
const VideoGenerator = require('./utils/VideoGenerator');
const fs = require('fs');
const ClipUtils = require('./utils/ClipUtils');

// This mimics the server-side subtitle generation function
function generateSubtitlesForClip(startTime = 0, endTime = 10) {
  console.log(`Generating subtitles for clip from ${startTime}s to ${endTime}s`);
  
  // Create subtitles spanning the entire clip duration with 1-second intervals
  const subtitles = [];
  const words = [
    "I", "think", "there's", "circa", "2,000", "trillion", 
    "dollars", "at", "the", "moment", "in", "global", "wealth", 
    "across", "all", "asset", "classes"
  ];
  
  // Generate subtitles at regular intervals
  for (let i = 0; i < words.length && i < Math.floor(endTime - startTime); i++) {
    subtitles.push({
      // Create timestamps relative to clip start (they'll be adjusted in ClipUtils)
      start: startTime + i,
      end: startTime + i + 0.9, // 0.9 seconds per word
      text: words[i]
    });
  }
  
  console.log(`Generated ${subtitles.length} subtitles for clip`);
  return subtitles;
}

async function testServerSubtitles() {
  try {
    console.log('Starting server-side subtitle test...');
    
    // Ensure test setup is done
    if (!fs.existsSync('./assets') || 
        !fs.existsSync('./assets/sample-audio.mp3') ||
        !fs.existsSync('./assets/profile-image.jpg') ||
        !fs.existsSync('./assets/watermark.png')) {
      console.log('Please run setup first: npm run setup-subtitle-test');
      return;
    }
    
    if (!fs.existsSync('./output')) {
      fs.mkdirSync('./output', { recursive: true });
    }
    
    // Check for required files
    const audioPath = './assets/sample-audio.mp3';
    const profileImagePath = './assets/profile-image.jpg';
    const watermarkPath = './assets/watermark.png';
    const outputPath = './output/test-server-subtitles.mp4';
    
    // Define clip start and end time
    const startTime = 0;
    const endTime = 10; // 10 seconds
    
    // Generate server-side subtitles
    console.log('Generating server-side subtitles...');
    const subtitles = generateSubtitlesForClip(startTime, endTime);
    
    // Create mock clip data like a real server would have
    const mockClipData = {
      shareLink: 'test-server-subtitles',
      creator: 'Test Podcast',
      episode: 'Testing Server-side Subtitles Feature',
      episodeImage: profileImagePath,
      audioUrl: audioPath,
      timeContext: {
        start_time: startTime,
        end_time: endTime
      },
      additionalFields: {
        feedId: 'test-feed',
        guid: 'test-guid'
      }
    };
    
    // Use ClipUtils similar to how the server would
    console.log('Creating clip using ClipUtils...');
    const clipUtils = new ClipUtils();
    
    // Extract audio
    console.log('Extracting audio clip...');
    const extractedAudioPath = await clipUtils.extractAudioClip(
      audioPath, 
      startTime, 
      endTime
    );
    
    console.log('Generating video with ClipUtils.generateShareableVideo...');
    const { videoPath } = await clipUtils.generateShareableVideo(
      mockClipData,
      extractedAudioPath,
      subtitles
    );
    
    // Copy the result to our output directory for easier viewing
    if (fs.existsSync(videoPath)) {
      fs.copyFileSync(videoPath, outputPath);
      console.log(`Video copied to ${outputPath}`);
    }
    
    console.log('Video generation completed!');
    
  } catch (error) {
    console.error('Error in server subtitle test:', error);
  }
}

if (require.main === module) {
  testServerSubtitles().catch(console.error);
}

module.exports = {
  generateSubtitlesForClip,
  testServerSubtitles
}; 