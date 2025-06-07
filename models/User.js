const mongoose = require('mongoose');

const PermissionsSchema = new mongoose.Schema({
  entitlementName: {
    type: String,
    required: true
  },
  usageThisPeriod: {
    type: Number,
    required: true,
    default: 0
  },
  periodStart: {
    type: Date,
    required: true,
    default: Date.now
  }
}, { _id: false }); // Don't create separate _id for subdocument

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  password: {
    type: String,
    required: true
  },
  squareCustomerId: {
    type: String,
    required: false
  },
  subscriptionId: {
    type: String,
    required: false
  },
  permissions: {
    type: PermissionsSchema,
    required: false, // Optional field for backward compatibility
    default: null
  }
}, {
  timestamps: false, // Don't add createdAt/updatedAt to match existing structure
  versionKey: '__v' // Keep the __v field to match existing structure
});

const User = mongoose.model('User', UserSchema);

module.exports = { User, PermissionsSchema }; 