const { createCanvas, loadImage } = require('canvas');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const wav = require('wav');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { v4: uuidv4 } = require('uuid');
const os = require('os');

class VideoGenerator {
  constructor(options) {
    // Generate unique instance ID
    this.instanceId = uuidv4();
    this.maxConcurrentFrames = 40;
    
    // Required options
    this.audioPath = options.audioPath;
    this.profileImagePath = options.profileImagePath;
    this.title = options.title;
    this.subtitle = options.subtitle;
    this.outputPath = options.outputPath;
    this.watermarkPath = options.watermarkPath;

    // Optional configurations
    this.frameRate = options.frameRate || 20;
    this.canvas = createCanvas(720, 720);
    this.ctx = this.canvas.getContext('2d');

    // Create instance-specific working directories
    this.workingDir = path.join(os.tmpdir(), `video-gen-${this.instanceId}`);
    this.framesDir = path.join(this.workingDir, 'frames');
    this.tempWavPath = path.join(this.workingDir, `temp-${this.instanceId}.wav`);

    // Design configurations remain the same
    this.profileImageSize = 200;
    this.profileImageRadius = 50;
    this.profileImageBorderColor = '#333333';
    this.profileImageBorderWidth = 4;
    this.textColor = '#FFFFFF';

    // Ensure working directories exist
    this.initializeWorkingDirectories();
  }

  initializeWorkingDirectories() {
    // Create working directories if they don't exist
    if (!fs.existsSync(this.workingDir)) {
        fs.mkdirSync(this.workingDir, { recursive: true });
    }
    if (!fs.existsSync(this.framesDir)) {
        fs.mkdirSync(this.framesDir, { recursive: true });
    }
  }

  async cleanup() {
      try {
          // Clean up working directory and all contents
          if (fs.existsSync(this.workingDir)) {
              await fs.promises.rm(this.workingDir, { recursive: true, force: true });
          }
      } catch (error) {
          console.error(`Error cleaning up working directory for instance ${this.instanceId}:`, error);
      }
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

  drawRoundedImage(ctx, image, x, y, width, height, radius, borderColor, borderWidth) {
    ctx.save();
    
    // Create clipping path for rounded corners
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    
    // Draw border
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = borderWidth;
    ctx.stroke();
    
    // Clip and draw image
    ctx.clip();
    ctx.drawImage(image, x, y, width, height);
    
    ctx.restore();
  }

  createGradientFromImage(ctx, waveformCenterY, maxWaveHeight, profileImage) {
    const tempCanvas = createCanvas(profileImage.width, profileImage.height);
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(profileImage, 0, 0);
  
    const rgbToHsl = (r, g, b) => {
      r /= 255;
      g /= 255;
      b /= 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      let h, s, l = (max + min) / 2;
  
      if (max === min) {
        h = s = 0;
      } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
      }
      return [h, s * 100, l * 100];
    };
  
    const isNonNeutralColor = (r, g, b) => {
      const [h, s, l] = rgbToHsl(r, g, b);
  
      return (
        !(r === g && g === b) &&  // Avoid grayscale (neutral) colors
        s > 30 &&                 // Ensure sufficient saturation (avoid washed-out colors)
        l > 15 && l < 85          // Avoid extremes of brightness (too dark or too light)
      );
    };
  
    const getDominantColor = () => {
      const imageData = tempCtx.getImageData(0, 0, profileImage.width, profileImage.height).data;
      const colorMap = new Map();
  
      for (let i = 0; i < imageData.length; i += 4) {
        const r = imageData[i];
        const g = imageData[i + 1];
        const b = imageData[i + 2];
  
        if (!isNonNeutralColor(r, g, b)) continue;
  
        const key = `${r},${g},${b}`;
        colorMap.set(key, (colorMap.get(key) || 0) + 1);
      }
  
      let maxCount = 0;
      let dominantColor = [248, 76, 31]; // Fallback (orange-red)
  
      for (const [key, count] of colorMap) {
        if (count > maxCount) {
          maxCount = count;
          dominantColor = key.split(',').map(Number);
        }
      }
  
      return dominantColor;
    };
  
    const [r, g, b] = getDominantColor();
    const baseColor = `rgb(${r},${g},${b})`;
  
    // Generate lighter and darker shades for depth
    const lighten = `rgba(${Math.min(r + 40, 255)}, ${Math.min(g + 40, 255)}, ${Math.min(b + 40, 255)}, 1)`;
    const darken = `rgba(${Math.max(r - 40, 0)}, ${Math.max(g - 40, 0)}, ${Math.max(b - 40, 0)}, 1)`;
  
    // Create a more balanced gradient that centers the dominant color
    const gradient = ctx.createLinearGradient(0, waveformCenterY - maxWaveHeight, 0, waveformCenterY + maxWaveHeight);
    gradient.addColorStop(0, lighten);
    gradient.addColorStop(0.5, baseColor);
    gradient.addColorStop(1, darken);
  
    return gradient;
  }
  
  
  // Helper method to blend colors
  blendColors(color1, color2, ratio) {
    const hex2rgb = hex => {
      const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      return result ? [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16)
      ] : null;
    };
  
