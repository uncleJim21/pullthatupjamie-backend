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
      ctx.quadraticCurveTo(x, y, x + radius, y);
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

  createGradientFromImage(ctx, waveformCenterY, maxWaveHeight, profileImage) {
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

    const [r, g, b] = dominantColor;

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


  

  renderFrame(profileImage, watermarkImage, frequencyData, canvas, ctx) {
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
}

// Updated color selection logic with hard exclusion for tones similar to #9b4a37
async initializeStaticElements(profileImage, watermarkImage) {
  const tempCanvas = createCanvas(profileImage.width, profileImage.height);
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(profileImage, 0, 0);

  const imageData = tempCtx.getImageData(0, 0, profileImage.width, profileImage.height).data;

  let dominantColor = null;
  let maxVibrancyScore = 0;
  const evaluatedColors = new Set();
  const colorLog = [];

  // Helper: Convert RGB to HSL
  const rgbToHsl = (r, g, b) => {
      r /= 255; g /= 255; b /= 255;
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
          h *= 60;
      }
      return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  };

  // Helper: Calculate Euclidean distance in RGB space
  const rgbDistance = (r1, g1, b1, r2, g2, b2) => {
      return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  };

  // Helper: Determine if a color is similar to excluded tones
  const isExcludedColor = (r, g, b) => {
      const excludedColor = { r: 155, g: 74, b: 55 }; // #9b4a37
      const threshold = 50; // Adjust this value as needed to widen or narrow the exclusion
      return rgbDistance(r, g, b, excludedColor.r, excludedColor.g, excludedColor.b) < threshold;
  };

  // Helper: Determine if a color is vibrant
  const isVibrantColor = (h, s, l) => {
      const isNeutral = l <= 20 || l >= 85 || s < 30;
      const isDull = s < 50 && l > 50; // Muted tones

      // Strict filter: Ignore neutral or dull colors
      return !isNeutral && !isDull;
  };

  // Analyze pixels
  for (let i = 0; i < imageData.length; i += 16) { // Sample every 16th pixel
      const r = imageData[i];
      const g = imageData[i + 1];
      const b = imageData[i + 2];
      const a = imageData[i + 3];

      if (a === 0) continue; // Skip transparent pixels

      const rgbKey = `${r},${g},${b}`;
      if (evaluatedColors.has(rgbKey)) continue;
      evaluatedColors.add(rgbKey);

      const [h, s, l] = rgbToHsl(r, g, b);
      const vibrancyScore = s * (1 - Math.abs(l - 50) / 50); // Boost saturation, balance lightness

      // Hard exclusion for brown tones and non-vibrant colors
      const isExcluded = isExcludedColor(r, g, b) || !isVibrantColor(h, s, l);
      const penalty = isExcluded ? -1000 : 0; // Heavy penalty for excluded colors
      const finalScore = vibrancyScore + penalty;

      colorLog.push({
          color: `rgb(${r},${g},${b})`,
          h, s, l,
          vibrancyScore,
          penalty,
          finalScore,
          isExcluded,
      });

      if (finalScore > maxVibrancyScore) {
          maxVibrancyScore = finalScore;
          dominantColor = [r, g, b];
      }
  }

  // Fallback: If no valid color, use vibrant purple
  if (!dominantColor) {
      console.warn("No valid vibrant color found. Defaulting to #231761.");
      dominantColor = [35, 23, 97];
  }

  // Log details for debugging
  console.log("Color Analysis Log:", colorLog);
  console.log(`Selected Dominant Color: rgb(${dominantColor.join(",")})`);

  const [r, g, b] = dominantColor;

  // Precompute gradient
  this.staticElements.gradient = this.createGradient(r, g, b, tempCtx, 360, 140);

  // Pre-render watermark
  const watermarkWidth = 160;
  const watermarkHeight = Math.ceil((watermarkImage.height / watermarkImage.width) * watermarkWidth);
  const watermarkCanvas = createCanvas(watermarkWidth, watermarkHeight);
  const watermarkCtx = watermarkCanvas.getContext('2d');
  watermarkCtx.drawImage(watermarkImage, 0, 0, watermarkWidth, watermarkHeight);
  // In initializeStaticElements, modify watermark processing:
  this.staticElements.watermarkBuffer = await sharp(watermarkCanvas.toBuffer())
  .png()
  .sharpen({ 
      sigma: 1.5,
      m1: 1,  // flat areas
      m2: 1.5 // jagged areas
  })
  .toBuffer();

  // Pre-render profile image
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
    await this.initializeStaticElements(profileImage, watermarkImage);

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