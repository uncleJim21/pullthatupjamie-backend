/**
 * run-denorm-on-chapter-test.js
 *
 * In-place dehydration test on jamieVectorMetadataChapterTest.
 * Strips episode-level duplicate fields from every chapter doc, then
 * reports size change, hydration accuracy, and read-path speed.
 *
 * Destructive on the test collection. Source-of-truth chapter data still
 * lives in prod jamieVectorMetadata; this coll can be re-augmented from
 * scratch if needed.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { hydrateWithEpisodes, HYDRATABLE_EPISODE_FIELDS } = require('../utils/episodeHydration');

const COLL = 'jamieVectorMetadataChapterTest';
const ACCURACY_SAMPLE = 200;   // docs to snapshot for byte-equality check
const SPEED_REPS = 100;        // read iterations to time
const SPEED_BATCH = 5;         // docs per read

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function main() {
  const uri = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  const conn = await mongoose.connect(uri);
  const db = conn.connection.db;
  const coll = db.collection(COLL);

  // 1. BEFORE — collStats snapshot
  const before = await db.command({ collStats: COLL });
  console.log('═══ BEFORE ═══');
  console.log(`  docs:        ${before.count.toLocaleString()}`);
  console.log(`  size:        ${fmtBytes(before.size)}`);
  console.log(`  avg/doc:     ${fmtBytes(before.size / before.count)}`);
  console.log(`  storage:     ${fmtBytes(before.storageSize)} (incl. compression)`);
  console.log('');

  // 2. Accuracy snapshot — capture 200 originals in memory before mutation
  console.log(`Snapshotting ${ACCURACY_SAMPLE} originals for accuracy check…`);
  const originalSample = await coll.aggregate([
    { $sample: { size: ACCURACY_SAMPLE } },
  ]).toArray();
  const originalById = new Map();
  for (const d of originalSample) originalById.set(String(d.pineconeId), d);
  console.log(`  captured ${originalById.size} originals.\n`);

  // 3. BEFORE speed — time 100 reads of original (hydrated) docs
  console.log(`Timing ${SPEED_REPS} reads BEFORE dehydration…`);
  const sampleIds = originalSample.slice(0, SPEED_REPS * SPEED_BATCH).map(d => d.pineconeId);
  const beforeTimes = [];
  for (let i = 0; i < SPEED_REPS; i++) {
    const batch = sampleIds.slice(i * SPEED_BATCH, (i + 1) * SPEED_BATCH);
    const t0 = Date.now();
    await coll.find({ pineconeId: { $in: batch } }).toArray();
    beforeTimes.push(Date.now() - t0);
  }
  beforeTimes.sort((a, b) => a - b);
  console.log(`  read direct (hydrated already)   p50=${pct(beforeTimes, 50)}ms  p95=${pct(beforeTimes, 95)}ms\n`);

  // 4. AUDIT — which fields appear to be denormalized duplicates of episodes
  console.log(`Auditing field duplication across 20 random episodes…`);
  const epSample = await JamieVectorMetadata.aggregate([
    { $match: { type: 'episode' } },
    { $sample: { size: 20 } },
    { $project: { guid: 1, metadataRaw: 1, _id: 0 } },
  ]);
  const fieldStats = {};
  for (const ep of epSample) {
    const chapters = await coll.find({ type: 'chapter', guid: ep.guid }).project({ metadataRaw: 1 }).toArray();
    for (const ch of chapters) {
      for (const f of HYDRATABLE_EPISODE_FIELDS) {
        if (!fieldStats[f]) fieldStats[f] = { match: 0, mismatch: 0, missing: 0 };
        const inCh = ch.metadataRaw?.[f] !== undefined;
        const inEp = ep.metadataRaw?.[f] !== undefined;
        if (!inCh && !inEp) { fieldStats[f].missing++; continue; }
        if (!inCh) { fieldStats[f].missing++; continue; }
        if (!inEp) { fieldStats[f].mismatch++; continue; }
        if (JSON.stringify(ch.metadataRaw[f]) === JSON.stringify(ep.metadataRaw[f])) fieldStats[f].match++;
        else fieldStats[f].mismatch++;
      }
    }
  }
  const stripFields = [];
  console.log(`  field                  match  mismatch  missing  verdict`);
  for (const [f, s] of Object.entries(fieldStats)) {
    const safe = s.mismatch === 0 && s.match > 0;
    if (safe) stripFields.push(f);
    console.log(`  ${f.padEnd(22)} ${String(s.match).padStart(5)} ${String(s.mismatch).padStart(9)} ${String(s.missing).padStart(8)}  ${safe ? '✓ strip' : '— keep'}`);
  }
  console.log(`\nStripping these fields from ALL chapters: ${stripFields.join(', ') || '(none)'}\n`);

  if (stripFields.length === 0) {
    console.log('No duplicate fields found. Aborting dehydration.');
    await mongoose.disconnect();
    return;
  }

  // 5. MUTATION — strip duplicate fields from every chapter doc
  console.log(`Running $unset across ${before.count.toLocaleString()} docs…`);
  const unsetSpec = {};
  for (const f of stripFields) unsetSpec[`metadataRaw.${f}`] = '';
  const mutStart = Date.now();
  const updateResult = await coll.updateMany({ type: 'chapter' }, { $unset: unsetSpec });
  console.log(`  matched=${updateResult.matchedCount}  modified=${updateResult.modifiedCount}  elapsed=${(Date.now() - mutStart) / 1000}s\n`);

  // Compact via collMod-style reclaim isn't always available on shared
  // tiers; instead query stats after a brief settle and read storageSize.
  // (size = uncompressed BSON; storageSize = on-disk after compression.)
  const after = await db.command({ collStats: COLL });
  console.log('═══ AFTER ═══');
  console.log(`  docs:        ${after.count.toLocaleString()}`);
  console.log(`  size:        ${fmtBytes(after.size)}`);
  console.log(`  avg/doc:     ${fmtBytes(after.size / after.count)}`);
  console.log(`  storage:     ${fmtBytes(after.storageSize)} (incl. compression)`);
  console.log('');
  console.log('═══ DELTA ═══');
  const sizeSaved = before.size - after.size;
  const storageSaved = before.storageSize - after.storageSize;
  console.log(`  uncompressed savings: ${fmtBytes(sizeSaved)}  (${((sizeSaved / before.size) * 100).toFixed(1)}%)`);
  console.log(`  on-disk savings:      ${fmtBytes(storageSaved)}  (${((storageSaved / before.storageSize) * 100).toFixed(1)}%)`);
  console.log(`  avg doc shrink:       ${fmtBytes((before.size / before.count) - (after.size / after.count))}`);
  console.log('');
  // Project to paragraph corpus
  const paragraphCount = 9700000;
  const projParagraph = ((before.size / before.count) - (after.size / after.count)) * paragraphCount;
  console.log(`  projection to ~9.7M paragraphs (assuming similar denorm tax): ${fmtBytes(projParagraph)}\n`);

  // 6. ACCURACY — read 200 sample docs back, hydrate, byte-diff vs originals
  console.log(`Verifying byte-equality on ${originalById.size} samples after hydration…`);
  const sampleIds2 = [...originalById.keys()];
  const dehydratedDocs = await coll.find({ pineconeId: { $in: sampleIds2 } }).toArray();
  await hydrateWithEpisodes(dehydratedDocs, JamieVectorMetadata);
  let ok = 0, bad = 0;
  const badExamples = [];
  for (const h of dehydratedDocs) {
    const orig = originalById.get(String(h.pineconeId));
    if (!orig) continue;
    let identical = true;
    const diffs = [];
    for (const f of stripFields) {
      const o = JSON.stringify(orig.metadataRaw?.[f]);
      const n = JSON.stringify(h.metadataRaw?.[f]);
      if (o !== n) { identical = false; diffs.push({ field: f, orig: (o || '').slice(0, 60), hyd: (n || '').slice(0, 60) }); }
    }
    if (identical) ok++;
    else { bad++; if (badExamples.length < 3) badExamples.push({ pid: h.pineconeId, diffs }); }
  }
  console.log(`  identical-after-hydration: ${ok}/${dehydratedDocs.length}`);
  console.log(`  differing:                 ${bad}`);
  for (const b of badExamples) {
    console.log(`    ${b.pid}:`);
    for (const d of b.diffs) console.log(`      ${d.field}: orig=${d.orig} hyd=${d.hyd}`);
  }
  console.log('');

  // 7. AFTER speed — time 100 reads + hydrate on the now-dehydrated coll
  console.log(`Timing ${SPEED_REPS} reads AFTER dehydration (with hydration helper)…`);
  const afterTimes = [];
  for (let i = 0; i < SPEED_REPS; i++) {
    const batch = sampleIds.slice(i * SPEED_BATCH, (i + 1) * SPEED_BATCH);
    const t0 = Date.now();
    const docs = await coll.find({ pineconeId: { $in: batch } }).toArray();
    await hydrateWithEpisodes(docs, JamieVectorMetadata);
    afterTimes.push(Date.now() - t0);
  }
  afterTimes.sort((a, b) => a - b);
  console.log(`  read + hydrate                    p50=${pct(afterTimes, 50)}ms  p95=${pct(afterTimes, 95)}ms\n`);

  console.log('═══ SUMMARY ═══');
  console.log(`  Speed:    p50 ${pct(beforeTimes, 50)}ms → ${pct(afterTimes, 50)}ms  (Δ +${pct(afterTimes, 50) - pct(beforeTimes, 50)}ms)`);
  console.log(`            p95 ${pct(beforeTimes, 95)}ms → ${pct(afterTimes, 95)}ms  (Δ +${pct(afterTimes, 95) - pct(beforeTimes, 95)}ms)`);
  console.log(`  Accuracy: ${ok}/${dehydratedDocs.length} identical after hydration`);
  console.log(`  Size:     ${fmtBytes(before.size)} → ${fmtBytes(after.size)}  (saved ${fmtBytes(sizeSaved)}, ${((sizeSaved / before.size) * 100).toFixed(1)}%)`);
  console.log(`  Storage:  ${fmtBytes(before.storageSize)} → ${fmtBytes(after.storageSize)}  (saved ${fmtBytes(storageSaved)}, ${((storageSaved / before.storageSize) * 100).toFixed(1)}%)`);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
