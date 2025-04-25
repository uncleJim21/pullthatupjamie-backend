const { createCanvas, loadImage, Image } = require('canvas');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const wav = require('wav');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const sharp = require('sharp');

const overrideLookup = {
  'TFTC: A Bitcoin Podcast':[252,241,216]
}


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
    this.creator = options.creator ? options.creator : 'Unknown creator';
    
    // Added subtitle support
    this.subtitles = options.subtitles || [];

    // Optional configurations
    this.frameRate = options.frameRate || 20;
    this.canvas = createCanvas(720, 720);
    this.ctx = this.canvas.getContext('2d');

    // Create instance-specific working directories
    this.workingDir = path.join(os.tmpdir(), `video-gen-${this.instanceId}`);
    this.framesDir = path.join(this.workingDir, `frames-${this.instanceId}`);
    this.tempWavPath = path.join(this.workingDir, `temp-${this.instanceId}.wav`);

    // Design configurations remain the same
    this.profileImageSize = 200;
    this.profileImageRadius = 24;
    this.profileImageBorderColor = '#333333';
    this.profileImageBorderWidth = 4;
    this.textColor = '#FFFFFF';

    this.staticElements = {
        gradient: null,
        watermarkBuffer: null,
        profileImageBuffer: null
    };

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
    
    // Create path for rounded corners
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x + radius, y);
    ctx.closePath();
    
    // Draw image first
    ctx.clip();
    ctx.drawImage(image, x, y, width, height);
    
    // Restore context and redraw path for border
    ctx.restore();
    
    // Draw border path again
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
  }

  createGradientFromImage(ctx, waveformCenterY, maxWaveHeight, profileImage,overrideDomColor=null) {
    const tempCanvas = createCanvas(profileImage.width, profileImage.height);
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(profileImage, 0, 0);

    // Extract color data
    const imageData = tempCtx.getImageData(0, 0, profileImage.width, profileImage.height).data;

    let dominantColor = [255, 0, 0]; // Fallback to vibrant red
    let maxVibrancyScore = 0;

    console.log('Evaluating colors for vibrancy:'); // Debugging log

    for (let i = 0; i < imageData.length; i += 4) {
        const r = imageData[i];
        const g = imageData[i + 1];
        const b = imageData[i + 2];
        const a = imageData[i + 3];

        // Ignore fully transparent pixels
        if (a === 0) continue;

        // Convert to HSL for filtering and scoring
        const [h, s, l] = this.rgbToHsl(r, g, b);

        // Penalize browns and neutral colors
        const isBrown = (h >= 30 && h <= 45 && l > 20 && l < 70);
        const isNeutral = (l <= 20 || l >= 80 || s < 50);

        if (isBrown || isNeutral) continue;

        // Calculate vibrancy score (favoring high saturation and mid-range lightness)
        const vibrancyScore = s * (1 - Math.abs(l - 50) / 50);

        // Debugging log: Show the color and its vibrancy score
        console.log(`Color: rgb(${r},${g},${b}), HSL: (${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%), Score: ${vibrancyScore.toFixed(2)}`);

        // Update the dominant color if this one is more vibrant
        if (vibrancyScore > maxVibrancyScore) {
            maxVibrancyScore = vibrancyScore;
            dominantColor = [r, g, b];
        }
    }

    const [r, g, b] = overrideDomColor ? overrideDomColor : dominantColor;

    // Debugging log: Show the selected dominant color
    console.log(`Selected Dominant Color: rgb(${r},${g},${b})`);

    // Create gradient from the selected dominant color
    const baseColor = `rgb(${r},${g},${b})`;
    const lighten = `rgb(${Math.min(r + 40, 255)}, ${Math.min(g + 40, 255)}, ${Math.min(b + 40, 255)})`;
    const darken = `rgb(${Math.max(r - 40, 0)}, ${Math.max(g - 40, 0)}, ${Math.max(b - 40, 0)})`;

    const gradient = ctx.createLinearGradient(0, waveformCenterY - maxWaveHeight, 0, waveformCenterY + maxWaveHeight);
    gradient.addColorStop(0, lighten);
    gradient.addColorStop(0.5, baseColor);
    gradient.addColorStop(1, darken);

    return gradient;
}

