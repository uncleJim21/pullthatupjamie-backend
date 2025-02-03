const { createCanvas, loadImage } = require('canvas');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { join } = require('path');
const wav = require('wav');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

class VideoGenerator {
  constructor(options) {
    // Required options
    this.audioPath = options.audioPath;
    this.profileImagePath = options.profileImagePath;
    this.title = options.title;
    this.subtitle = options.subtitle;
    this.outputPath = options.outputPath;
    this.watermarkPath = options.watermarkPath;

    // Optional configurations
    this.frameRate = options.frameRate || 20;
    this.canvas = createCanvas(1280, 720);
    this.ctx = this.canvas.getContext('2d');
    this.framesDir = join(__dirname, 'frames');
    this.tempWavPath = join(__dirname, 'temp.wav');

    // Design configurations
    this.profileImageSize = 200;  // Size of the profile image
    this.profileImageRadius = 50;  // Border radius
    this.profileImageBorderColor = '#333333';
    this.profileImageBorderWidth = 4;
    this.textColor = '#FFFFFF';
  }

  async convertToWav() {
    await exec(`ffmpeg -y -i "${this.audioPath}" -acodec pcm_s16le -ar 44100 -map_metadata -1 "${this.tempWavPath}"`);
    return this.tempWavPath;
  }

  async getDuration(filePath) {
    const { stdout } = await exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    return parseFloat(stdout);
  }

  async getAudioData() {
    return new Promise((resolve, reject) => {
      const reader = new wav.Reader();
      const audioData = [];

      reader.on('format', format => {
        reader.on('data', buffer => {
          const float32Array = new Float32Array(buffer.length / 2);
          for (let i = 0; i < buffer.length; i += 2) {
            float32Array[i / 2] = buffer.readInt16LE(i) / 32768.0;
          }
          audioData.push(...float32Array);
        });
      });

      reader.on('end', () => resolve(new Float32Array(audioData)));
      reader.on('error', reject);

      fs.createReadStream(this.audioPath).pipe(reader);
    });
  }

  calculateFrequencies(audioData, bands) {
    const blockSize = Math.floor(audioData.length / bands);
    const frequencies = new Float32Array(bands);

    for (let i = 0; i < bands; i++) {
      const start = i * blockSize;
      const end = start + blockSize;
      let sum = 0;

      for (let j = start; j < end; j++) {
        sum += audioData[j] * audioData[j];
      }

      frequencies[i] = Math.sqrt(sum / blockSize);
    }

    return frequencies;
  }

  drawRoundedImage(image, x, y, width, height, radius, borderColor, borderWidth) {
    this.ctx.save();
    
    // Create clipping path for rounded corners
    this.ctx.beginPath();
    this.ctx.moveTo(x + radius, y);
    this.ctx.lineTo(x + width - radius, y);
    this.ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    this.ctx.lineTo(x + width, y + height - radius);
    this.ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    this.ctx.lineTo(x + radius, y + height);
    this.ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    this.ctx.lineTo(x, y + radius);
    this.ctx.quadraticCurveTo(x, y, x + radius, y);
    this.ctx.closePath();
    
    // Draw border
    this.ctx.strokeStyle = borderColor;
    this.ctx.lineWidth = borderWidth;
    this.ctx.stroke();
    
    // Clip and draw image
    this.ctx.clip();
    this.ctx.drawImage(image, x, y, width, height);
    
    this.ctx.restore();
  }

  renderFrame(profileImage, watermarkImage, frequencyData) {
    const { width, height } = this.canvas;
  
    // Clear canvas
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, width, height);
  
    // Adjust everything on the left side to shift up 40px
    const shiftUp = -40;
  
    // Draw profile image with border radius and outline
    const padding = 40;
    const profileImageAreaWidth = width / 2; // Left half of the screen
    const profileImageWidth = profileImageAreaWidth * (2 / 3); // Take up 2/3 of the left half
    const profileImageHeight = profileImageWidth; // Square image
    const profileImageX = (profileImageAreaWidth - profileImageWidth) / 2; // Center horizontally in the left half
    const profileImageY = (height - profileImageHeight) / 2 + shiftUp; // Center vertically with shift up
  
