const mongoose = require('mongoose');
const crypto = require('crypto');

const WorkProductV2Schema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['ptuj-clip'],  // ✅ Correct type enforced
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
    // console.log(`calculateLookupHash for clipData:${JSON.stringify(clipData,null,2)}`)
  let { feedId, guid, start_time, end_time, shareLink } = clipData;

  let timeData = shareLink || ""//either tether time data to clipId if that's all we have or timestamps if timestamp override happens
  if (timestamps && timestamps.length >= 2) {
    start_time = timestamps[0];
    end_time = timestamps[1];
    timeData = `${start_time}-${end_time}`
  }
  else{
    timeData = `${clipData.timeContext.start_time}-${clipData.timeContext.start_time}`//add this to ensure if they accidentally revert, we still capture that
  }

  return crypto
    .createHash('sha256')
    .update(`${feedId}-${guid}-${timeData}`)
    .digest('hex');
};

const WorkProductV2 = mongoose.model('WorkProductV2', WorkProductV2Schema);
module.exports = { WorkProductV2, calculateLookupHash };