    const rgb2hex = rgb => {
      return '#' + rgb.map(x => {
        const hex = Math.floor(x).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      }).join('');
    };
  
    const c1 = hex2rgb(color1);
    const c2 = hex2rgb(color2);
    
    if (!c1 || !c2) return color1;
  
    const blend = c1.map((c, i) => {
      return c * (1 - ratio) + c2[i] * ratio;
    });
  
    return rgb2hex(blend);
  }

  renderFrame(profileImage, watermarkImage, frequencyData, canvas, ctx) {
    // Replace all this.canvas with canvas
    const { width, height } = canvas;
    
    // Replace all this.ctx with ctx
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    
    const topHalfHeight = height / 2;
    const bottomHalfHeight = height / 2;

    // **Size the profile image properly (centered)**
    const profileImageSize = width * 0.4;  // 40% of canvas width
    const profileImageX = (width - profileImageSize) / 2; // Center horizontally
    const profileImageY = (topHalfHeight - profileImageSize) / 2 - 20; // Center vertically

    // **Draw Profile Image**
    this.drawRoundedImage(
      ctx,  // Add this as first parameter
      profileImage,
      profileImageX,
      profileImageY,
      profileImageSize,
      profileImageSize,
      this.profileImageRadius,
      this.profileImageBorderColor,
      this.profileImageBorderWidth
  );

    const watermarkWidth = 160; // Adjust as needed for your canvas size
    const watermarkHeight = (watermarkImage.height / watermarkImage.width) * watermarkWidth; // Maintain aspect ratio
    const watermarkPadding = 10;
    ctx.drawImage(
      watermarkImage,
      width - watermarkWidth - watermarkPadding,
      watermarkPadding,
      watermarkWidth,
      watermarkHeight
    );

    // **Title & Subtitle Adjustments**
    ctx.textAlign = 'center';
    ctx.fillStyle = this.textColor;

    // **Title**
    ctx.font = 'bold 32px Arial';
    const titleY = profileImageY + profileImageSize + 40; // Position text below image
    ctx.fillText(this.title, width / 2, titleY);

    // **Process subtitle for multiline**
    const maxLength = 80;
    let subtitle = this.subtitle.length > maxLength ? this.subtitle.substring(0, maxLength - 3) + '...' : this.subtitle;

    let subtitleLines = [];
    if (subtitle.length > 40) {
        const splitIndex = subtitle.lastIndexOf(' ', 40); // Find the nearest space before 40 chars
        if (splitIndex !== -1) {
            subtitleLines.push(subtitle.substring(0, splitIndex).trim());
            subtitleLines.push(subtitle.substring(splitIndex + 1).trim());
        } else {
            subtitleLines.push(subtitle);
        }
    } else {
        subtitleLines.push(subtitle);
    }

    // **Subtitle Rendering**
    ctx.font = '24px Arial';
    const subtitleY = titleY + 40;  // Space below title
    ctx.fillText(subtitleLines[0], width / 2, subtitleY);

    if (subtitleLines.length > 1) {
        ctx.fillText(subtitleLines[1], width / 2, subtitleY + 30); // Add second line
    }

    // ─────────────────────────────────────────────────────────────
    // **🔴 BOTTOM HALF: Waveform**
    // ─────────────────────────────────────────────────────────────

    const waveformCenterY = topHalfHeight + bottomHalfHeight / 2; // Center waveform in bottom half
    const pointCount = frequencyData.length;
    const pointSpacing = width / (pointCount - 1); // Ensure it spans FULL width

    const maxWaveHeight = bottomHalfHeight * 0.4; // Make it fit within bottom half
    const gradient = this.createGradientFromImage(ctx, waveformCenterY, maxWaveHeight, profileImage);

    ctx.fillStyle = gradient;
    ctx.beginPath();

    // **Generate Waveform Points**
    const amplification = 2.0;
    const smoothingFactor = 0.4;
    const points = [];

    for (let i = 0; i < pointCount; i++) {
        const x = i * pointSpacing;
        const normalizedAmplitude = Math.min(frequencyData[i] * amplification, 1);
        const amplitude = normalizedAmplitude * maxWaveHeight;
        points.push({ x: x, y: waveformCenterY - amplitude });
    }

    // **Draw Top Waveform Curve**
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 2; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;

        const ctrl1x = points[i].x - (points[i].x - points[i - 1].x) * smoothingFactor;
        const ctrl1y = points[i].y - (points[i].y - points[i - 1].y) * smoothingFactor;
        const ctrl2x = xc - (xc - points[i].x) * smoothingFactor;
        const ctrl2y = yc - (yc - points[i].y) * smoothingFactor;

        ctx.bezierCurveTo(ctrl1x, ctrl1y, ctrl2x, ctrl2y, xc, yc);
    }

    ctx.quadraticCurveTo(
        points[points.length - 2].x,
        points[points.length - 2].y,
        points[points.length - 1].x,
        points[points.length - 1].y
    );

    // **Generate and Draw Bottom Mirrored Curve**
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

        ctx.bezierCurveTo(ctrl1x, ctrl1y, ctrl2x, ctrl2y, xc, yc);
    }

    ctx.quadraticCurveTo(
        bottomPoints[bottomPoints.length - 2].x,
        bottomPoints[bottomPoints.length - 2].y,
        bottomPoints[bottomPoints.length - 1].x,
        bottomPoints[bottomPoints.length - 1].y
    );

    ctx.closePath();
    ctx.fill();
}

 async saveFrame(canvas, filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    const stream = canvas.createPNGStream();
    stream.pipe(out)
      .on('finish', resolve)
      .on('error', reject);
  });
}

  async generateFrames() {
    const audioData = await this.getAudioData();
    const [profileImage, watermarkImage] = await Promise.all([
      loadImage(this.profileImagePath),
      loadImage(this.watermarkPath)
    ]);

    const exactDuration = await this.getDuration(this.audioPath);
    const totalFrames = Math.floor(exactDuration * this.frameRate);
    const samplesPerFrame = Math.ceil(audioData.length / totalFrames);

    console.log(`[Instance ${this.instanceId}] Processing ${totalFrames} frames in batches of ${this.maxConcurrentFrames}`);

    for (let batchStart = 0; batchStart < totalFrames; batchStart += this.maxConcurrentFrames) {
      const batchEnd = Math.min(batchStart + this.maxConcurrentFrames, totalFrames);
      const batchPromises = [];

      for (let frame = batchStart; frame < batchEnd; frame++) {
        batchPromises.push((async () => {
          const frameCanvas = createCanvas(720, 720);
          const frameCtx = frameCanvas.getContext('2d');
          
          const startSample = frame * samplesPerFrame;
          const frameData = audioData.slice(startSample, startSample + samplesPerFrame);
          const frequencies = this.calculateFrequencies(frameData, 64);

          this.renderFrame(profileImage, watermarkImage, frequencies, frameCanvas, frameCtx);

          const frameFile = path.join(this.framesDir, `frame-${frame.toString().padStart(6, '0')}.png`);
          await this.saveFrame(frameCanvas, frameFile);

          if (frame % 20 === 0) {
            console.log(`[Instance ${this.instanceId}] Processed frame ${frame}/${totalFrames} (${Math.round(frame/totalFrames*100)}%)`);
          }
        })());
      }

      await Promise.all(batchPromises);
    }
  }

  async generateVideo() {
    try {
        const wavPath = await this.convertToWav();
        this.audioPath = wavPath;
        await this.generateFrames();

        return new Promise((resolve, reject) => {
            ffmpeg()
                .input(path.join(this.framesDir, 'frame-%06d.png'))
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
                .on('end', async () => {
                    await this.cleanup();
                    resolve();
                })
                .on('error', async (err) => {
                    await this.cleanup();
                    reject(err);
                })
                .run();
        });
    } catch (error) {
        await this.cleanup();
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