/**
 * audit-disk-usage.js — READ-ONLY.
 *
 * Surveys actual Mongo disk usage at three levels:
 *   1. dbStats — total DB size, indexes, oplog
 *   2. collStats per collection — uncompressed BSON size, storage size on
 *      disk (after compression), index sizes, average doc size
 *   3. Atlas Search indexes — separate from regular indexes; queried via
 *      $listSearchIndexes per collection
 *
 * Output is sorted by on-disk storage so you can see exactly what's
 * eating the 54 GB.
 */

require('dotenv').config();
const mongoose = require('mongoose');

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

  // ─── 1. dbStats ───────────────────────────────────────────────────
  const dbs = await db.command({ dbStats: 1, scale: 1 });
  console.log('═══ DATABASE-LEVEL STATS ═══\n');
  console.log(`  db name:           ${db.databaseName}`);
  console.log(`  collections:       ${dbs.collections}`);
  console.log(`  objects total:     ${dbs.objects.toLocaleString()}`);
  console.log(`  avg obj size:      ${fmtBytes(dbs.avgObjSize)}`);
  console.log(`  dataSize (uncompressed BSON):  ${fmtBytes(dbs.dataSize)}`);
  console.log(`  storageSize (on disk, indexes excluded):  ${fmtBytes(dbs.storageSize)}`);
  console.log(`  indexSize (regular Mongo indexes):  ${fmtBytes(dbs.indexSize)}`);
  console.log(`  totalSize (storage + indexes):  ${fmtBytes(dbs.storageSize + dbs.indexSize)}`);
  console.log(`  fsUsedSize (file system used):  ${fmtBytes(dbs.fsUsedSize)}`);
  console.log(`  fsTotalSize (file system total):  ${fmtBytes(dbs.fsTotalSize)}`);
  if (dbs.fsTotalSize) {
    console.log(`  fs utilization:    ${((dbs.fsUsedSize / dbs.fsTotalSize) * 100).toFixed(1)}%`);
  }
  console.log('');

  // ─── 2. Per-collection breakdown ──────────────────────────────────
  const collections = (await db.listCollections().toArray())
    .map(c => c.name)
    .filter(n => !n.startsWith('system.'));
  console.log(`═══ PER-COLLECTION (sorted by storageSize, ${collections.length} colls) ═══\n`);

  const rows = [];
  for (const name of collections) {
    try {
      const s = await db.command({ collStats: name, scale: 1 });
      // collStats deprecated in 7.0 but still works; if it fails fall back to $collStats
      rows.push({
        name,
        count: s.count || 0,
        size: s.size || 0,             // uncompressed BSON
        storageSize: s.storageSize || 0, // on-disk after compression
        avgObj: s.avgObjSize || 0,
        totalIndexSize: s.totalIndexSize || 0,
        indexes: s.indexSizes || {},
        nindexes: s.nindexes || 0,
      });
    } catch (e) {
      rows.push({ name, error: e.message });
    }
  }
  rows.sort((a, b) => (b.storageSize || 0) - (a.storageSize || 0));

  console.log(
    `${'collection'.padEnd(38)}${'docs'.padStart(11)}${'avg/doc'.padStart(11)}${'BSON'.padStart(12)}${'on disk'.padStart(11)}${'compress'.padStart(10)}${'indexes'.padStart(12)}${'#idx'.padStart(6)}`
  );
  console.log('─'.repeat(112));
  let totalBson = 0, totalStorage = 0, totalIndexes = 0;
  for (const r of rows) {
    if (r.error) { console.log(`${r.name.padEnd(38)}  error: ${r.error}`); continue; }
    const compressRatio = r.size > 0 ? (1 - r.storageSize / r.size) * 100 : 0;
    console.log(
      `${r.name.padEnd(38)}${r.count.toLocaleString().padStart(11)}${fmtBytes(r.avgObj).padStart(11)}${fmtBytes(r.size).padStart(12)}${fmtBytes(r.storageSize).padStart(11)}${(compressRatio.toFixed(0) + '%').padStart(10)}${fmtBytes(r.totalIndexSize).padStart(12)}${String(r.nindexes).padStart(6)}`
    );
    totalBson += r.size;
    totalStorage += r.storageSize;
    totalIndexes += r.totalIndexSize;
  }
  console.log('─'.repeat(112));
  console.log(
    `${'TOTALS'.padEnd(38)}${''.padStart(11)}${''.padStart(11)}${fmtBytes(totalBson).padStart(12)}${fmtBytes(totalStorage).padStart(11)}${''.padStart(10)}${fmtBytes(totalIndexes).padStart(12)}`
  );
  console.log('');

  // ─── 3. Top collections — index breakdown ─────────────────────────
  console.log(`═══ INDEX BREAKDOWN — top 3 collections by storage ═══\n`);
  for (const r of rows.slice(0, 3)) {
    if (!r.indexes) continue;
    console.log(`${r.name}:`);
    const sortedIdx = Object.entries(r.indexes).sort((a, b) => b[1] - a[1]);
    for (const [idxName, sz] of sortedIdx) {
      console.log(`  ${idxName.padEnd(50)} ${fmtBytes(sz).padStart(10)}`);
    }
    console.log('');
  }

  // ─── 4. Atlas Search indexes per top-3 collection ─────────────────
  console.log(`═══ ATLAS SEARCH INDEXES — top collections ═══\n`);
  for (const r of rows.slice(0, 5)) {
    try {
      const coll = db.collection(r.name);
      const idxs = await coll.aggregate([{ $listSearchIndexes: {} }]).toArray();
      if (idxs.length === 0) continue;
      console.log(`${r.name}:`);
      for (const idx of idxs) {
        console.log(`  ${(idx.name || '').padEnd(40)}  status=${idx.status || '?'}  queryable=${idx.queryable}`);
      }
      console.log('');
    } catch (_) {
      // collection doesn't support search indexes; skip
    }
  }

  // ─── 5. Where the gap goes ────────────────────────────────────────
  console.log(`═══ SUMMARY ═══\n`);
  const gap = (dbs.fsUsedSize || 0) - (totalStorage + totalIndexes);
  console.log(`  Sum of collection storageSize + regular indexes:  ${fmtBytes(totalStorage + totalIndexes)}`);
  console.log(`  File system used:                                ${fmtBytes(dbs.fsUsedSize || 0)}`);
  console.log(`  Gap (oplog + Atlas Search indexes + journal + free space):  ${fmtBytes(gap)}`);
  console.log('');
  console.log(`  NOTE: Atlas Search indexes are stored separately and DO count toward your`);
  console.log(`        Mongo Atlas storage quota (the 64 GB on M20). The 5.31 GB index from`);
  console.log(`        the screenshot is part of the "Gap" above.`);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
