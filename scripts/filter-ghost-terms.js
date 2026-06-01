/**
 * filter-ghost-terms.js
 *
 * Walks the chapter side collection and drops any entity_mentions /
 * phrase_mentions / url_mentions entry whose paragraphIds list is empty.
 * Empty paragraphIds = the term was extracted by the LLM but doesn't
 * literally appear in any underlying paragraph = hallucination from prompt
 * example-contamination. Deterministic substring-match did its job; this
 * script just acts on the evidence.
 *
 * Defaults to the smoke side collection. Override via SIDE_COLL_NAME env
 * to run on the full collection instead.
 *
 * Read-only against the augmentation pipeline (no LLM calls). Cheap.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const SIDE_COLL_NAME = process.env.SIDE_COLL_NAME || 'jamieVectorMetadataChapterSmoke';

async function main() {
  const uri = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  const conn = await mongoose.connect(uri);
  const coll = conn.connection.db.collection(SIDE_COLL_NAME);

  const total = await coll.countDocuments();
  console.log(`Filtering ghost terms from "${SIDE_COLL_NAME}" (${total} docs)…\n`);

  let scanned = 0;
  let updated = 0;
  let entitiesDropped = 0;
  let phrasesDropped = 0;
  let urlsDropped = 0;

  const cursor = coll.find({}, { projection: {
    pineconeId: 1,
    'metadataRaw.entity_mentions': 1,
    'metadataRaw.phrase_mentions': 1,
    'metadataRaw.url_mentions': 1,
  }});

  for await (const doc of cursor) {
    scanned++;
    const meta = doc.metadataRaw || {};
    const filterField = (arr) => {
      if (!Array.isArray(arr)) return { kept: arr, dropped: 0 };
      const kept = arr.filter(m => Array.isArray(m?.paragraphIds) && m.paragraphIds.length > 0);
      return { kept, dropped: arr.length - kept.length };
    };
    const e = filterField(meta.entity_mentions);
    const p = filterField(meta.phrase_mentions);
    const u = filterField(meta.url_mentions);

    if (e.dropped === 0 && p.dropped === 0 && u.dropped === 0) continue;

    await coll.updateOne(
      { _id: doc._id },
      { $set: {
          'metadataRaw.entity_mentions': e.kept,
          'metadataRaw.phrase_mentions': p.kept,
          'metadataRaw.url_mentions': u.kept,
          'metadataRaw.ghost_filtered_at': new Date().toISOString(),
        }
      }
    );
    updated++;
    entitiesDropped += e.dropped;
    phrasesDropped  += p.dropped;
    urlsDropped     += u.dropped;

    if (scanned % 500 === 0) {
      console.log(`  scanned=${scanned}/${total}  updated=${updated}  dropped(entity/phrase/url)=${entitiesDropped}/${phrasesDropped}/${urlsDropped}`);
    }
  }

  console.log(`\nDone.`);
  console.log(`  scanned:           ${scanned}`);
  console.log(`  docs updated:      ${updated}`);
  console.log(`  ghost entities:    ${entitiesDropped}`);
  console.log(`  ghost phrases:     ${phrasesDropped}`);
  console.log(`  ghost urls:        ${urlsDropped}`);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