// Utility function to convert RGB to HSL
rgbToHsl(r, g, b) {
    r /= 255, g /= 255, b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // Achromatic
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h = Math.round(h * 60);
    }
    return [h, s * 100, l * 100];
}


// Utility function to convert RGB to HSL
rgbToHsl(r, g, b) {
    r /= 255, g /= 255, b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // Achromatic
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h = Math.round(h * 60);
    }
    return [h, s * 100, l * 100];
}


// Utility function to convert RGB to HSL
rgbToHsl(r, g, b) {
    r /= 255, g /= 255, b /= 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // Achromatic
    } else {
        let d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
    }

    return [h, s * 100, l * 100]; // Returns [hue, saturation, lightness]
}


// Utility function to convert RGB to HSL
rgbToHsl(r, g, b) {
    r /= 255, g /= 255, b /= 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // Achromatic
    } else {
        let d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
    }

    return [h, s * 100, l * 100]; // Returns [hue, saturation, lightness]
}


  

  renderFrame(profileImage, watermarkImage, frequencyData, canvas, ctx, frameIndex = 0) {
    const { width, height } = canvas;

    // Clear background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // Profile image settings
    const profileImageSize = this.profileImageSize;
    const profileImageX = (width - profileImageSize) / 2;
    const profileImageY = height / 4 - profileImageSize / 2;

    // Watermark settings
    const watermarkWidth = 160;
    const watermarkHeight = Math.ceil((watermarkImage.height / watermarkImage.width) * watermarkWidth);
    const watermarkX = width - watermarkWidth - 10;
    const watermarkY = 10;

    // Attempt to draw precomputed profile image buffer
    if (this.staticElements.profileImageBuffer) {
        try {
            const tempImage = new Image();
            tempImage.src = this.staticElements.profileImageBuffer;
            ctx.drawImage(tempImage, profileImageX, profileImageY, profileImageSize, profileImageSize);
        } catch (error) {
            console.warn(`Warning: Failed to render profile image from buffer, falling back to standard rendering. Error: ${error.message}`);
            this.drawRoundedImage(ctx, profileImage, profileImageX, profileImageY, profileImageSize, profileImageSize, this.profileImageRadius, this.profileImageBorderColor, this.profileImageBorderWidth);
        }
    } else {
        this.drawRoundedImage(ctx, profileImage, profileImageX, profileImageY, profileImageSize, profileImageSize, this.profileImageRadius, this.profileImageBorderColor, this.profileImageBorderWidth);
    }

    // Attempt to draw precomputed watermark buffer
    if (this.staticElements.watermarkBuffer) {
        try {
            const tempWatermark = new Image();
            tempWatermark.src = this.staticElements.watermarkBuffer;
            ctx.drawImage(tempWatermark, watermarkX, watermarkY, watermarkWidth, watermarkHeight);
        } catch (error) {
            console.warn(`Warning: Failed to render watermark from buffer, falling back to standard rendering. Error: ${error.message}`);
            ctx.drawImage(watermarkImage, watermarkX, watermarkY, watermarkWidth, watermarkHeight);
        }
    } else {
        ctx.drawImage(watermarkImage, watermarkX, watermarkY, watermarkWidth, watermarkHeight);
    }

    // Title text
    ctx.textAlign = 'center';
    ctx.fillStyle = this.textColor;
    ctx.font = 'bold 32px Arial';
    ctx.fillText(this.title, width / 2, profileImageY + profileImageSize + 40);

    // Subtitle text
    const subtitleMaxLength = 80;
    let subtitle = this.subtitle.length > subtitleMaxLength ? 
      this.subtitle.substring(0, subtitleMaxLength - 3) + '...' : 
      this.subtitle;    
    let subtitleLines = subtitle.length > 40 ? [subtitle.substring(0, 40).trim(), subtitle.substring(40).trim()] : [subtitle];
    let firstLine = '';
    let secondLine = '';

    if (subtitle.length > 40) {
      // Find the last space before or at position 40
      const splitIndex = subtitle.substring(0, 40).lastIndexOf(' ');
      
      if (splitIndex === -1) {
        // No spaces found, force the split at 40
        firstLine = subtitle.substring(0, 40);
        secondLine = subtitle.substring(40);
      } else {
        firstLine = subtitle.substring(0, splitIndex);
        secondLine = subtitle.substring(splitIndex + 1);
      }
    } else {
      firstLine = subtitle;
    }
    
    ctx.font = '24px Arial';
    ctx.fillText(firstLine.trim(), width / 2, profileImageY + profileImageSize + 80);
    if (secondLine) {
      ctx.fillText(secondLine.trim(), width / 2, profileImageY + profileImageSize + 110);
    }
    
    // Waveform settings
    const waveformCenterY = height * 0.75;
    const pointCount = frequencyData.length;
    const pointSpacing = width / (pointCount - 1);
    const maxWaveHeight = height * 0.18;

    // Set waveform gradient
    ctx.fillStyle = this.staticElements.gradient || this.createGradientFromImage(ctx, waveformCenterY, maxWaveHeight, profileImage);
    ctx.beginPath();

    // Generate waveform points
    const amplification = 4.0;
    const smoothingFactor = 0.4;
    const offsetY = 5.0;
    const points = [];

    for (let i = 0; i < pointCount; i++) {
        const x = i * pointSpacing;
        const normalizedAmplitude = Math.min(frequencyData[i] * amplification, 1);
        const amplitude = normalizedAmplitude * maxWaveHeight + offsetY;
        points.push({ x: x, y: waveformCenterY - amplitude });
    }

    // Draw waveform curve (top)
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 2; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;

        ctx.bezierCurveTo(
            points[i].x - (points[i].x - points[i - 1].x) * smoothingFactor,
            points[i].y - (points[i].y - points[i - 1].y) * smoothingFactor,
            xc - (xc - points[i].x) * smoothingFactor,
            yc - (yc - points[i].y) * smoothingFactor,
            xc,
            yc
        );
    }
    ctx.quadraticCurveTo(points[points.length - 2].x, points[points.length - 2].y, points[points.length - 1].x, points[points.length - 1].y);

    // Draw mirrored waveform curve (bottom)
    const bottomPoints = points.map(p => ({ x: p.x, y: waveformCenterY + (waveformCenterY - p.y) })).reverse();
    for (let i = 1; i < bottomPoints.length - 2; i++) {
        const xc = (bottomPoints[i].x + bottomPoints[i + 1].x) / 2;
        const yc = (bottomPoints[i].y + bottomPoints[i + 1].y) / 2;

        ctx.bezierCurveTo(
            bottomPoints[i].x - (bottomPoints[i].x - bottomPoints[i - 1].x) * smoothingFactor,
            bottomPoints[i].y - (bottomPoints[i].y - bottomPoints[i - 1].y) * smoothingFactor,
            xc - (xc - bottomPoints[i].x) * smoothingFactor,
            yc - (yc - bottomPoints[i].y) * smoothingFactor,
            xc,
            yc
        );
    }
    ctx.quadraticCurveTo(bottomPoints[bottomPoints.length - 2].x, bottomPoints[bottomPoints.length - 2].y, bottomPoints[bottomPoints.length - 1].x, bottomPoints[bottomPoints.length - 1].y);

    ctx.closePath();
    ctx.fill();

    // IMPORTANT: Calculate current timestamp based on frame index
    // This needs to come AFTER drawing the waveform but BEFORE adding subtitles
    if (this.exactDuration && this.frameRate) {
      const timestamp = (frameIndex / this.frameRate);
      
      // Log for debug purpose - remove in production
      if (frameIndex === 0) {
        console.log(`[DEBUG] First frame timestamp: ${timestamp}, exact duration: ${this.exactDuration}, frameRate: ${this.frameRate}`);
        console.log(`[DEBUG] Subtitle count: ${this.subtitles ? this.subtitles.length : 0}`);
      }
      
      // Get active subtitles for this timestamp
      const activeSubtitles = this.getActiveSubtitles(timestamp);
      
      if (activeSubtitles && activeSubtitles.length > 0) {
        // Draw subtitle background
        const subtitleText = activeSubtitles.map(s => s.text).join(' ');
        
        if (frameIndex % 20 === 0) {
          console.log(`[DEBUG] Frame ${frameIndex} active subtitles: '${subtitleText}'`);
        }
        
        // Position subtitle DIRECTLY IN FRONT of the waveform
        const subtitleY = height - 120; // Just 20px from bottom of frame (height - 40 for text alignment)
        
        // Use larger, bolder font for better visibility
        ctx.font = 'bold 36px Arial';
        const textMetrics = ctx.measureText(subtitleText);
        const textWidth = Math.min(textMetrics.width + 80, width - 40); // Add padding but cap at screen width
        
        // Draw background for subtitle - semi-transparent black rectangle with rounded corners
        const bgHeight = 70;
        const bgY = subtitleY - 45; // Move up to center text vertically
        const bgX = Math.max(20, (width - textWidth) / 2); // Keep from edges
        const cornerRadius = 15;
        
        // Draw rounded rectangle with lower opacity
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'; // 40% opacity for a subtle background
        ctx.beginPath();
        ctx.moveTo(bgX + cornerRadius, bgY);
        ctx.lineTo(bgX + textWidth - cornerRadius, bgY);
        ctx.quadraticCurveTo(bgX + textWidth, bgY, bgX + textWidth, bgY + cornerRadius);
        ctx.lineTo(bgX + textWidth, bgY + bgHeight - cornerRadius);
        ctx.quadraticCurveTo(bgX + textWidth, bgY + bgHeight, bgX + textWidth - cornerRadius, bgY + bgHeight);
        ctx.lineTo(bgX + cornerRadius, bgY + bgHeight);
        ctx.quadraticCurveTo(bgX, bgY + bgHeight, bgX, bgY + bgHeight - cornerRadius);
        ctx.lineTo(bgX, bgY + cornerRadius);
        ctx.quadraticCurveTo(bgX, bgY, bgX + cornerRadius, bgY);
        ctx.closePath();
        ctx.fill();
        
        // Draw subtitle text with stronger shadow for better readability
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
        ctx.fillText(subtitleText, width / 2, subtitleY);
        
        // Reset shadow
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }
    }
}

