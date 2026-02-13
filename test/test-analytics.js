#!/usr/bin/env node
/**
 * Quick test script to verify analytics are being stored
 * 
 * Usage: DEBUG_MODE=true node test/test-analytics.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const mongoURI = process.env.DEBUG_MODE === 'true' 
  ? process.env.MONGO_DEBUG_URI 
  : process.env.MONGO_URI;

async function main() {
  console.log('Connecting to MongoDB...');
  console.log('DEBUG_MODE:', process.env.DEBUG_MODE);
  
  await mongoose.connect(mongoURI);
  console.log('Connected!\n');
  
  // Import after connection
  const { AnalyticsEvent } = require('../models/AnalyticsEvent');
  
  // Count all events
  const total = await AnalyticsEvent.countDocuments();
  console.log(`Total analytics events: ${total}`);
  
  // Get recent events
  const recent = await AnalyticsEvent.find()
    .sort({ server_timestamp: -1 })
    .limit(10)
    .lean();
  
  console.log('\nRecent events:');
  for (const event of recent) {
    console.log(`  - ${event.type} | session: ${event.session_id?.slice(0,8)}... | tier: ${event.tier} | ${event.timestamp}`);
  }
  
  // Count by type
  const byType = await AnalyticsEvent.aggregate([
    { $group: { _id: '$type', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
  
  console.log('\nEvents by type:');
  for (const t of byType) {
    console.log(`  - ${t._id}: ${t.count}`);
  }
  
  // Check for entitlement events specifically
  const entitlementEvents = await AnalyticsEvent.find({
    type: { $in: ['entitlement_consumed', 'entitlement_denied'] }
  }).sort({ server_timestamp: -1 }).limit(5).lean();
  
  console.log('\nRecent entitlement events:');
  if (entitlementEvents.length === 0) {
    console.log('  (none found)');
  } else {
    for (const e of entitlementEvents) {
      console.log(`  - ${e.type} | ${e.properties?.entitlement_type} | used: ${e.properties?.used}`);
    }
  }
  
  await mongoose.disconnect();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
