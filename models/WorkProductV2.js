const mongoose = require('mongoose');
const crypto = require('crypto');//force push

const WorkProductV2Schema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['ptuj-clip','on-demand-jamie-episodes','video-edit'],  // ✅ Correct type enforced
    required: true,
  },
  result: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
  },
  lookupHash: {
    type: String,
    required: true,
    unique: true, // ✅ Ensures deduplication
    index: true,  // ✅ Faster queries
  },
  cdnFileId: {
    type: String,
    required: false, // ✅ Filled when processing completes
  },
  status: {
    type: String,
    enum: ['queued', 'processing', 'completed', 'failed'],
    default: 'queued',
    required: false,
  },
});

/**
 * Generate a **deterministic** lookup hash based on clipId and timestamps.
 * Ensures that the same input always results in the same hash.
 *
 * @param {Object} clipData - The clip metadata.
 * @param {Array} timestamps - Optional override timestamps.
 * @returns {string} - A unique hash for the clip.
 */
const calculateLookupHash = (clipData, timestamps = null) => {
    console.log(`calculateLookupHash for clipData:${JSON.stringify(clipData,null,2)}`)
    console.log(`calculateLookupHash for timestamps:${JSON.stringify(timestamps,null,2)}`)
    
    // Correctly get feedId and guid from additionalFields
    const { feedId, guid } = clipData.additionalFields;
    const { shareLink } = clipData;

    let timeData = shareLink || ""
    if (timestamps && timestamps.length >= 2) {
        timeData = `${timestamps[0]}-${timestamps[1]}`
    }
    else {
        timeData = `${clipData.timeContext.start_time}-${clipData.timeContext.start_time}`
    }
    const lookupHash = crypto
    .createHash('sha256')
    .update(`${feedId}-${guid}-${timeData}`)
    .digest('hex');
    console.log(`calculated lookupHash:${lookupHash}`)
    return lookupHash
};

/**
 * Generate a deterministic lookup hash for video edit operations.
 * 
 * @param {string} cdnUrl - The source CDN URL 
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @param {boolean} useSubtitles - Whether subtitles are enabled
 * @returns {string} - A unique hash for the edit operation
 */
const calculateEditHash = (cdnUrl, startTime, endTime, useSubtitles = false) => {
    // Normalize inputs for consistency
    const normalizedUrl = cdnUrl.toLowerCase().trim();
    const normalizedStart = Math.round(startTime * 10) / 10; // Round to nearest 0.1
    const normalizedEnd = Math.round(endTime * 10) / 10;
    
    const hashInput = `edit:${normalizedUrl}:${normalizedStart}:${normalizedEnd}:${useSubtitles}`;
    const hash = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
    return `edit-${hash}`;
};

const WorkProductV2 = mongoose.model('WorkProductV2', WorkProductV2Schema);
module.exports = { WorkProductV2, calculateLookupHash, calculateEditHash };