// Updated color selection logic with hard exclusion for tones similar to #9b4a37
async initializeStaticElements(profileImage, watermarkImage,overrideDomColor=null) {
    const tempCanvas = createCanvas(profileImage.width, profileImage.height);
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(profileImage, 0, 0);
  
    const imageData = tempCtx.getImageData(0, 0, profileImage.width, profileImage.height).data;
    let dominantColor = null;
    let maxVibrancyScore = 0;
  
    // Combined RGB to HSV conversion (single conversion for both checks)
    const rgbToHsv = (r, g, b) => {
      r /= 255;
      g /= 255;
      b /= 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      const s = max === 0 ? 0 : d / max;
      const v = max;
      let h = 0;
      
      if (max !== min) {
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
      }
      
      return [h * 360, s * 100, v * 100];
    };
  
    // Process every 32nd pixel for better performance
    for (let i = 0; i < imageData.length; i += 128) {
      const r = imageData[i];
      const g = imageData[i + 1];
      const b = imageData[i + 2];
      const a = imageData[i + 3];
  
      if (a === 0) continue; // Skip transparent pixels
  
      const [h, s, v] = rgbToHsv(r, g, b);
      
      // More aggressive filtering:
      // - Skip if too dark (value < 30%)
      // - Skip if too desaturated (saturation < 40%)
      if (v < 30 || s < 40) continue;
  
      // Simplified vibrancy score that favors saturation
      const vibrancyScore = s * (v / 100) * 2;
  
      if (vibrancyScore > maxVibrancyScore) {
        maxVibrancyScore = vibrancyScore;
        dominantColor = [r, g, b];
      }
    }
  
    // Fallback to white if no suitable color found
    if(overrideDomColor){
      dominantColor = overrideDomColor
    }
    else if (!dominantColor || maxVibrancyScore < 50) {
      console.log('No sufficiently vibrant color found, falling back to white');
      dominantColor = [255, 255, 255];
    } else {
      console.log(`Selected color: rgb(${dominantColor.join(',')}), vibrancy score: ${maxVibrancyScore}`);
    }
  
    // Create gradient with selected color
    const [r, g, b] = dominantColor;
    this.staticElements.gradient = this.createGradient(r, g, b, tempCtx, 360, 140);
  
    // Rest of initialization code remains the same...
    const watermarkWidth = 160;
    const watermarkHeight = Math.ceil((watermarkImage.height / watermarkImage.width) * watermarkWidth);
    const watermarkCanvas = createCanvas(watermarkWidth, watermarkHeight);
    const watermarkCtx = watermarkCanvas.getContext('2d');
    watermarkCtx.drawImage(watermarkImage, 0, 0, watermarkWidth, watermarkHeight);
    
    this.staticElements.watermarkBuffer = await sharp(watermarkCanvas.toBuffer())
      .png()
      .sharpen({ 
        sigma: 1.5,
        m1: 1,
        m2: 1.5
      })
      .toBuffer();
  
    const profileCanvas = createCanvas(this.profileImageSize, this.profileImageSize);
    const profileCtx = profileCanvas.getContext('2d');
    this.drawRoundedImage(
      profileCtx,
      profileImage,
      0,
      0,
      this.profileImageSize,
      this.profileImageSize,
      this.profileImageRadius,
      this.profileImageBorderColor,
      this.profileImageBorderWidth
    );
    
    this.staticElements.profileImageBuffer = await sharp(profileCanvas.toBuffer())
      .png()
      .toBuffer();
  }



