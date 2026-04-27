/**
 * Atlas Search lexical-fallback wrapper.
 *
 * Thin shim around an Atlas Search `$search` aggregation against
 * `jamieVectorMetadata`. Returns the same minimal shape as the Pinecone
 * vector path (`[{ id, score, source }]`) so it slots cleanly into the
 * existing merge logic in searchQuotesService.
 *
 * Index: `paragraph_text_search`
 *   - Custom analyzer `shingleSquashed` (standard + lowercase + asciiFolding +
 *     shingle 2-6 + regex squash) on `metadataRaw.text.shingleSquashed`
 *   - Standard analyzer on `metadataRaw.text` (covers exact phrase + fuzzy)
 *   - Synonym mapping `brand_aliases` sourced from the `searchSynonyms`
 *     collection (curated equivalence classes, may be empty)
 *
 * Compound query — four `should` clauses contribute independently to recall:
 *   1. phrase   — exact word-for-word match on `metadataRaw.text`
 *   2. text+fuzzy — Levenshtein up to 2 edits, prefix preserved
 *   3. text on `metadataRaw.text.shingleSquashed` — recovers spelled-out
 *      forms ("l n c u r l" -> indexed token "lncurl") so a query of
 *      "lncurl" hits the squashed shingle on the indexed side
 *   4. text + synonyms — expands curated equivalence classes
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
// Multi-field sub-analyzer must be addressed via { value, multi } at query time
// (per Atlas Search path-construction docs). A dotted-string path does NOT
// resolve to a multi-field and silently matches nothing.
const ATLAS_SEARCH_SHINGLE_PATH = { value: 'metadataRaw.text', multi: 'shingleSquashed' };
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

// Split URL-shaped queries into sub-tokens to probe the shingle-squashed
// path. Critical for queries like "lncurl.lol" where lucene.standard
// either keeps the dotted form as one token or splits to ["lncurl",
// "lol"] — neither matches the indexed squashed shingle "lncurl"
// produced from spelled-out transcript text "l n c u r l".
//
// Limited to URL-shaped delimiters (`.`, `/`, `\`) deliberately:
//   - Hyphenated forms like "BIP-32" are already handled by the
//     standard-analyzer phrase clause (StandardTokenizer splits on `-`
//     so `BIP 32` and `BIP-32` produce the same indexed tokens). Adding
//     a `bip` sub-token clause was bringing in unrelated BIP mentions
//     and ranking them above the actual BIP-32 docs.
//   - Underscores are rare in user queries and similarly handled by the
//     standard analyzer.
//
// Length cutoff at 3 chars further suppresses fragment noise. The
// original full query is excluded to avoid duplicate scoring against
// the primary shingle clause.
function splitPunctuationTokens(query) {
  if (typeof query !== 'string' || !/[./\\]/.test(query)) return [];
  const lowered = query.toLowerCase();
  const seen = new Set();
  const tokens = [];
  for (const raw of lowered.split(/[./\\]+/)) {
    const t = raw.trim();
    if (t.length >= 3 && t !== lowered && !seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  }
  return tokens;
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
        path: ATLAS_SEARCH_SHINGLE_PATH,
        score: { boost: { value: 3 } },
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

  for (const subToken of splitPunctuationTokens(query)) {
    clauses.push({
      text: {
        query: subToken,
        path: ATLAS_SEARCH_SHINGLE_PATH,
        score: { boost: { value: 2 } },
      },
    });
  }

  // LLM-generated phonetic / spelling variants (e.g. "lncurl.lol" -> "ellen curl").
  // Boost intentionally LOWER than original-query clauses (1.5 vs 2-4) so that
  // expansion-only hits don't outrank exact-original-query matches when both
  // exist in the same corpus. Variants probe both the standard text path
  // (catches homophone tokens like "ellen") and the shingle-squashed path
  // (catches letter-by-letter forms like "L N curl").
  if (Array.isArray(extraQueries) && extraQueries.length) {
    for (const extra of extraQueries) {
      if (typeof extra !== 'string' || !extra.trim()) continue;
      const trimmed = extra.trim();
      clauses.push({
        text: {
          query: trimmed,
          path: ATLAS_SEARCH_TEXT_PATH,
          score: { boost: { value: 1.5 } },
        },
      });
      clauses.push({
        text: {
          query: trimmed,
          path: ATLAS_SEARCH_SHINGLE_PATH,
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
