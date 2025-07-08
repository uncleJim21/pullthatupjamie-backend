// test-subtitles.js
require('dotenv').config();
const path = require('path');
const VideoGenerator = require('./utils/VideoGenerator');
const fs = require('fs');

// Sample subtitles in the format provided
const sampleSubtitles = [
  {
    "start": 0,
    "end": 0.5,
    "text": "I"
  },
  {
    "start": 0.5,
    "end": 1.0,
    "text": "think"
  },
  {
    "start": 1.0,
    "end": 1.5,
    "text": "there's"
  },
  {
    "start": 1.5,
    "end": 2.0,
    "text": "circa"
  },
  {
    "start": 2.0,
    "end": 2.5,
    "text": "2,000"
  },
  {
    "start": 2.5,
    "end": 3.0,
    "text": "trillion"
  },
  {
    "start": 3.0,
    "end": 3.5,
    "text": "dollars"
  },
  {
    "start": 3.5,
    "end": 4.0,
    "text": "at"
  },
  {
    "start": 4.0,
    "end": 4.5,
    "text": "the"
  }
];

async function testSubtitles() {
  try {
    console.log('Starting subtitle test...');
    
    // Create assets directory if it doesn't exist
    if (!fs.existsSync('./assets')) {
      console.log('Creating assets directory...');
      fs.mkdirSync('./assets', { recursive: true });
    }
    
    // Create output directory if it doesn't exist
    if (!fs.existsSync('./output')) {
      console.log('Creating output directory...');
      fs.mkdirSync('./output', { recursive: true });
    }
    
    // Check for required files and use defaults if they don't exist
    const audioPath = './assets/sample-audio.mp3';
    let useDefaultAudio = false;
    
    if (!fs.existsSync(audioPath)) {
      console.log('Sample audio file not found. Please add an MP3 file to ./assets/sample-audio.mp3');
      return;
    }
    
    const profileImagePath = './assets/profile-image.jpg';
    if (!fs.existsSync(profileImagePath)) {
      console.log('Profile image not found. Please add a JPG file to ./assets/profile-image.jpg');
      return;
    }
    
    const watermarkPath = './assets/watermark.png';
    if (!fs.existsSync(watermarkPath)) {
      console.log('Watermark image not found. Please add a PNG file to ./assets/watermark.png');
      return;
    }
    
    const outputPath = './output/test-subtitles.mp4';
    
    console.log('Creating VideoGenerator with these parameters:');
    console.log(`- Audio: ${audioPath}`);
    console.log(`- Profile Image: ${profileImagePath}`);
    console.log(`- Watermark: ${watermarkPath}`);
    console.log(`- Output: ${outputPath}`);
    console.log(`- Subtitles: ${sampleSubtitles.length} items`);
    
    // Create VideoGenerator instance with subtitles
    const videoGenerator = new VideoGenerator({
      audioPath,
      profileImagePath,
      watermarkPath,
      title: 'Test Podcast',
      subtitle: 'Testing Subtitles Feature',
      outputPath,
      creator: 'Test Creator',
      subtitles: sampleSubtitles, // Pass the subtitles
      frameRate: 30 // Use higher frame rate for smoother subtitle display
    });
    
    console.log('Generating video with subtitles...');
    await videoGenerator.generateVideo();
    console.log('Video generation completed!');
    console.log(`Video saved to: ${outputPath}`);
    
  } catch (error) {
    console.error('Error in subtitle test:', error);
  }
}

// Export the sample subtitles for potential inspection
module.exports = {
  sampleSubtitles,
  testSubtitles
};

// Run the test if this script is executed directly
if (require.main === module) {
  testSubtitles().catch(console.error);
} 