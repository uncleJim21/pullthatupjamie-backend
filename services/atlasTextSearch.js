/**
 * Atlas Search lexical-fallback wrapper.
 *
 * Thin shim around an Atlas Search `$search` aggregation against
 * `jamieVectorMetadata`. Returns the same minimal shape as the Pinecone
 * vector path (`[{ id, score, source }]`) so it slots cleanly into the
 * existing merge logic in searchQuotesService.
 *
 * Index: `paragraph_text_search`
 *   - Standard analyzer on `metadataRaw.text` (covers exact phrase + fuzzy)
 *   - Synonym mapping `brand_aliases` sourced from the `searchSynonyms`
 *     collection (curated equivalence classes, may be empty)
 *   - NO shingle multi-fields. Compound-word and spelled-out-letter recovery
 *     (e.g. "albyhub" -> "Alby Hub", "lncurl" -> "l n c u r l") is now handled
 *     at the query layer via LLM-generated `extraQueries`. The orchestrator
 *     populates these via the `expansions` parameter on the search_quotes
 *     tool; the server-side properNounLLMExpansion service adds variants as
 *     a fallback. Dropping shingles shrinks the index ~85%.
 *
 * Compound query — three `should` clauses contribute independently to recall:
 *   1. phrase   — exact word-for-word match on `metadataRaw.text`
 *   2. text+fuzzy — Levenshtein up to 2 edits, prefix preserved
 *   3. text + synonyms — expands curated equivalence classes
 *
 * Plus a phrase + text+fuzzy clause pair per `extraQueries` variant — the
 * primary mechanism for proper-noun / spelled-out / compound recovery.
 *
 * Filters mirror the Pinecone vector path (paragraph type, optional feed /
 * guid / date scoping). episodeName is intentionally NOT supported here —
 * the gating heuristic in searchQuotesService disables lexical when an
 * exact episode filter is active because (a) it doesn't help and (b) the
 * `episode` field is not in the search index mapping.
 *
 * Hard timeouts protect the agent loop: $search has a 5s server-side
 * `maxTimeMS` ceiling so the parallel Promise.all in searchQuotes can never
 * be held up indefinitely if Atlas Search hiccups.
 */

const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { printLog } = require('../constants.js');

const ATLAS_SEARCH_INDEX_NAME = 'paragraph_text_search';
const ATLAS_SEARCH_TEXT_PATH = 'metadataRaw.text';
const ATLAS_SEARCH_SYNONYM_NAME = 'brand_aliases';
const ATLAS_SEARCH_TIMEOUT_MS = 5000;

function buildFilterClauses({ feedIds = [], guids = [], minDate = null, maxDate = null }) {
  const filters = [
    { equals: { path: 'type', value: 'paragraph' } },
  ];

  if (Array.isArray(feedIds) && feedIds.length) {
    // feedId is stored as string in JamieVectorMetadata.
    const stringFeedIds = feedIds.map(String).filter(Boolean);
    if (stringFeedIds.length === 1) {
      filters.push({ equals: { path: 'feedId', value: stringFeedIds[0] } });
    } else if (stringFeedIds.length > 1) {
      filters.push({
        compound: {
          should: stringFeedIds.map(value => ({ equals: { path: 'feedId', value } })),
          minimumShouldMatch: 1,
        },
      });
    }
  }

  if (Array.isArray(guids) && guids.length) {
    if (guids.length === 1) {
      filters.push({ equals: { path: 'guid', value: guids[0] } });
    } else {
      filters.push({
        compound: {
          should: guids.map(value => ({ equals: { path: 'guid', value } })),
          minimumShouldMatch: 1,
        },
      });
    }
  }

  if (minDate || maxDate) {
    const range = { path: 'publishedTimestamp' };
    if (minDate) range.gte = new Date(minDate).getTime();
    if (maxDate) range.lte = new Date(maxDate).getTime();
    filters.push({ range });
  }

  return filters;
}

