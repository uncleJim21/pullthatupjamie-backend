/**
 * test-denorm-hydration.js
 *
 * Composite test for the dehydration → hydrate-on-read pattern.
 * Runs against the chapter test collection (jamieVectorMetadataChapterTest)
 * since it's already populated and disposable. The technique generalizes
 * directly to paragraphs.
 *
 * Steps:
 *   1. AUDIT: sample 10 episodes, dump chapter + parent episode fields,
 *      identify which chapter.metadataRaw fields are duplicates of
 *      episode.metadataRaw (same value across every chapter of the ep).
 *   2. CREATE DEHYDRATED MIRROR: copy 200 chapter docs into
 *      jamieVectorMetadataChapterDehyd with the denormalizable fields
 *      stripped from metadataRaw.
 *   3. VERIFY: read each dehydrated doc, hydrate via the helper, compare
 *      to its source. Should be byte-identical on the hydrated fields.
 *   4. SPEED: time 100 read-paths with hydration vs without. Report p50/p95.
 *   5. DISK: collStats on source vs dehydrated mirror. Report bytes saved
 *      per doc, project to the full corpus.
 *
 * Read-only against the source. Writes only to the mirror collection
 * (jamieVectorMetadataChapterDehyd) which can be dropped freely.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { hydrateWithEpisodes, HYDRATABLE_EPISODE_FIELDS } = require('../utils/episodeHydration');

const SOURCE_COLL = 'jamieVectorMetadataChapterTest';
const MIRROR_COLL = 'jamieVectorMetadataChapterDehyd';
const SAMPLE_FOR_AUDIT = 10;            // episodes
const SAMPLE_FOR_MIRROR = 200;          // chapters
const SPEED_REPS = 100;                 // reads to time
const SPEED_BATCH = 5;                  // chapters per read (mimics result-set size)

function percentile(sorted, p) {
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
  const sourceColl = db.collection(SOURCE_COLL);
  const mirrorColl = db.collection(MIRROR_COLL);

  // ─── 1. AUDIT ──────────────────────────────────────────────────────────
  console.log('═══ 1. AUDIT — which chapter fields are duplicates of parent episode ═══\n');
  const sampleEpisodes = await JamieVectorMetadata.aggregate([
    { $match: { type: 'episode' } },
    { $sample: { size: SAMPLE_FOR_AUDIT } },
    { $project: { guid: 1, metadataRaw: 1, _id: 0 } },
  ]);

  // For each candidate field, count how many (chapter, episode) pairs have
  // identical values for that field. A field with high match count is a
  // good denormalization candidate.
  const fieldMatch = {};       // fieldName → { matches, mismatches, missing }
  let totalChaptersAudited = 0;

  for (const ep of sampleEpisodes) {
    const epMeta = ep.metadataRaw || {};
    const chapters = await sourceColl.find({ type: 'chapter', guid: ep.guid })
      .project({ metadataRaw: 1 })
      .toArray();
    totalChaptersAudited += chapters.length;
    for (const ch of chapters) {
      const chMeta = ch.metadataRaw || {};
      // Collect candidate field names = union of keys on both
      const candidates = new Set([...Object.keys(chMeta), ...HYDRATABLE_EPISODE_FIELDS]);
      for (const k of candidates) {
        if (!fieldMatch[k]) fieldMatch[k] = { matches: 0, mismatches: 0, missingEp: 0, missingCh: 0 };
        const inCh = k in chMeta;
        const inEp = k in epMeta;
        if (!inCh && !inEp) continue;
        if (!inCh) { fieldMatch[k].missingCh++; continue; }
        if (!inEp) { fieldMatch[k].missingEp++; continue; }
        const same = JSON.stringify(chMeta[k]) === JSON.stringify(epMeta[k]);
        if (same) fieldMatch[k].matches++;
        else fieldMatch[k].mismatches++;
      }
    }
  }

  console.log(`Audited ${totalChaptersAudited} chapters across ${sampleEpisodes.length} episodes.\n`);
  console.log(`${'field'.padEnd(28)}${'identical'.padStart(11)}${'mismatched'.padStart(13)}${'missingEp'.padStart(12)}${'missingCh'.padStart(12)}  verdict`);
  const goodFields = [];
  for (const [field, s] of Object.entries(fieldMatch).sort((a, b) => b[1].matches - a[1].matches)) {
    const total = s.matches + s.mismatches + s.missingEp + s.missingCh;
    const verdict =
      s.mismatches > 0 ? '✘ values differ — NOT a duplicate' :
      s.matches > 0 && s.matches >= total * 0.5 ? '✓ safe to dehydrate' :
      '— unrelated';
    if (verdict.startsWith('✓')) goodFields.push(field);
    console.log(`${field.padEnd(28)}${String(s.matches).padStart(11)}${String(s.mismatches).padStart(13)}${String(s.missingEp).padStart(12)}${String(s.missingCh).padStart(12)}  ${verdict}`);
  }
  console.log(`\nSafe-to-dehydrate fields (identical between chapter and episode): ${goodFields.join(', ') || '(none)'}\n`);

  // Intersect with the helper's HYDRATABLE_EPISODE_FIELDS to find the
  // working set we'll actually strip. The helper only knows how to put
  // back what's in its list.
  const stripFields = goodFields.filter(f => HYDRATABLE_EPISODE_FIELDS.includes(f));
  console.log(`Helper-supported strip fields: ${stripFields.join(', ') || '(none)'}\n`);
  if (stripFields.length === 0) {
    console.log('No fields to dehydrate. Update HYDRATABLE_EPISODE_FIELDS or stop.\n');
    await mongoose.disconnect();
    return;
  }

  // ─── 2. CREATE DEHYDRATED MIRROR ──────────────────────────────────────
  console.log(`═══ 2. CREATE DEHYDRATED MIRROR (${MIRROR_COLL}) ═══\n`);
  // Drop existing mirror to start clean
  try { await mirrorColl.drop(); console.log(`Dropped existing mirror.`); } catch {}

  // Sample chapter docs from the source, ensure we get chapters that have
  // parent episode docs available for hydration
  const sourceSample = await sourceColl.aggregate([
    { $match: { type: 'chapter' } },
    { $sample: { size: SAMPLE_FOR_MIRROR } },
  ]).toArray();
  console.log(`Sampled ${sourceSample.length} chapters from source.`);

  let written = 0;
  for (const doc of sourceSample) {
    const meta = { ...(doc.metadataRaw || {}) };
    for (const f of stripFields) delete meta[f];
    const dehyd = { ...doc, _id: undefined, metadataRaw: meta, denorm_test_dehydrated: true };
    delete dehyd._id;
    await mirrorColl.insertOne(dehyd);
    written++;
  }
  console.log(`Wrote ${written} dehydrated docs to ${MIRROR_COLL}.\n`);

  // ─── 3. VERIFY (byte-equality after hydration) ─────────────────────────
  console.log(`═══ 3. VERIFY — hydrate dehydrated docs and byte-diff against originals ═══\n`);
  const sourceById = new Map();
  for (const d of sourceSample) sourceById.set(String(d.pineconeId), d);

  const dehyd = await mirrorColl.find({}).toArray();
  await hydrateWithEpisodes(dehyd, JamieVectorMetadata);

  let identical = 0;
  let differing = 0;
  const sampleDiff = [];
  for (const h of dehyd) {
    const orig = sourceById.get(String(h.pineconeId));
    if (!orig) continue;
    // Compare only fields the helper is responsible for. (Other fields
    // were never stripped; comparing _all_ fields would be cluttered.)
    const fieldsToCheck = stripFields;
    let docOk = true;
    const fieldDiffs = [];
    for (const f of fieldsToCheck) {
      const origVal = JSON.stringify(orig.metadataRaw?.[f]);
      const hydVal = JSON.stringify(h.metadataRaw?.[f]);
      if (origVal !== hydVal) {
        docOk = false;
        fieldDiffs.push({ field: f, orig: origVal?.slice(0, 50), hyd: hydVal?.slice(0, 50) });
      }
    }
    if (docOk) identical++;
    else {
      differing++;
      if (sampleDiff.length < 3) sampleDiff.push({ pineconeId: h.pineconeId, fieldDiffs });
    }
  }
  console.log(`Byte-identical after hydration: ${identical}/${dehyd.length}`);
  console.log(`Differing: ${differing}`);
  for (const sd of sampleDiff) {
    console.log(`  ${sd.pineconeId}:`);
    for (const fd of sd.fieldDiffs) {
      console.log(`    ${fd.field}: orig=${fd.orig} hyd=${fd.hyd}`);
    }
  }
  console.log('');

  // ─── 4. SPEED ──────────────────────────────────────────────────────────
  console.log(`═══ 4. SPEED — time read-with-hydration vs read-without ═══\n`);
  // Use the same set of pineconeIds for both paths to make timing fair
  const idsToTime = sourceSample.slice(0, SPEED_REPS * SPEED_BATCH).map(d => d.pineconeId);

  // Path A: read original (hydrated) docs from source
  const withoutTimes = [];
  for (let i = 0; i < SPEED_REPS; i++) {
    const batch = idsToTime.slice(i * SPEED_BATCH, (i + 1) * SPEED_BATCH);
    const start = Date.now();
    await sourceColl.find({ pineconeId: { $in: batch } }).toArray();
    withoutTimes.push(Date.now() - start);
  }
  // Path B: read dehydrated docs from mirror + hydrate via helper
  const withTimes = [];
  for (let i = 0; i < SPEED_REPS; i++) {
    const batch = idsToTime.slice(i * SPEED_BATCH, (i + 1) * SPEED_BATCH);
    const start = Date.now();
    const docs = await mirrorColl.find({ pineconeId: { $in: batch } }).toArray();
    await hydrateWithEpisodes(docs, JamieVectorMetadata);
    withTimes.push(Date.now() - start);
  }
  withoutTimes.sort((a, b) => a - b);
  withTimes.sort((a, b) => a - b);
  console.log(`Read direct from source (hydrated)            p50=${percentile(withoutTimes, 50)}ms  p95=${percentile(withoutTimes, 95)}ms  p99=${percentile(withoutTimes, 99)}ms`);
  console.log(`Read dehydrated + hydrate via helper          p50=${percentile(withTimes, 50)}ms     p95=${percentile(withTimes, 95)}ms  p99=${percentile(withTimes, 99)}ms`);
  const overheadP50 = percentile(withTimes, 50) - percentile(withoutTimes, 50);
  const overheadP95 = percentile(withTimes, 95) - percentile(withoutTimes, 95);
  console.log(`Overhead from hydration                         p50=+${overheadP50}ms        p95=+${overheadP95}ms`);
  console.log('');

  // ─── 5. DISK USAGE ─────────────────────────────────────────────────────
  console.log(`═══ 5. DISK USAGE — source vs dehydrated mirror ═══\n`);
  const sourceStats = await db.command({ collStats: SOURCE_COLL });
  const mirrorStats = await db.command({ collStats: MIRROR_COLL });
  const avgSourceDocSize = sourceStats.size / sourceStats.count;
  const avgMirrorDocSize = mirrorStats.size / mirrorStats.count;
  const savedPerDoc = avgSourceDocSize - avgMirrorDocSize;
  const pctSaved = (savedPerDoc / avgSourceDocSize) * 100;

  console.log(`Source (${SOURCE_COLL}):`);
  console.log(`  ${sourceStats.count.toLocaleString()} docs, total ${fmtBytes(sourceStats.size)} (avg ${fmtBytes(avgSourceDocSize)}/doc)`);
  console.log(`Mirror (${MIRROR_COLL}, dehydrated):`);
  console.log(`  ${mirrorStats.count.toLocaleString()} docs, total ${fmtBytes(mirrorStats.size)} (avg ${fmtBytes(avgMirrorDocSize)}/doc)`);
  console.log(`Per-doc reduction: ${fmtBytes(savedPerDoc)} (${pctSaved.toFixed(1)}%)`);
  console.log('');

  // Project to the full corpus
  const paragraphCount = await JamieVectorMetadata.estimatedDocumentCount({ type: 'paragraph' });
  // Use a rough assumption: paragraph denormalization tax is similar in
  // shape but typically larger absolute (paragraphs have ~5 KB avg vs
  // chapters ~1 KB). Show both the chapter projection and a conservative
  // paragraph projection.
  const projChapter = savedPerDoc * sourceStats.count;
  console.log(`Projected savings if applied to FULL chapter test coll (${sourceStats.count.toLocaleString()} docs): ${fmtBytes(projChapter)}`);
  console.log(`(Paragraphs are denser; per-doc savings should be ~similar in absolute bytes since the redundant fields are the same. With ~9.7M paragraphs the projection is ${fmtBytes(savedPerDoc * 9700000)} on the paragraph collection.)`);
  console.log('');

  console.log(`Cleanup when done: db.${MIRROR_COLL}.drop()`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
