const mongoose = require('mongoose');

const WorkProductV2Schema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['rss transcript', 'rss analysis', 'legacy', 'trevi transcript'], // Restrict values to the specified enum
    required: true, // 'type' is required
  },
  result: {
    type: mongoose.Schema.Types.Mixed, // Allows for any type of object
    required: false, // 'result' is optional, probably wont get used for now
    // but helps with future proofing
  },
  lookupHash: {
    type: String,
    required: true, // 'lookupHash' is required
  },
  cdnFileId: {
    type: String,
    required: false, // 'cdnFileId' is optional
    //should include file extension
  },
  successAction: {
    type: mongoose.Schema.Types.Mixed, // Allows for any type of object
    required: false, // 'successAction' is optional
  },
  authCategory: {
    type: Number,
    required: false, // 'authCategory' is optional
  },
  paymentHash: {
    type: String,
    required: false, // 'paymentHash' is optional
  },
});

WorkProductV2 = mongoose.model('WorkProductV2', WorkProductV2Schema);
module.exports = WorkProductV2;