function buildShouldClauses(query, extraQueries = []) {
  const clauses = [
    {
      phrase: {
        query,
        path: ATLAS_SEARCH_TEXT_PATH,
        score: { boost: { value: 4 } },
      },
    },
    {
      text: {
        query,
        path: ATLAS_SEARCH_TEXT_PATH,
        fuzzy: { maxEdits: 2, prefixLength: 1 },
        score: { boost: { value: 2 } },
      },
    },
    {
      text: {
        query,
        path: ATLAS_SEARCH_TEXT_PATH,
        synonyms: ATLAS_SEARCH_SYNONYM_NAME,
        score: { boost: { value: 2 } },
      },
    },
  ];

  // Expansion variants (orchestrator-supplied via the search_quotes
  // `expansions` parameter, plus server-side LLM-generated variants merged in
  // upstream). Each variant gets a phrase clause (catches multi-word ordering
  // like "Alby Hub" or "l n c u r l") plus a text+fuzzy clause (catches close
  // typos on single-token variants). Boost intentionally lower than the
  // original-query clauses so expansion-only hits don't outrank exact
  // original-query matches when both exist.
  if (Array.isArray(extraQueries) && extraQueries.length) {
    for (const extra of extraQueries) {
      if (typeof extra !== 'string' || !extra.trim()) continue;
      const trimmed = extra.trim();
      clauses.push({
        phrase: {
          query: trimmed,
          path: ATLAS_SEARCH_TEXT_PATH,
          score: { boost: { value: 2.5 } },
        },
      });
      clauses.push({
        text: {
          query: trimmed,
          path: ATLAS_SEARCH_TEXT_PATH,
          fuzzy: { maxEdits: 1, prefixLength: 1 },
          score: { boost: { value: 1.5 } },
        },
      });
    }
  }

  return clauses;
}

/**
 * Run the lexical search. Returns `[{ id, score, source: 'lexical' }]`
 * matching the shape Pinecone returns (when called with includeMetadata=false).
 *
 * Errors are swallowed and logged — lexical is a fallback path; if Atlas
 * Search is unavailable the vector path still answers.
 */
async function atlasTextSearch({
  query, feedIds = [], guids = [], minDate = null, maxDate = null,
  limit = 20, requestId = null, extraQueries = [],
}) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];

  const tag = requestId ? `[${requestId}][ATLAS-LEX]` : '[ATLAS-LEX]';
  const started = Date.now();

  try {
    const pipeline = [
      {
        $search: {
          index: ATLAS_SEARCH_INDEX_NAME,
          compound: {
            should: buildShouldClauses(query, extraQueries),
            filter: buildFilterClauses({ feedIds, guids, minDate, maxDate }),
            minimumShouldMatch: 1,
          },
        },
      },
      { $limit: Math.max(1, Math.min(limit, 50)) },
      {
        $project: {
          _id: 0,
          pineconeId: 1,
          score: { $meta: 'searchScore' },
        },
      },
    ];

    const docs = await JamieVectorMetadata
      .aggregate(pipeline)
      .option({ maxTimeMS: ATLAS_SEARCH_TIMEOUT_MS });

    const elapsed = Date.now() - started;
    const expansionSuffix = extraQueries.length ? ` +${extraQueries.length} variant(s)` : '';
    printLog(`${tag} returned ${docs.length} hits in ${elapsed}ms (query="${query.slice(0, 60)}"${expansionSuffix})`);

    return docs
      .filter(d => d && d.pineconeId)
      .map(d => ({
        id: d.pineconeId,
        score: typeof d.score === 'number' ? d.score : 0,
        source: 'lexical',
      }));
  } catch (err) {
    const elapsed = Date.now() - started;
    printLog(`${tag} FAILED in ${elapsed}ms (non-fatal): ${err.message}`);
    return [];
  }
}

module.exports = {
  atlasTextSearch,
  ATLAS_SEARCH_INDEX_NAME,
};
