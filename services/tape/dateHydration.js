/**
 * Backfill missing candidate dates from the parent episode (Tape-only).
 *
 * Some paragraphs' Pinecone metadata lacks `publishedDate` — not because the
 * date is unknown, but because older episodes were ingested before the derived
 * date fields (metadataRaw.publishedTimestamp/Year/Month) were populated, so the
 * downstream metadata the search returns reads "undated". The canonical
 * top-level `publishedDate` string on the episode doc in Mongo IS intact.
 *
 * Since a paragraph and its episode necessarily share a publish date, we look up
 * the episode by the GUID embedded in the candidate's pineconeId (`<guid>_p<n>`)
 * and fill in the missing date. One batched query per call; only runs when there
 * are undated candidates. Disable with TAPE_DATE_HYDRATION=false.
 */

const JamieVectorMetadata = require('../../models/JamieVectorMetadata');
const { printLog } = require('../../constants');

const ENABLED = process.env.TAPE_DATE_HYDRATION !== 'false';

/** Episode GUID from a paragraph pineconeId: strip a trailing `_p<digits>`. */
function guidOf(pineconeId) {
  return String(pineconeId || '').replace(/_p\d+$/, '');
}

/**
 * Mutates `candidates` in place: fills `publishedDate` (and flags `_dateHydrated`)
 * on any undated candidate whose parent episode has a canonical date.
 * @returns {Promise<{ hydrated:number, missing:number, total:number }>}
 */
async function hydrateCandidateDates(candidates) {
  const total = Array.isArray(candidates) ? candidates.length : 0;
  if (!ENABLED || !total) return { hydrated: 0, missing: 0, total };

  const missing = candidates.filter((c) => !c.publishedDate && c.pineconeId);
  if (!missing.length) return { hydrated: 0, missing: 0, total };

  const guids = [...new Set(missing.map((c) => guidOf(c.pineconeId)).filter(Boolean))];
  if (!guids.length) return { hydrated: 0, missing: missing.length, total };

  let byGuid = new Map();
  try {
    const docs = await JamieVectorMetadata.find({ type: 'episode', guid: { $in: guids } })
      .select('guid publishedDate')
      .lean();
    byGuid = new Map(docs.filter((d) => d.publishedDate).map((d) => [d.guid, d.publishedDate]));
  } catch (err) {
    printLog(`[dateHydration] lookup failed (${err.message}) — leaving dates as-is`);
    return { hydrated: 0, missing: missing.length, total };
  }

  let hydrated = 0;
  for (const c of missing) {
    const d = byGuid.get(guidOf(c.pineconeId));
    if (d) { c.publishedDate = d; c._dateHydrated = true; hydrated += 1; }
  }
  if (hydrated) printLog(`[dateHydration] filled ${hydrated}/${missing.length} missing candidate dates from episode records`);
  return { hydrated, missing: missing.length, total };
}

module.exports = { hydrateCandidateDates, guidOf };