// Gradient utility
createGradient(r, g, b, ctx, waveformCenterY, maxWaveHeight) {
  const baseColor = `rgb(${r},${g},${b})`;
  const lighten = `rgb(${Math.min(r + 40, 255)}, ${Math.min(g + 40, 255)}, ${Math.min(b + 40, 255)})`;
  const darken = `rgb(${Math.max(r - 40, 0)}, ${Math.max(g - 40, 0)}, ${Math.max(b - 40, 0)})`;

  const gradient = ctx.createLinearGradient(0, waveformCenterY - maxWaveHeight, 0, waveformCenterY + maxWaveHeight);
  gradient.addColorStop(0, lighten);
  gradient.addColorStop(0.5, baseColor);
  gradient.addColorStop(1, darken);

  return gradient;
}


async saveFrame(canvas, filePath) {
  try {
    // Generate raw buffer
    const rawBuffer = canvas.toBuffer('raw', {
      colorSpace: 'srgb',
      enableAlpha: true
    });

    // Fix potential BGRA inversion by swapping channels if needed
    const fixedBuffer = Buffer.alloc(rawBuffer.length);
    for (let i = 0; i < rawBuffer.length; i += 4) {
      fixedBuffer[i] = rawBuffer[i + 2];     // Red -> Blue
      fixedBuffer[i + 1] = rawBuffer[i + 1]; // Green -> Green
      fixedBuffer[i + 2] = rawBuffer[i];     // Blue -> Red
      fixedBuffer[i + 3] = rawBuffer[i + 3]; // Alpha
    }

    // Use sharp to write PNG
    await sharp(fixedBuffer, {
      raw: {
        width: canvas.width,
        height: canvas.height,
        channels: 4 // RGBA
      }
    })
      .png()
      .toFile(filePath);
  } catch (error) {
    console.error(`Error saving frame: ${error}`);
    throw error;
  }
}



