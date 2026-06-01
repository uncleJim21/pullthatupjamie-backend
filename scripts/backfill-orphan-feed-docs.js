/**
 * backfill-orphan-feed-docs.js
 *
 * Patch script: creates a minimal `type: 'feed'` doc in jamieVectorMetadata
 * for every feedId that has episode/paragraph docs but no canonical feed-type
 * doc. Surfaced by scripts/diag-feed-count.js — about 30 orphans currently.
 *
 * For each orphan we gather the best metadata available locally:
 *   - title          = paragraph.metadataRaw.creator (paragraphs carry the show name)
 *   - imageUrl       = episode.metadataRaw.episodeImage (best proxy; show + episode share artwork often)
 *   - hosts          = []  (no source)
 *   - description    = ""  (no source)
 *   - feedUrl        = ""  (no source)
 *   - publishedTs    = latest episode publishedTimestamp
 *
 * The doc is intentionally minimal — flagged with `cache.source = 'orphan-backfill-<date>'`
 * so the ingestor team can later overwrite with a full canonical pull. The
 * goal here is just to make /api/get-available-feeds return all feeds.
 *
 * Defaults to DRY-RUN. Pass --apply to actually write.
 *
 * Usage:
 *   node scripts/backfill-orphan-feed-docs.js                # dry-run
 *   node scripts/backfill-orphan-feed-docs.js --apply        # write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

const APPLY = process.argv.includes('--apply');
const TODAY = new Date().toISOString().slice(0, 10);
const SOURCE_TAG = `orphan-backfill-${TODAY}`;

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  if (!mongoURI) { console.error('MONGO_URI not set'); process.exit(1); }
  await mongoose.connect(mongoURI);

  console.log(`Mode: ${APPLY ? '\x1b[31mAPPLY (writing)\x1b[0m' : 'DRY-RUN (no writes)'}`);
  console.log(`Source tag: ${SOURCE_TAG}\n`);

  // 1. Identify orphans: feedIds present in episodes/paragraphs but no feed-type doc
  console.log('Identifying orphans…');
  const [feedIdsInEpisodes, feedIdsInParagraphs, feedIdsWithDoc] = await Promise.all([
    JamieVectorMetadata.distinct('feedId', { type: 'episode',   feedId: { $exists: true, $ne: null } }),
    JamieVectorMetadata.distinct('feedId', { type: 'paragraph', feedId: { $exists: true, $ne: null } }),
    JamieVectorMetadata.distinct('feedId', { type: 'feed',      feedId: { $exists: true, $ne: null } }),
  ]);
  const docSet = new Set(feedIdsWithDoc.map(String));
  const orphanSet = new Set([
    ...feedIdsInEpisodes.map(String),
    ...feedIdsInParagraphs.map(String),
  ].filter(id => !docSet.has(id)));
  // Also skip the suspicious "0" feedId (4 docs from an old test)
  orphanSet.delete('0');
  const orphans = Array.from(orphanSet);

  console.log(`Found ${orphans.length} orphan feedId(s) (excluding "0").\n`);

  const plan = [];
  for (const feedId of orphans) {
    // Pull best-available metadata
    const [latestEp, anyParagraph] = await Promise.all([
      JamieVectorMetadata.findOne({ type: 'episode', feedId })
        .sort({ publishedTimestamp: -1 })
        .select('publishedTimestamp metadataRaw')
        .lean(),
      JamieVectorMetadata.findOne({ type: 'paragraph', feedId })
        .select('metadataRaw')
        .lean(),
    ]);

    const title = anyParagraph?.metadataRaw?.creator
      || latestEp?.metadataRaw?.creator
      || latestEp?.metadataRaw?.feedTitle
      || `Feed ${feedId}`;
    const imageUrl = latestEp?.metadataRaw?.episodeImage
      || anyParagraph?.metadataRaw?.episodeImage
      || '';
    const publishedTimestamp = latestEp?.publishedTimestamp
      || latestEp?.metadataRaw?.publishedTimestamp
      || null;

    const epCount = await JamieVectorMetadata.countDocuments({ type: 'episode', feedId });

    const doc = {
      pineconeId: `feed_${feedId}`,
      type: 'feed',
      feedId,
      publishedTimestamp,
      creator: title,
      episode: title,
      episodeImage: imageUrl,
      metadataRaw: {
        type: 'feed',
        feedId,
        title,
        author: title,
        description: '',
        language: '',
        feedUrl: '',
        imageUrl,
        lastUpdateTime: publishedTimestamp ? Math.floor(publishedTimestamp / 1000) : null,
        explicit: false,
        episodeCount: epCount,
        feedType: 'mixed',
        hosts: [],
        backfilled: true,
      },
      cache: {
        trialId: SOURCE_TAG,
        chunkFile: null,
        updatedAt: new Date(),
      },
    };

    plan.push({ feedId, epCount, title, imageUrl: !!imageUrl, doc });
  }

  // 2. Print plan
  console.log(`${'feedId'.padEnd(14)}${'epCount'.padStart(8)}  ${'img'.padEnd(4)} title`);
  console.log('─'.repeat(110));
  for (const p of plan) {
    console.log(`${p.feedId.padEnd(14)}${String(p.epCount).padStart(8)}  ${(p.imageUrl ? 'yes' : 'no').padEnd(4)} ${p.title.slice(0, 70)}`);
  }
  console.log('');

  if (!APPLY) {
    console.log(`\x1b[33mDry-run only. Re-run with --apply to write these ${plan.length} docs.\x1b[0m`);
    await mongoose.disconnect();
    return;
  }

  // 3. Apply — one upsert per feed, sequentially so a failure surfaces clearly
  console.log(`Writing ${plan.length} feed-type docs…\n`);
  let created = 0;
  let updated = 0;
  let failed = 0;
  for (const p of plan) {
    try {
      const existing = await JamieVectorMetadata.findOne({ type: 'feed', feedId: p.feedId }).lean();
      if (existing) {
        // Shouldn't happen given the orphan check, but defensive — log and skip
        console.log(`  skip ${p.feedId} — feed doc already exists (raced)`);
        updated++;
        continue;
      }
      await JamieVectorMetadata.create(p.doc);
      console.log(`  ✓ created feed ${p.feedId}  "${p.title.slice(0, 50)}"`);
      created++;
    } catch (err) {
      console.error(`  ✘ failed ${p.feedId}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone: created=${created}, raced-skip=${updated}, failed=${failed}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