    this.drawRoundedImage(
      profileImage,
      profileImageX,
      profileImageY,
      profileImageWidth,
      profileImageHeight,
      this.profileImageRadius,
      this.profileImageBorderColor,
      this.profileImageBorderWidth
    );
  
    // Draw watermark in top right with correct aspect ratio
    const watermarkWidth = 200; // Adjust as needed for your canvas size
    const watermarkHeight = (watermarkImage.height / watermarkImage.width) * watermarkWidth; // Maintain aspect ratio
    const watermarkPadding = 20;
    this.ctx.drawImage(
      watermarkImage,
      width - watermarkWidth - watermarkPadding,
      watermarkPadding,
      watermarkWidth,
      watermarkHeight
    );
  
    // Center text (title and subtitle) relative to the profile image
    this.ctx.textAlign = 'center';
    this.ctx.fillStyle = this.textColor;
  
    // Draw title centered above the profile image
    this.ctx.font = 'bold 30px Arial';
    const titleY = profileImageY + profileImageHeight + 40; // Slightly above the profile image
    this.ctx.fillText(this.title, profileImageX + profileImageWidth / 2, titleY);
  
    // Draw subtitle centered below the profile image
    this.ctx.font = '24px Arial';
    const subtitleY = profileImageY + profileImageHeight + 80; // Slightly below the profile image
    this.ctx.fillText(this.subtitle, profileImageX + profileImageWidth / 2, subtitleY);
  
    // Position waveform in the right half of the screen
    const waveAreaWidth = width / 2 - padding * 2; // Use half the screen width (right half)
    const startX = width / 2 + padding; // Start after the midpoint with padding
    const waveformHeight = (2 / 3) * height; // Make the waveform 2/3 the height of the canvas
    const waveformCenterY = height / 2; // Center vertically
    const pointCount = frequencyData.length;
    const pointSpacing = waveAreaWidth / (pointCount - 1);
  
    // Max height of the waveform
    const maxWaveHeight = waveformHeight / 2;
  
    // Create gradient
    const gradient = this.ctx.createLinearGradient(0, waveformCenterY - maxWaveHeight, 0, waveformCenterY + maxWaveHeight);
    gradient.addColorStop(0, '#FFFFFF');
    gradient.addColorStop(0.4, '#fff1e6');
    gradient.addColorStop(0.75, '#ffa366');  // Soft orange
    gradient.addColorStop(1, '#f84c1f');    // Original deep red-orange

    // const gradient = this.ctx.createLinearGradient(0, waveformCenterY - maxWaveHeight, 0, waveformCenterY + maxWaveHeight);
    // gradient.addColorStop(0, '#FFFFFF');
    // gradient.addColorStop(0.4, '#e6ffe6');
    // gradient.addColorStop(0.75, '#66ffb3');  // Soft mint green
    // gradient.addColorStop(1, '#00804d');    // Deep emerald
  
    this.ctx.fillStyle = gradient;
    this.ctx.beginPath();
  
    // Amplification factor
    const amplification = 2.0;
    const smoothingFactor = 0.4;
  
    // Generate points for top curve
    const points = [];
    for (let i = 0; i < pointCount; i++) {
      const x = startX + (i * pointSpacing);
      const normalizedAmplitude = Math.min(frequencyData[i] * amplification, 1);
      const amplitude = normalizedAmplitude * maxWaveHeight;
      points.push({
        x: x,
        y: waveformCenterY - amplitude
      });
    }
  
    // Draw top curve
    this.ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 2; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
  
      const ctrl1x = points[i].x - (points[i].x - points[i - 1].x) * smoothingFactor;
      const ctrl1y = points[i].y - (points[i].y - points[i - 1].y) * smoothingFactor;
      const ctrl2x = xc - (xc - points[i].x) * smoothingFactor;
      const ctrl2y = yc - (yc - points[i].y) * smoothingFactor;
  
