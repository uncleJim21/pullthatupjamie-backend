/**
 * diag-feed-count.js
 *
 * One-shot read-only diagnostic. Cross-checks four ways of counting feeds
 * in `jamieVectorMetadata` to surface any mismatch between the canonical
 * feed-type docs and the actual feedIds present in episodes/paragraphs.
 *
 * If the numbers diverge, the feed-type docs aren't populating correctly
 * and /api/get-available-feeds (which counts those) is undercounting.
 *
 * Safe against prod. Read-only.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true'
    ? process.env.MONGO_DEBUG_URI
    : process.env.MONGO_URI;
  if (!mongoURI) { console.error('MONGO_URI not set'); process.exit(1); }

  console.log('Connecting…');
  await mongoose.connect(mongoURI);
  console.log('Connected.\n');

  // 1. How many feed-type docs exist (what /api/get-available-feeds returns)
  const feedDocCount = await JamieVectorMetadata.countDocuments({ type: 'feed' });

  // 2. How many distinct feedIds appear in episode docs
  const distinctFeedIdsInEpisodes = await JamieVectorMetadata.distinct('feedId', {
    type: 'episode',
    feedId: { $exists: true, $ne: null },
  });

  // 3. How many distinct feedIds appear in paragraph docs
  const distinctFeedIdsInParagraphs = await JamieVectorMetadata.distinct('feedId', {
    type: 'paragraph',
    feedId: { $exists: true, $ne: null },
  });

  // 4. Total docs per type for context
  const totals = {};
  for (const type of ['feed', 'episode', 'paragraph', 'chapter']) {
    totals[type] = await JamieVectorMetadata.countDocuments({ type });
  }

  console.log('Per-type doc counts:');
  for (const [t, n] of Object.entries(totals)) {
    console.log(`  ${t.padEnd(10)} ${n.toLocaleString()}`);
  }

  console.log('\nFeed-count comparison:');
  console.log(`  feed-type docs:                  ${feedDocCount.toLocaleString()}`);
  console.log(`  distinct feedIds in episodes:    ${distinctFeedIdsInEpisodes.length.toLocaleString()}`);
  console.log(`  distinct feedIds in paragraphs:  ${distinctFeedIdsInParagraphs.length.toLocaleString()}`);

  // 5. Surface feedIds that have episodes but NO feed-type doc
  if (distinctFeedIdsInEpisodes.length !== feedDocCount) {
    const feedIdsWithDoc = await JamieVectorMetadata.distinct('feedId', {
      type: 'feed',
      feedId: { $exists: true, $ne: null },
    });
    const feedDocSet = new Set(feedIdsWithDoc.map(String));
    const orphans = distinctFeedIdsInEpisodes
      .map(String)
      .filter(id => !feedDocSet.has(id));
    console.log(`\n⚠ Mismatch detected: ${orphans.length} feedId(s) have episodes but no feed-type doc.`);
    if (orphans.length > 0) {
      // Per-orphan: episode count + most recent episode + sample title from any episode doc
      console.log(`\nOrphan feedIds (have episodes, no feed-type doc):`);
      console.log(`${'feedId'.padEnd(14)}${'episodes'.padStart(10)}  most recent              sample episode title`);
      console.log('─'.repeat(110));
      const orphansToShow = orphans.slice(0, 30); // cap output
      for (const feedId of orphansToShow) {
        const epCount = await JamieVectorMetadata.countDocuments({ type: 'episode', feedId });
        const latest = await JamieVectorMetadata.findOne({ type: 'episode', feedId })
          .sort({ publishedTimestamp: -1 })
          .select('publishedDate publishedTimestamp metadataRaw.title metadataRaw.feedTitle')
          .lean();
        const dateStr = latest?.publishedDate
          ? latest.publishedDate.slice(0, 10)
          : (latest?.publishedTimestamp ? new Date(latest.publishedTimestamp).toISOString().slice(0, 10) : 'unknown');
        const title = (latest?.metadataRaw?.title || latest?.metadataRaw?.feedTitle || '(no title)').slice(0, 50);
        console.log(`${feedId.padEnd(14)}${String(epCount).padStart(10)}  ${dateStr.padEnd(24)} ${title}`);
      }
      if (orphans.length > 30) {
        console.log(`  … and ${orphans.length - 30} more`);
      }
    }
  } else {
    console.log('\n✓ feed-type docs match distinct feedIds in episodes.');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