async generateFrames() {
    const audioData = await this.getAudioData();
    const [profileImage, watermarkImage] = await Promise.all([
        loadImage(this.profileImagePath),
        loadImage(this.watermarkPath)
    ]);

    // Initialize static elements
    console.log(`creator:${this.creator}`)
    const overrideValue = overrideLookup[this.creator] ?? null;
    console.log(`override value:${overrideValue}`)
    await this.initializeStaticElements(profileImage, watermarkImage,overrideValue);

    const exactDuration = await this.getDuration(this.audioPath);
    // Store the duration for use in subtitle timing
    this.exactDuration = exactDuration;
    
    const totalFrames = Math.floor(exactDuration * this.frameRate);
    const samplesPerFrame = Math.ceil(audioData.length / totalFrames);

    console.log(`[Instance ${this.instanceId}] Processing ${totalFrames} frames in batches of ${this.maxConcurrentFrames}`);

    let firstFrameGenerated = false;

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

                // Pass frame index to renderFrame
                this.renderFrame(profileImage, watermarkImage, frequencies, frameCanvas, frameCtx, frame);

                // ✅ Ensure first frame is saved properly
                const uniqueFrameFile = path.join(this.framesDir, `frame-${this.instanceId}-${frame.toString().padStart(6, '0')}.png`);
                await this.saveFrame(frameCanvas, uniqueFrameFile);

                // ✅ Explicitly save first frame to preview path
                if (frame === 0 && !firstFrameGenerated) {
                    const previewImagePath = this.outputPath.replace('.mp4', '-preview.png');
                    fs.copyFileSync(uniqueFrameFile, previewImagePath);
                    console.log(`[INFO] First frame copied as preview: ${previewImagePath}`);
                    firstFrameGenerated = true;
                }

                if (frame % 20 === 0) {
                    console.log(`[Instance ${this.instanceId}] Processed frame ${frame}/${totalFrames} (${Math.round((frame / totalFrames) * 100)}%)`);
                }
            })());
        }

        await Promise.all(batchPromises);
    }
}

  createGradient(r, g, b, ctx, waveformCenterY, maxWaveHeight) {
    const baseColor = `rgb(${r},${g},${b})`;
    const lighten = `rgb(${Math.min(r + 40, 255)}, ${Math.min(g + 40, 255)}, ${Math.min(b + 40, 255)})`;
    const darken = `rgb(${Math.max(r - 40, 0)}, ${Math.max(g - 40, 0)}, ${Math.max(b - 40, 0)})`;

    const gradient = ctx.createLinearGradient(0, waveformCenterY - maxWaveHeight, 0, waveformCenterY + maxWaveHeight);
    gradient.addColorStop(0, lighten);
    gradient.addColorStop(0.5, baseColor);
    gradient.addColorStop(1, darken);

    return gradient;
}

  async generateVideo() {
    try {
        const wavPath = await this.convertToWav();
        this.audioPath = wavPath;
        await this.generateFrames();

        const sequentialDir = path.join(this.framesDir, `sequential-${this.instanceId}`);
        if (!fs.existsSync(sequentialDir)) {
            fs.mkdirSync(sequentialDir, { recursive: true });
        }

        const frameFiles = fs.readdirSync(this.framesDir)
            .filter(file => file.startsWith(`frame-${this.instanceId}-`) && file.endsWith('.png'))
            .sort((a, b) => parseInt(a.match(/(\d+)\.png$/)[1]) - parseInt(b.match(/(\d+)\.png$/)[1])); // Sort by frame number

        frameFiles.forEach((file, index) => {
            const sourcePath = path.join(this.framesDir, file);
            const symlinkPath = path.join(sequentialDir, `frame-${index.toString().padStart(6, '0')}.png`);
            
            try {
                if (fs.existsSync(symlinkPath)) {
                    fs.unlinkSync(symlinkPath); // Remove old symlink if needed
                }
                fs.symlinkSync(sourcePath, symlinkPath);
            } catch (err) {
                console.error(`[ERROR] Failed to create symlink for ${file}:`, err);
            }
        });

        return new Promise((resolve, reject) => {
            ffmpeg()
                 .input(path.join(this.framesDir, `frame-${this.instanceId}-%06d.png`))
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

// Add a new method to find active subtitles for a specific timestamp
getActiveSubtitles(timestamp) {
  // Debug subtitle array contents to make sure it's initialized properly
  if (timestamp < 0.1 || timestamp % 5 < 0.05) {
    console.log(`[DEBUG] getActiveSubtitles called at timestamp ${timestamp.toFixed(2)}`);
    console.log(`[DEBUG] Subtitle array has ${this.subtitles ? this.subtitles.length : 0} items`);
    
    if (this.subtitles && this.subtitles.length > 0) {
      console.log(`[DEBUG] First subtitle: ${JSON.stringify(this.subtitles[0])}`);
      console.log(`[DEBUG] Last subtitle: ${JSON.stringify(this.subtitles[this.subtitles.length-1])}`);
      
      // Add this check to help debug timestamp issues
      if (timestamp < 0.1) {  // Check in the first frame
        const timeInRange = this.subtitles.some(s => 
          timestamp >= s.start - 0.1 && timestamp <= s.end + 0.1
        );
        
        if (!timeInRange) {
          console.log(`[WARN] No subtitles match timestamp ${timestamp}. This likely means there's a timestamp mismatch.`);
          console.log(`[WARN] If subtitles use absolute timestamps (from original audio), they need to be adjusted to be relative to the clip.`);
          
          // Attempt to suggest adjustment if timestamps seem absolute
          if (this.subtitles[0].start > 10) {
            console.log(`[DEBUG] Consider adjusting subtitle timestamps in ClipUtils.js before passing to VideoGenerator.`);
            
            // Just for debugging - show what the first subtitle would look like if adjusted
            console.log(`[DEBUG] Example: timestamp ${timestamp.toFixed(2)} would match a subtitle with start ≤ ${timestamp.toFixed(2)} and end ≥ ${timestamp.toFixed(2)}`);
          }
        }
      }
    }
  }
  
  // Validate subtitles exist
  if (!this.subtitles || this.subtitles.length === 0) {
    return [];
  }
  
  // Validate timestamp
  if (timestamp === undefined || timestamp === null || isNaN(timestamp)) {
    console.warn(`[WARN] Invalid timestamp in getActiveSubtitles: ${timestamp}`);
    return [];
  }
  
  // Find all subtitles that are active at the current timestamp
  const result = this.subtitles.filter(subtitle => {
    // Skip invalid subtitle entries
    if (!subtitle || subtitle.start === undefined || subtitle.end === undefined) {
      if (timestamp < 1) {
        console.warn(`[WARN] Invalid subtitle entry found:`, subtitle);
      }
      return false;
    }
    
    // Check if this subtitle is active at the current timestamp
    const isActive = subtitle.start <= timestamp && subtitle.end >= timestamp;
    
    // Provide more detailed logging for debugging
    if (timestamp < 1 && isActive) {
      console.log(`[DEBUG] Active subtitle at ${timestamp.toFixed(2)}s: "${subtitle.text}" (${subtitle.start.toFixed(2)}s - ${subtitle.end.toFixed(2)}s)`);
    }
    
    return isActive;
  });
  
  // Debug logging on every frame for the first 5 seconds
  if (timestamp < 5) {
    if (result.length > 0) {
      console.log(`[DEBUG] Found ${result.length} active subtitles at timestamp ${timestamp.toFixed(2)}:`, 
        result.map(s => s.text).join(' '));
    } else if (timestamp % 1 < 0.05) {
      // Only log empty results once per second to reduce spam
      console.log(`[DEBUG] No active subtitles at timestamp ${timestamp.toFixed(2)}`);
    }
  }
  
  return result;
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