      this.ctx.bezierCurveTo(ctrl1x, ctrl1y, ctrl2x, ctrl2y, xc, yc);
    }
  
    // Connect to last point of top curve
    this.ctx.quadraticCurveTo(
      points[points.length - 2].x,
      points[points.length - 2].y,
      points[points.length - 1].x,
      points[points.length - 1].y
    );
  
    // Generate and draw bottom curve (mirror of top)
    const bottomPoints = points.map(p => ({
      x: p.x,
      y: waveformCenterY + (waveformCenterY - p.y)
    })).reverse();
  
    for (let i = 1; i < bottomPoints.length - 2; i++) {
      const xc = (bottomPoints[i].x + bottomPoints[i + 1].x) / 2;
      const yc = (bottomPoints[i].y + bottomPoints[i + 1].y) / 2;
  
      const ctrl1x = bottomPoints[i].x - (bottomPoints[i].x - bottomPoints[i - 1].x) * smoothingFactor;
      const ctrl1y = bottomPoints[i].y - (bottomPoints[i].y - bottomPoints[i - 1].y) * smoothingFactor;
      const ctrl2x = xc - (xc - bottomPoints[i].x) * smoothingFactor;
      const ctrl2y = yc - (yc - bottomPoints[i].y) * smoothingFactor;
  
      this.ctx.bezierCurveTo(ctrl1x, ctrl1y, ctrl2x, ctrl2y, xc, yc);
    }
  
    this.ctx.quadraticCurveTo(
      bottomPoints[bottomPoints.length - 2].x,
      bottomPoints[bottomPoints.length - 2].y,
      bottomPoints[bottomPoints.length - 1].x,
      bottomPoints[bottomPoints.length - 1].y
    );
  
    this.ctx.closePath();
    this.ctx.fill();
  }
  

  async generateFrames() {
    const audioData = await this.getAudioData();
    const [profileImage, watermarkImage] = await Promise.all([
      loadImage(this.profileImagePath),
      loadImage(this.watermarkPath)
    ]);
    
    if (!fs.existsSync(this.framesDir)) {
      fs.mkdirSync(this.framesDir);
    }

    const exactDuration = await this.getDuration(this.audioPath);
    const totalFrames = Math.floor(exactDuration * this.frameRate);
    const samplesPerFrame = Math.ceil(audioData.length / totalFrames);
    
    console.log(`Duration: ${exactDuration}s, Frames: ${totalFrames}, Samples per frame: ${samplesPerFrame}`);

    for (let frame = 0; frame < totalFrames; frame++) {
      if (frame % 20 === 0) {
        console.log(`Processing frame ${frame}/${totalFrames} (${Math.round(frame/totalFrames*100)}%)`);
      }
      
      const startSample = frame * samplesPerFrame;
      const frameData = audioData.slice(startSample, startSample + samplesPerFrame);
      const frequencies = this.calculateFrequencies(frameData, 64);
      
      this.renderFrame(profileImage, watermarkImage, frequencies);
      
      const frameFile = join(this.framesDir, `frame-${frame.toString().padStart(6, '0')}.png`);
      const out = fs.createWriteStream(frameFile);
      const stream = this.canvas.createPNGStream();
      await new Promise(resolve => stream.pipe(out).on('finish', resolve));
    }
  }

  async generateVideo() {
    try {
      const wavPath = await this.convertToWav();
      this.audioPath = wavPath;
      await this.generateFrames();
      
      return new Promise((resolve, reject) => {
        ffmpeg()
          .input(join(this.framesDir, 'frame-%06d.png'))
          .inputFPS(this.frameRate)
          .input(this.audioPath)
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions([
            '-pix_fmt', 'yuv420p',
            '-shortest',
            '-movflags', '+faststart'
          ])
          .output(this.outputPath)
          .on('end', () => {
            // Cleanup
            fs.rmSync(this.framesDir, { recursive: true });
            fs.unlinkSync(this.tempWavPath);
            resolve();
          })
          .on('error', reject)
          .run();
      });
    } catch (error) {
      // Cleanup on error
      if (fs.existsSync(this.tempWavPath)) {
        fs.unlinkSync(this.tempWavPath);
      }
      throw error;
    }
  }
}

module.exports = VideoGenerator;

// Example usage:
// const generator = new VideoGenerator({
//   audioPath: './test.mp3',
//   profileImagePath: './albumart.jpg',
//   watermarkPath: './pullthatupjamie-watermark.png',
//   title: 'Green Candle Investments',
//   subtitle: 'Retiring On 0.01 Bitcoin Could Be Easy',
//   outputPath: 'output.mp4'
// });

// generator.generateVideo()
//   .then(() => console.log('Video generated!'))
//   .catch(console.error);