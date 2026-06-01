/**
 * audit-paragraph-denorm.js — READ-ONLY.
 *
 * Samples N episodes and their paragraphs from prod jamieVectorMetadata,
 * compares each paragraph's metadataRaw against the parent episode's
 * metadataRaw, and reports which fields are byte-identical duplicates.
 * For confirmed duplicates, also reports the per-paragraph byte cost so
 * we can project the savings.
 *
 * Doesn't print transcript text — only field-presence + size stats.
 *
 * Defaults: 10 episodes (~2000 paragraphs). Override via SAMPLE_EPISODES env.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

const SAMPLE_EPISODES = parseInt(process.env.SAMPLE_EPISODES || '10', 10);

// Candidate fields that, by convention, should be episode-level and
// repeated across all paragraphs of the same episode. Audit will confirm
// or deny each.
const CANDIDATES = [
  'creator',
  'episode',
  'episodeImage',
  'listenLink',
  'audioUrl',
  'feedTitle',
  'feedImage',
  'publishedDate',
  'publishedTimestamp',
  'publishedYear',
  'publishedMonth',
];

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Approximate BSON encoding cost: key length + 1 byte type marker +
// length prefix + value length. Good enough for sizing.
function approxBsonFieldBytes(key, value) {
  const keyBytes = Buffer.byteLength(key, 'utf8') + 1; // null terminator
  const typeByte = 1;
  if (value === null || value === undefined) return keyBytes + typeByte;
  if (typeof value === 'number') return keyBytes + typeByte + 8; // assume int64/double
  if (typeof value === 'boolean') return keyBytes + typeByte + 1;
  if (typeof value === 'string') return keyBytes + typeByte + 4 + Buffer.byteLength(value, 'utf8') + 1;
  return keyBytes + typeByte + Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function main() {
  const uri = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  await mongoose.connect(uri);

  console.log(`Sampling ${SAMPLE_EPISODES} random episodes…`);
  const episodes = await JamieVectorMetadata.aggregate([
    { $match: { type: 'episode' } },
    { $sample: { size: SAMPLE_EPISODES } },
    { $project: { guid: 1, metadataRaw: 1, _id: 0 } },
  ]);
  console.log(`Got ${episodes.length} episodes.\n`);

  const fieldStats = {};
  for (const f of CANDIDATES) {
    fieldStats[f] = { match: 0, mismatch: 0, missingEp: 0, missingP: 0, bytesPerOccurrence: 0, bytesSamples: 0 };
  }
  let totalParagraphs = 0;
  let totalParagraphBytes = 0;

  for (const ep of episodes) {
    const epMeta = ep.metadataRaw || {};
    const paragraphs = await JamieVectorMetadata.find({ type: 'paragraph', guid: ep.guid })
      .select('metadataRaw')
      .lean();
    totalParagraphs += paragraphs.length;
    console.log(`Episode ${ep.guid?.slice(0, 30)}…  paragraphs=${paragraphs.length}`);
    for (const p of paragraphs) {
      const pMeta = p.metadataRaw || {};
      totalParagraphBytes += Buffer.byteLength(JSON.stringify(pMeta), 'utf8');
      for (const f of CANDIDATES) {
        const stat = fieldStats[f];
        const inEp = epMeta[f] !== undefined && epMeta[f] !== null && epMeta[f] !== '';
        const inP = pMeta[f] !== undefined && pMeta[f] !== null && pMeta[f] !== '';
        if (!inEp && !inP) continue;
        if (!inEp) { stat.missingEp++; continue; }
        if (!inP)  { stat.missingP++;  continue; }
        const same = JSON.stringify(pMeta[f]) === JSON.stringify(epMeta[f]);
        if (same) {
          stat.match++;
          stat.bytesPerOccurrence += approxBsonFieldBytes(f, pMeta[f]);
          stat.bytesSamples++;
        } else {
          stat.mismatch++;
        }
      }
    }
  }

  // Report per-field
  console.log(`\n═══ AUDIT — ${totalParagraphs.toLocaleString()} paragraphs across ${episodes.length} episodes ═══\n`);
  console.log(`${'field'.padEnd(22)}${'match'.padStart(8)}${'mismatch'.padStart(10)}${'no-ep'.padStart(8)}${'no-p'.padStart(8)}${'avg bytes'.padStart(12)}  ${'verdict'}`);
  let safeFields = [];
  let totalBytesSavedPerParagraph = 0;
  for (const [f, s] of Object.entries(fieldStats)) {
    const avgBytes = s.bytesSamples > 0 ? Math.round(s.bytesPerOccurrence / s.bytesSamples) : 0;
    const matchRate = s.match / Math.max(1, s.match + s.mismatch + s.missingP + s.missingEp);
    const safe = s.mismatch === 0 && s.match > 0;
    const verdict = safe
      ? `✓ duplicate (${(matchRate * 100).toFixed(0)}% of pairs)`
      : (s.mismatch > 0 ? `✘ values differ in ${s.mismatch} pairs` : `— field not commonly present`);
    console.log(
      `${f.padEnd(22)}${String(s.match).padStart(8)}${String(s.mismatch).padStart(10)}${String(s.missingEp).padStart(8)}${String(s.missingP).padStart(8)}${(avgBytes + ' B').padStart(12)}  ${verdict}`
    );
    if (safe) {
      safeFields.push(f);
      totalBytesSavedPerParagraph += avgBytes;
    }
  }

  // Projection
  const totalSampledParagraphBytes = totalParagraphBytes;
  const avgParagraphBytes = totalParagraphBytes / totalParagraphs;
  const corpusParagraphCount = await JamieVectorMetadata.estimatedDocumentCount({ type: 'paragraph' });

  console.log(`\n═══ PROJECTION ═══\n`);
  console.log(`Avg paragraph BSON size (sampled): ${fmtBytes(avgParagraphBytes)}`);
  console.log(`Safe-to-dehydrate fields: ${safeFields.join(', ') || '(none)'}`);
  console.log(`Bytes saved per paragraph (sum of safe fields): ~${totalBytesSavedPerParagraph} B`);
  console.log(`As share of paragraph BSON: ~${((totalBytesSavedPerParagraph / avgParagraphBytes) * 100).toFixed(1)}%`);
  console.log('');
  const corpusParagraphCountActual = corpusParagraphCount || (await JamieVectorMetadata.countDocuments({ type: 'paragraph' }));
  const projUncompressed = totalBytesSavedPerParagraph * corpusParagraphCountActual;
  // WiredTiger snappy compression typically gets ~50-65% on JSON-like data
  // — we saw ~65% on chapter test coll. Use 60% as a conservative estimate.
  const projCompressed = projUncompressed * 0.40; // ~60% reduction → 40% on disk
  console.log(`Corpus paragraph count: ${corpusParagraphCountActual.toLocaleString()}`);
  console.log(`Projected uncompressed savings: ${fmtBytes(projUncompressed)}`);
  console.log(`Projected on-disk savings (after WiredTiger compression):  ${fmtBytes(projCompressed)}`);
  console.log('');

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
