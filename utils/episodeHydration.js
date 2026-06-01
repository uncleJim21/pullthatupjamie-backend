/**
 * Episode-level metadata hydration.
 *
 * Pattern: paragraph and chapter docs duplicate episode-level metadata
 * (creator, episodeImage, listenLink, etc.) on every doc. That denormalization
 * costs ~10-15 GB across the corpus. This module reads dehydrated docs from
 * Mongo and merges in episode-level fields at the boundary, so API consumers
 * see identical response shapes.
 *
 * Usage:
 *   const { hydrateWithEpisodes } = require('../utils/episodeHydration');
 *   const dehydratedDocs = await SomeColl.find(...).lean();
 *   const hydrated = await hydrateWithEpisodes(dehydratedDocs, JamieVectorMetadata);
 *
 * Stateless. Batch-fetches one episode doc per distinct guid. No caching
 * across calls — fits the per-request lifetime of the API.
 */

// Fields on episode.metadataRaw that should be hydrated into child docs
// (chapter / paragraph) when reading. Audit script confirms these are
// genuine duplicates with identical values across all chapters of an
// episode. Keep this list short — only what API consumers depend on.
//
// IMPORTANT: the field names here must match BOTH the keys on episode docs
// AND the keys API consumers expect to see on chapter/paragraph results.
// If a field is named differently on each, add a mapping in HYDRATION_MAP
// below instead.
const HYDRATABLE_EPISODE_FIELDS = [
  'creator',
  'episode',          // = episode title (sometimes feedTitle)
  'episodeImage',
  'listenLink',
  'audioUrl',
  'feedTitle',
  'feedImage',
  'publishedDate',
  'publishedTimestamp',
];

// Same-named field, no remapping needed.
async function hydrateWithEpisodes(docs, JamieVectorMetadata) {
  if (!Array.isArray(docs) || docs.length === 0) return docs;

  // 1. Collect distinct episode guids
  const guidSet = new Set();
  for (const d of docs) {
    const g = d?.guid || d?.metadataRaw?.guid;
    if (g) guidSet.add(g);
  }
  if (guidSet.size === 0) return docs;

  // 2. Batch-fetch episode docs
  const episodeDocs = await JamieVectorMetadata
    .find({ type: 'episode', guid: { $in: Array.from(guidSet) } })
    .select('guid metadataRaw')
    .lean();

  // 3. Index by guid for O(1) lookup
  const episodeByGuid = new Map();
  for (const ep of episodeDocs) {
    if (ep.guid) episodeByGuid.set(ep.guid, ep.metadataRaw || {});
  }

  // 4. Hydrate each doc — only fill fields that are missing on the doc
  //    (so a doc that still has the denormalized field wins). This makes
  //    the helper safe to run against fully-hydrated docs too.
  for (const d of docs) {
    const g = d?.guid || d?.metadataRaw?.guid;
    if (!g) continue;
    const epMeta = episodeByGuid.get(g);
    if (!epMeta) continue;
    if (!d.metadataRaw) d.metadataRaw = {};
    for (const field of HYDRATABLE_EPISODE_FIELDS) {
      if (d.metadataRaw[field] === undefined && epMeta[field] !== undefined) {
        d.metadataRaw[field] = epMeta[field];
      }
    }
  }
  return docs;
}

module.exports = {
  hydrateWithEpisodes,
  HYDRATABLE_EPISODE_FIELDS,
};
