/**
 * audit-paragraph-bsonsize.js — READ-ONLY.
 *
 * Uses Mongo's $bsonSize operator on a random sample of 1000 paragraphs
 * to measure the exact byte savings of dehydrating to a lean schema.
 * This is the most accurate possible projection short of actually
 * running the dehydration — $bsonSize returns the literal on-wire BSON
 * byte count for each document.
 *
 * The "lean" schema is intentionally minimal: only fields required for
 * Pinecone-join (pineconeId), feed-grouping (guid), ordering (sequence,
 * start_time, end_time), display (num_words), and the text itself.
 * Everything else gets rehydrated from the parent episode doc at read
 * time via utils/episodeHydration.js.
 *
 * Also includes sanity-check sizes for the text field at both possible
 * locations ($text vs $metadataRaw.text) so we know which one the lean
 * projection is actually picking up.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const CORPUS_PARAGRAPHS = 12_107_919; // from prior audit

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n.toFixed(1)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function main() {
  const uri = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  const conn = await mongoose.connect(uri);
  const db = conn.connection.db;
  const coll = db.collection('jamieVectorMetadata');

  console.log('Sampling 1000 random paragraphs and measuring $bsonSize…\n');

  const result = await coll.aggregate([
    { $match: { type: 'paragraph' } },
    { $sample: { size: 1000 } },
    {
      $project: {
        currentSize: { $bsonSize: '$$ROOT' },
        metadataRawSize: { $bsonSize: '$metadataRaw' },
        // sanity: where does the text actually live?
        topLevelTextSize: { $bsonSize: { t: { $ifNull: ['$text', null] } } },
        metadataRawTextSize: { $bsonSize: { t: { $ifNull: ['$metadataRaw.text', null] } } },
        leanDoc: {
          pineconeId: '$pineconeId',
          guid: '$guid',
          sequence: '$metadataRaw.sequence',
          start_time: '$start_time',
          end_time: '$end_time',
          num_words: '$metadataRaw.num_words',
          text: '$text',
        },
        // also measure a lean doc that pulls text from metadataRaw.text
        leanDocFromMetadata: {
          pineconeId: '$pineconeId',
          guid: '$guid',
          sequence: '$metadataRaw.sequence',
          start_time: '$start_time',
          end_time: '$end_time',
          num_words: '$metadataRaw.num_words',
          text: '$metadataRaw.text',
        },
      },
    },
    {
      $project: {
        currentSize: 1,
        metadataRawSize: 1,
        topLevelTextSize: 1,
        metadataRawTextSize: 1,
        leanSize: { $bsonSize: '$leanDoc' },
        leanFromMetadataSize: { $bsonSize: '$leanDocFromMetadata' },
        fullLeanSavings: { $subtract: ['$currentSize', { $bsonSize: '$leanDoc' }] },
        fullLeanFromMetadataSavings: { $subtract: ['$currentSize', { $bsonSize: '$leanDocFromMetadata' }] },
      },
    },
    {
      $group: {
        _id: null,
        samples: { $sum: 1 },
        avgCurrentSize: { $avg: '$currentSize' },
        avgMetadataRawSize: { $avg: '$metadataRawSize' },
        avgTopLevelTextSize: { $avg: '$topLevelTextSize' },
        avgMetadataRawTextSize: { $avg: '$metadataRawTextSize' },
        avgLeanSize: { $avg: '$leanSize' },
        avgLeanFromMetadataSize: { $avg: '$leanFromMetadataSize' },
        avgFullLeanSavings: { $avg: '$fullLeanSavings' },
        avgFullLeanFromMetadataSavings: { $avg: '$fullLeanFromMetadataSavings' },
      },
    },
  ]).toArray();

  const r = result[0];
  console.log('═══ $bsonSize RESULTS (per-paragraph averages from sample) ═══\n');
  console.log(`  samples:                              ${r.samples}`);
  console.log(`  avg current BSON size:                ${fmtBytes(r.avgCurrentSize)}`);
  console.log(`  avg metadataRaw size:                 ${fmtBytes(r.avgMetadataRawSize)}`);
  console.log(`  avg $text size (top-level):           ${fmtBytes(r.avgTopLevelTextSize)}  ${r.avgTopLevelTextSize < 30 ? '(empty — text not at top level)' : ''}`);
  console.log(`  avg $metadataRaw.text size:           ${fmtBytes(r.avgMetadataRawTextSize)}`);
  console.log('');
  console.log(`  avg lean doc size (text from $text):           ${fmtBytes(r.avgLeanSize)}`);
  console.log(`  avg lean doc size (text from metadataRaw.text): ${fmtBytes(r.avgLeanFromMetadataSize)}`);
  console.log('');
  console.log(`  avg savings per doc (lean from $text):           ${fmtBytes(r.avgFullLeanSavings)}`);
  console.log(`  avg savings per doc (lean from metadataRaw.text): ${fmtBytes(r.avgFullLeanFromMetadataSavings)}`);
  console.log('');

  // Pick the right lean number based on where text actually lives
  const textAtTopLevel = r.avgTopLevelTextSize > 50; // tiny wrapper overhead ~30B if null
  const effectiveSavings = textAtTopLevel ? r.avgFullLeanSavings : r.avgFullLeanFromMetadataSavings;
  const leanLocation = textAtTopLevel ? 'top-level $text' : 'metadataRaw.text';

  console.log(`═══ PROJECTION across ${CORPUS_PARAGRAPHS.toLocaleString()} paragraphs ═══\n`);
  console.log(`  text field located at: ${leanLocation}`);
  console.log(`  effective avg savings per doc: ${fmtBytes(effectiveSavings)}`);
  console.log('');

  const rawTotal = effectiveSavings * CORPUS_PARAGRAPHS;
  console.log(`  Raw theoretical savings (uncompressed BSON): ${fmtBytes(rawTotal)}`);
  console.log('');
  console.log(`  Real on-disk savings depends on WiredTiger compression + compaction:`);
  console.log(`    Conservative (30% of raw realized):   ${fmtBytes(rawTotal * 0.30)}`);
  console.log(`    Middle (50% of raw realized):         ${fmtBytes(rawTotal * 0.50)}`);
  console.log(`    Optimistic (70% of raw realized):     ${fmtBytes(rawTotal * 0.70)}`);
  console.log('');

  const currentDiskGB = 38.69; // jamieVectorMetadata on-disk storage from prior audit
  console.log(`  Current jamieVectorMetadata on-disk: ${currentDiskGB} GB`);
  console.log(`    Conservative new size:  ${(currentDiskGB - (rawTotal * 0.30) / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`    Middle new size:        ${(currentDiskGB - (rawTotal * 0.50) / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`    Optimistic new size:    ${(currentDiskGB - (rawTotal * 0.70) / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log('');

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
