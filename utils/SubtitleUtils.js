const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Shared subtitle utilities for both make-clip and edit-video workflows
 * 
 * DESIGN NOTE: This module is designed to be flexible and allow easy switching
 * between different subtitle rendering approaches:
 * - SRT + FFmpeg (current approach for edit-video)
 * - Canvas rendering (current approach for make-clip)
 * - Future approaches (WebVTT, ASS, etc.)
 * 
 * The key is that subtitle generation is separate from subtitle rendering,
 * so we can change rendering methods without affecting generation logic.
 */
class SubtitleUtils {
  
  /**
   * Process subtitles for video editing - supports both client-provided and auto-generated subtitles
   * 
   * DESIGN NOTE: This function provides flexibility in subtitle sources:
   * 1. Client-provided subtitles (preferred for edit-video)
   * 2. Auto-generated from transcript (fallback)
   * 
   * @param {Array} clientSubtitles - Subtitles provided by client (optional)
   * @param {string} guid - Podcast GUID for auto-generation (optional)
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds
   * @returns {Array} Array of subtitle objects with {text, start, end, confidence}
   */
  static async processSubtitlesForVideoEdit(clientSubtitles = null, guid = null, startTime, endTime) {
    const debugPrefix = `[SUBTITLE-UTILS][${Date.now()}]`;
    console.log(`${debugPrefix} Processing subtitles for video edit`);
    
    // Priority 1: Use client-provided subtitles if available
    if (clientSubtitles && Array.isArray(clientSubtitles) && clientSubtitles.length > 0) {
      console.log(`${debugPrefix} Using ${clientSubtitles.length} client-provided subtitles`);
      
      // Validate client subtitles format
      if (!SubtitleUtils.validateSubtitles(clientSubtitles)) {
        console.error(`${debugPrefix} Invalid client subtitle format, falling back to auto-generation`);
        return await SubtitleUtils.generateSubtitlesFromTranscript(guid, startTime, endTime);
      }
      
      // Adjust timestamps to be relative to video start if needed
      const adjustedSubtitles = SubtitleUtils.adjustSubtitleTimestamps(clientSubtitles, startTime);
      
      console.log(`${debugPrefix} Client subtitles processed successfully`);
      return adjustedSubtitles;
    }
    
    // Priority 2: Auto-generate from transcript if GUID is available
    if (guid) {
      console.log(`${debugPrefix} Auto-generating subtitles from transcript for GUID: ${guid}`);
      return await SubtitleUtils.generateSubtitlesFromTranscript(guid, startTime, endTime);
    }
    
    // No subtitles available
    console.log(`${debugPrefix} No subtitles available (no client subtitles and no GUID)`);
    return [];
  }
  
  /**
   * Generate subtitles from transcript JSON for any video edit
   * This is the shared logic that both make-clip and edit-video can use
   * 
   * @param {string} guid - Podcast GUID to fetch transcript for
   * @param {number} startTime - Start time in seconds
   * @param {number} endTime - End time in seconds
   * @returns {Array} Array of subtitle objects with {text, start, end, confidence}
   */
  static async generateSubtitlesFromTranscript(guid, startTime, endTime) {
    const debugPrefix = `[SUBTITLE-UTILS][${Date.now()}]`;
    console.log(`${debugPrefix} Generating subtitles for GUID: ${guid}, range: ${startTime}s-${endTime}s`);
    
    if (!guid) {
      console.error(`${debugPrefix} Missing GUID parameter`);
      throw new Error('Missing required parameter: guid');
    }
    
    if (startTime >= endTime) {
      console.error(`${debugPrefix} Invalid time range: startTime (${startTime}) >= endTime (${endTime})`);
      throw new Error(`Invalid time range: startTime (${startTime}) >= endTime (${endTime})`);
    }
    
    try {
      // Import the existing function from server.js
      // Note: This maintains compatibility with existing make-clip workflow
      const { getWordTimestampsFromFullTranscriptJSON } = require('../server');
      
      console.time(`${debugPrefix} Subtitle-Generation-Time`);
      const subtitles = await getWordTimestampsFromFullTranscriptJSON(guid, startTime, endTime);
      console.timeEnd(`${debugPrefix} Subtitle-Generation-Time`);
      
      if (!subtitles || !Array.isArray(subtitles)) {
        console.error(`${debugPrefix} Invalid subtitles returned: ${typeof subtitles}`);
        return [];
      }
      
      console.log(`${debugPrefix} Generated ${subtitles.length} subtitles`);
      return subtitles;
      
    } catch (error) {
      console.error(`${debugPrefix} Failed to generate subtitles: ${error.message}`);
      throw error;
    }
  }

