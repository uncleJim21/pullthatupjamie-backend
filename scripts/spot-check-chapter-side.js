/**
 * spot-check-chapter-side.js — read-only diagnostic.
 *
 * Inspects jamieVectorMetadataChapterTest to verify:
 *   1. Total doc count
 *   2. Whether the v2 fields (entity_mentions, phrase_mentions, url_mentions)
 *      are actually populated
 *   3. A sample of the sub-indexed data so we can eyeball quality
 *   4. Existence of Atlas Search indexes on the collection
 *   5. Whether the canonical queries find anything via simple field probes
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  const conn = await mongoose.connect(mongoURI);
  const coll = conn.connection.db.collection('jamieVectorMetadataChapterTest');

  // 1. Total count
  const total = await coll.countDocuments();
  console.log(`Total docs in jamieVectorMetadataChapterTest: ${total}\n`);

  // 2. Field population check
  const withEntityMentions = await coll.countDocuments({ 'metadataRaw.entity_mentions': { $exists: true, $ne: [] } });
  const withPhraseMentions = await coll.countDocuments({ 'metadataRaw.phrase_mentions': { $exists: true, $ne: [] } });
  const withUrlMentions = await coll.countDocuments({ 'metadataRaw.url_mentions': { $exists: true, $ne: [] } });
  const withV2Version = await coll.countDocuments({ 'metadataRaw.augmentation_version': 'v2-exhaustive-subindex' });
  console.log(`V2 field population:`);
  console.log(`  augmentation_version == "v2-exhaustive-subindex":  ${withV2Version} / ${total}`);
  console.log(`  has metadataRaw.entity_mentions (non-empty):       ${withEntityMentions} / ${total}`);
  console.log(`  has metadataRaw.phrase_mentions (non-empty):       ${withPhraseMentions} / ${total}`);
  console.log(`  has metadataRaw.url_mentions (non-empty):          ${withUrlMentions} / ${total}\n`);

  // 3. Atlas Search index list
  try {
    const indexes = await coll.aggregate([{ $listSearchIndexes: {} }]).toArray();
    console.log(`Atlas Search indexes on this collection: ${indexes.length}`);
    for (const idx of indexes) {
      console.log(`  - name: "${idx.name}"  status: ${idx.status}  queryable: ${idx.queryable}`);
      const fields = idx.latestDefinition?.mappings?.fields || idx.latestDefinition?.fields;
      if (fields) {
        const top = Object.keys(fields);
        console.log(`    top-level mapped fields: ${top.join(', ')}`);
        if (fields.metadataRaw?.fields) {
          console.log(`    metadataRaw subfields: ${Object.keys(fields.metadataRaw.fields).join(', ')}`);
        }
      }
    }
  } catch (err) {
    console.log(`Could not list Atlas Search indexes: ${err.message}`);
  }
  console.log('');

  // 4. Sample doc
  const sample = await coll.findOne({ 'metadataRaw.entity_mentions': { $exists: true, $ne: [] } });
  if (sample) {
    console.log(`Sample doc (pineconeId: ${sample.pineconeId}):`);
    console.log(`  guid: ${sample.guid}`);
    console.log(`  headline: ${sample.metadataRaw?.headline}`);
    console.log(`  augmentation_version: ${sample.metadataRaw?.augmentation_version}`);
    console.log(`  text_source: ${sample.metadataRaw?.text_source}`);
    const em = sample.metadataRaw?.entity_mentions || [];
    console.log(`  entity_mentions count: ${em.length}`);
    if (em.length) {
      console.log(`  first 5 entities:`);
      for (const m of em.slice(0, 5)) {
        console.log(`    - "${m.term}" → ${m.paragraphIds?.length || 0} paragraph(s)`);
      }
    }
    const pm = sample.metadataRaw?.phrase_mentions || [];
    console.log(`  phrase_mentions count: ${pm.length}`);
    if (pm.length) {
      console.log(`  first 3 phrases:`);
      for (const m of pm.slice(0, 3)) {
        console.log(`    - "${m.term?.slice(0, 80)}…" → ${m.paragraphIds?.length || 0} paragraph(s)`);
      }
    }
  } else {
    console.log(`⚠ No docs with non-empty entity_mentions found.`);
  }
  console.log('');

  // 5. Probe each canonical query against the v2 fields
  console.log(`Direct probes on entity_mentions.term (case-insensitive) — counts how many docs match:`);
  const probes = ['Alby Hub', 'albyhub', 'AlbyHub', 'lncurl', 'l n c u r l', 'BIP-32', 'BIP 32', 'OpenAI', 'NWC', 'Nostr Wallet Connect'];
  for (const term of probes) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}$`, 'i');
    const n = await coll.countDocuments({ 'metadataRaw.entity_mentions.term': re });
    const nPhrase = await coll.countDocuments({ 'metadataRaw.phrase_mentions.term': new RegExp(escaped, 'i') });
    const nUrl = await coll.countDocuments({ 'metadataRaw.url_mentions.term': re });
    console.log(`  "${term}":  entity=${n}  phrase~=${nPhrase}  url=${nUrl}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
