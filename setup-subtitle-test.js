// setup-subtitle-test.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function setupTestEnvironment() {
  console.log('Setting up test environment for subtitles...');
  
  // Create directories
  const directories = ['./assets', './output'];
  directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
      console.log(`Creating directory: ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  // Create a sample watermark if it doesn't exist
  const watermarkPath = './assets/watermark.png';
  if (!fs.existsSync(watermarkPath)) {
    console.log('Creating sample watermark...');
    const canvas = require('canvas');
    const { createCanvas } = canvas;
    
    const canvasWidth = 320;
    const canvasHeight = 80;
    const c = createCanvas(canvasWidth, canvasHeight);
    const ctx = c.getContext('2d');
    
    // Fill with black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    
    // Add "Test Watermark" text
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Test Watermark', canvasWidth/2, canvasHeight/2 + 8);
    
    const buffer = c.toBuffer('image/png');
    fs.writeFileSync(watermarkPath, buffer);
    console.log(`Created sample watermark at ${watermarkPath}`);
  }
  
  // Create a sample profile image if it doesn't exist
  const profileImagePath = './assets/profile-image.jpg';
  if (!fs.existsSync(profileImagePath)) {
    console.log('Creating sample profile image...');
    const canvas = require('canvas');
    const { createCanvas } = canvas;
    
    const canvasSize = 400;
    const c = createCanvas(canvasSize, canvasSize);
    const ctx = c.getContext('2d');
    
    // Fill with a gradient
    const gradient = ctx.createLinearGradient(0, 0, canvasSize, canvasSize);
    gradient.addColorStop(0, '#FF5722');   // Orange-red
    gradient.addColorStop(1, '#2196F3');   // Blue
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvasSize, canvasSize);
    
    // Add circular indicator in the middle
    ctx.beginPath();
    ctx.arc(canvasSize/2, canvasSize/2, canvasSize/4, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    
    // Add text
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Test', canvasSize/2, canvasSize/2 - 5);
    ctx.fillText('Profile', canvasSize/2, canvasSize/2 + 35);
    
    const buffer = c.toBuffer('image/jpeg');
    fs.writeFileSync(profileImagePath, buffer);
    console.log(`Created sample profile image at ${profileImagePath}`);
  }

  // Create a sample audio file if it doesn't exist
  const audioPath = './assets/sample-audio.mp3';
  if (!fs.existsSync(audioPath)) {
    console.log('Generating a sample audio file...');
    try {
      // Method 1: Download a sample audio file
      const https = require('https');
      const url = 'https://www2.cs.uic.edu/~i101/SoundFiles/CantinaBand3.wav';
      
      const downloadFile = (url, dest) => {
        return new Promise((resolve, reject) => {
          const file = fs.createWriteStream(dest);
          https.get(url, response => {
            response.pipe(file);
            file.on('finish', () => {
              file.close(resolve);
              console.log(`Downloaded sample audio to ${dest}`);
            });
          }).on('error', err => {
            fs.unlink(dest, () => {}); // Delete the file if there was an error
            reject(err);
          });
        });
      };

      const tempWavPath = './assets/temp.wav';
      await downloadFile(url, tempWavPath);
      
      // Convert WAV to MP3 using ffmpeg
      if (fs.existsSync(tempWavPath)) {
        console.log('Converting WAV to MP3...');
        try {
          execSync(`ffmpeg -y -i "${tempWavPath}" -codec:a libmp3lame -qscale:a 2 "${audioPath}"`, {stdio: 'inherit'});
          console.log(`Created MP3 file at ${audioPath}`);
          
          // Delete the temporary WAV file
          fs.unlinkSync(tempWavPath);
        } catch (error) {
          console.error('Error converting to MP3:', error.message);
          console.log('Please install ffmpeg or manually add an MP3 file to ./assets/sample-audio.mp3');
        }
      }
    } catch (error) {
      console.error('Error downloading sample audio:', error.message);
      console.log('Please manually add an MP3 file to ./assets/sample-audio.mp3');
    }
  }

  console.log('\nSetup complete! You can now run:');
  console.log('  npm run test-subtitles');
}

setupTestEnvironment().catch(console.error); 