  /**
   * Extract podcast GUID from CDN URL for video edits
   * This allows edit-video to use the same subtitle generation as make-clip
   * 
   * @param {string} cdnUrl - CDN URL of the uploaded video file
   * @returns {string|null} Podcast GUID if found, null otherwise
   */
  static extractGuidFromCdnUrl(cdnUrl) {
    const debugPrefix = `[SUBTITLE-UTILS][${Date.now()}]`;
    console.log(`${debugPrefix} Extracting GUID from CDN URL: ${cdnUrl}`);
    
    if (!cdnUrl || typeof cdnUrl !== 'string') {
      console.error(`${debugPrefix} Invalid CDN URL provided`);
      return null;
    }
    
    try {
      // Parse the CDN URL to extract the filename
      // Expected format: https://bucket.domain.com/jamie-pro/{feedId}/uploads/{timestamp}-{filename}.mp4
      const urlParts = cdnUrl.split('/');
      const fileName = urlParts[urlParts.length - 1];
      
      console.log(`${debugPrefix} Extracted filename: ${fileName}`);
      
      // Remove timestamp prefix and extension to get the base filename
      // Format: {timestamp}-{original-filename}.mp4
      const baseFileName = fileName.replace(/^\d+-/, '').replace(/\.[^/.]+$/, '');
      
      console.log(`${debugPrefix} Base filename: ${baseFileName}`);
      
      // TODO: This is a simplified approach. In practice, you might need to:
      // 1. Store GUID in the filename when uploading
      // 2. Store GUID in metadata during upload
      // 3. Use a different method to associate uploaded files with podcast episodes
      
      // For now, we'll return null and let the calling code handle this
      // This is where you'd implement the actual GUID extraction logic
      console.warn(`${debugPrefix} GUID extraction not yet implemented for CDN URLs`);
      return null;
      
    } catch (error) {
      console.error(`${debugPrefix} Error extracting GUID from CDN URL: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Convert subtitle array to SRT format for FFmpeg processing
   * 
   * DESIGN NOTE: This function is specific to the SRT + FFmpeg approach.
   * If we switch to Canvas rendering, this function becomes unused.
   * The subtitle array format remains the same regardless of rendering method.
   * 
   * @param {Array} subtitles - Array of subtitle objects with {text, start, end, confidence}
   * @param {string} outputPath - Path where SRT file should be written
   * @returns {Promise<string>} Path to the created SRT file
   */
  static async createSRTFile(subtitles, outputPath) {
    const debugPrefix = `[SUBTITLE-UTILS][${Date.now()}]`;
    console.log(`${debugPrefix} Creating SRT file with ${subtitles.length} subtitles`);
    
    if (!subtitles || !Array.isArray(subtitles) || subtitles.length === 0) {
      throw new Error('No subtitles provided for SRT creation');
    }
    
    try {
      let srtContent = '';
      
      subtitles.forEach((subtitle, index) => {
        // Validate subtitle format
        if (!subtitle.text || typeof subtitle.start !== 'number' || typeof subtitle.end !== 'number') {
          console.warn(`${debugPrefix} Skipping invalid subtitle at index ${index}:`, subtitle);
          return;
        }
        
        // Convert seconds to SRT time format (HH:MM:SS,mmm)
        const startTime = SubtitleUtils.formatSRTTime(subtitle.start);
        const endTime = SubtitleUtils.formatSRTTime(subtitle.end);
        
        // Add subtitle entry
        srtContent += `${index + 1}\n`;
        srtContent += `${startTime} --> ${endTime}\n`;
        srtContent += `${subtitle.text}\n\n`;
      });
      
      // Write SRT file
      await fs.promises.writeFile(outputPath, srtContent, 'utf8');
      
      console.log(`${debugPrefix} SRT file created: ${outputPath}`);
      return outputPath;
      
    } catch (error) {
      console.error(`${debugPrefix} Failed to create SRT file: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Convert seconds to SRT time format (HH:MM:SS,mmm)
   * 
   * @param {number} seconds - Time in seconds
   * @returns {string} SRT formatted time string
   */
  static formatSRTTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds % 1) * 1000);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`;
  }
  
  /**
   * Adjust subtitle timestamps to be relative to a new start time
   * This is useful when extracting segments from longer videos
   * 
   * DESIGN NOTE: This function is used by both make-clip and edit-video workflows.
   * It ensures subtitles are properly timed relative to the extracted segment.
   * 
   * @param {Array} subtitles - Array of subtitle objects
   * @param {number} offsetSeconds - Number of seconds to subtract from all timestamps
   * @returns {Array} Array of subtitle objects with adjusted timestamps
   */
  static adjustSubtitleTimestamps(subtitles, offsetSeconds) {
    const debugPrefix = `[SUBTITLE-UTILS][${Date.now()}]`;
    console.log(`${debugPrefix} Adjusting subtitle timestamps by -${offsetSeconds}s`);
    
    if (!subtitles || !Array.isArray(subtitles)) {
      return [];
    }
    
    return subtitles.map(subtitle => ({
      ...subtitle,
      start: Math.max(0, subtitle.start - offsetSeconds),
      end: Math.max(0, subtitle.end - offsetSeconds)
    }));
  }
  
  /**
   * Validate subtitle array format
   * 
   * @param {Array} subtitles - Array of subtitle objects to validate
   * @returns {boolean} True if valid, false otherwise
   */
  static validateSubtitles(subtitles) {
    if (!subtitles || !Array.isArray(subtitles)) {
      return false;
    }
    
    return subtitles.every(subtitle => 
      subtitle && 
      typeof subtitle.text === 'string' && 
      typeof subtitle.start === 'number' && 
      typeof subtitle.end === 'number' &&
      subtitle.start <= subtitle.end
    );
  }
  
  /**
   * ALTERNATIVE RENDERING APPROACH: Canvas-based subtitle rendering
   * 
   * DESIGN NOTE: This function is a placeholder for future Canvas-based rendering
   * if we decide to switch from SRT + FFmpeg back to Canvas rendering for edit-video.
   * 
   * Currently unused, but kept here to show how easy it would be to switch approaches.
   * 
   * @param {string} videoPath - Path to the video file
   * @param {Array} subtitles - Array of subtitle objects
   * @param {string} outputPath - Path for the output video with subtitles
   * @returns {Promise<string>} Path to the processed video
   */
  static async renderSubtitlesWithCanvas(videoPath, subtitles, outputPath) {
    const debugPrefix = `[SUBTITLE-UTILS][${Date.now()}]`;
    console.log(`${debugPrefix} Canvas subtitle rendering not yet implemented`);
    
    // TODO: If we switch to Canvas rendering, this would:
    // 1. Use VideoGenerator to add subtitles to the video
    // 2. Reuse the existing make-clip subtitle rendering logic
    // 3. Return the path to the processed video
    
    throw new Error('Canvas subtitle rendering not yet implemented');
  }
}

module.exports = SubtitleUtils;
