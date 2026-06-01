/**
 * inspect-feed-doc.js — read-only. Prints one sample feed-type doc and one
 * sample paragraph for an orphan feedId so we can see exactly what fields
 * a feed doc carries vs what we'd have available to backfill with.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  await mongoose.connect(mongoURI);

  // 1. Sample existing feed-type doc — what shape should we mirror?
  const sampleFeed = await JamieVectorMetadata.findOne({ type: 'feed' }).lean();
  console.log('═══ SAMPLE EXISTING feed-type doc ═══');
  console.log(JSON.stringify(sampleFeed, null, 2));

  console.log('\n═══ SAMPLE paragraph from an orphan feedId (541102) ═══');
  const orphanParagraph = await JamieVectorMetadata.findOne({ type: 'paragraph', feedId: '541102' })
    .select('feedId metadataRaw')
    .lean();
  // Trim text + irrelevant per-paragraph fields to focus on feed-level metadata
  if (orphanParagraph?.metadataRaw) {
    const m = orphanParagraph.metadataRaw;
    const feedish = {};
    for (const k of Object.keys(m)) {
      if (/feed|show|podcast|creator|publisher/i.test(k)) feedish[k] = m[k];
    }
    console.log('feed-related fields from a paragraph:');
    console.log(JSON.stringify(feedish, null, 2));
    console.log('\nfull metadataRaw keys:', Object.keys(m));
  }

  await mongoose.disconnect();
}
main().catch(err => { console.error(err); process.exit(1); });
