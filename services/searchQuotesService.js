/**
 * Search Quotes Service — semantic vector search across podcast transcripts.
 *
 * Pure business logic: accepts params + dependencies, returns data. No req/res.
 *
 * Vector retrieval (Pinecone) is the primary path. When the query "looks like"
 * a literal proper noun and the kill switch PROPER_NOUN_SEARCH_ENABLED is
 * on, an Atlas Search lexical aggregation runs in parallel and its results are
 * interleaved before the vector results. See docs/WIP/PROPER_NOUN_RECALL_FIX.md
 * for the why.
 */

const { printLog } = require('../constants.js');
const { findSimilarDiscussions } = require('../agent-tools/pineconeTools.js');
const { triageQuery } = require('../utils/queryTriage');
const { isProperNounShaped } = require('../utils/properNounDetector');
const { atlasTextSearch } = require('./atlasTextSearch');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

const PROPER_NOUN_SEARCH_ENABLED = process.env.PROPER_NOUN_SEARCH_ENABLED === 'true';

/**
 * Merge vector + lexical retrieval results into a single, deduped, capped list.
 *
 * Strategy: literal-first interleave. The lexical hit at rank N comes before
 * the vector hit at rank N. We tag each result with its source so the caller
 * can preserve provenance in the response.
 *
 * Rationale: when lexical activates, the query was already classified as a
 * literal proper-noun lookup. A literal hit is by construction higher
 * confidence for that user intent than a vector neighbor. Pinecone results
 * still come along for breadth/related coverage but they ride second.
 */
function mergeVectorAndLexical(vectorResults, lexicalResults, limit) {
  const merged = [];
  const seenIds = new Set();
  const lexicalScoreById = new Map();

  for (const lex of lexicalResults || []) {
    if (lex && lex.id) lexicalScoreById.set(lex.id, lex.score);
  }

  const lex = Array.isArray(lexicalResults) ? lexicalResults : [];
  const vec = Array.isArray(vectorResults) ? vectorResults : [];
  const maxLen = Math.max(lex.length, vec.length);

  for (let i = 0; i < maxLen && merged.length < limit; i++) {
    const lexHit = lex[i];
    if (lexHit && lexHit.id && !seenIds.has(lexHit.id)) {
      seenIds.add(lexHit.id);
      merged.push({
        id: lexHit.id,
        score: lexHit.score,
        source: 'lexical',
        lexicalScore: lexHit.score,
      });
      if (merged.length >= limit) break;
    }
    const vecHit = vec[i];
    if (vecHit && vecHit.id && !seenIds.has(vecHit.id)) {
      seenIds.add(vecHit.id);
      merged.push({
        id: vecHit.id,
        score: vecHit.score,
        source: lexicalScoreById.has(vecHit.id) ? 'both' : 'vector',
        vectorScore: vecHit.score,
        lexicalScore: lexicalScoreById.get(vecHit.id) ?? null,
      });
    }
  }

  // Mark vector hits that also appeared in lexical (in case vector ranked them
  // ahead of where the interleave loop saw the lexical entry).
  for (const r of merged) {
    if (r.source === 'vector' && lexicalScoreById.has(r.id)) {
      r.source = 'both';
      r.lexicalScore = lexicalScoreById.get(r.id);
    }
  }

  return merged;
}

async function searchQuotes(params, { openai }) {
  let {
    query, feedIds = [], limit = 5, minDate = null, maxDate = null,
    episodeName = null, guid = null, guids: guidsParam = [], smartMode = false,
  } = params;

  const originalQuery = query;
  feedIds = (Array.isArray(feedIds) ? feedIds : [feedIds]).filter(Boolean);
  let guids = [
    ...(guid ? [guid] : []),
    ...(Array.isArray(guidsParam) ? guidsParam : []),
  ];
  const maxResults = process.env.MAX_PODCAST_SEARCH_RESULTS
    ? parseInt(process.env.MAX_PODCAST_SEARCH_RESULTS) : 50;
  limit = Math.min(maxResults, Math.floor(limit));

  const requestId = `SEARCH-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  printLog(`[${requestId}] searchQuotes: query="${query}", limit=${limit}, smartMode=${smartMode}`);

  let triageResult = null;
  if (smartMode && !feedIds.length && !guids.length) {
    try {
      triageResult = await triageQuery(query, openai);
      printLog(`[${requestId}] Triage: intent=${triageResult.triage?.intent}, latency=${triageResult.triage?.latencyMs}ms`);
      if (triageResult.rewrittenQuery) query = triageResult.rewrittenQuery;
      if (triageResult.feedIds?.length) feedIds = triageResult.feedIds;
      if (triageResult.guids?.length) guids = triageResult.guids;
      if (triageResult.episodeName) episodeName = triageResult.episodeName;
      if (triageResult.minDate && !minDate) minDate = triageResult.minDate;
      if (triageResult.maxDate && !maxDate) maxDate = triageResult.maxDate;
    } catch (err) {
      printLog(`[${requestId}] Triage failed (non-fatal): ${err.message}`);
    }
  }

  // Lexical fallback gating — kill-switch + heuristic + must not be already
  // scoped to a single episode (in which case the vector path is plenty).
  const lexicalActivated = PROPER_NOUN_SEARCH_ENABLED
    && !episodeName
    && isProperNounShaped(query);

  const lexicalStartedAt = lexicalActivated ? Date.now() : null;

  const [embeddingResponse, lexicalRaw] = await Promise.all([
    openai.embeddings.create({ model: 'text-embedding-ada-002', input: query }),
    lexicalActivated
      ? atlasTextSearch({ query, feedIds, guids, minDate, maxDate, limit, requestId })
      : Promise.resolve([]),
  ]);
  const embedding = embeddingResponse.data[0].embedding;

  const lexicalLatencyMs = lexicalStartedAt ? Date.now() - lexicalStartedAt : null;

  const minimalResults = await findSimilarDiscussions({
    embedding, feedIds, guids, limit, query,
    minDate, maxDate, episodeName, includeMetadata: false,
  });
  printLog(`[${requestId}] Pinecone returned ${minimalResults.length} results`);

  const merged = lexicalActivated
    ? mergeVectorAndLexical(minimalResults, lexicalRaw, limit)
    : minimalResults.map(r => ({ id: r.id, score: r.score, source: 'vector', vectorScore: r.score }));

  if (lexicalActivated) {
    const sourceMix = merged.reduce((acc, r) => {
      acc[r.source] = (acc[r.source] || 0) + 1;
      return acc;
    }, {});
    const overlap = merged.filter(r => r.source === 'both').length;
    printLog(`[${requestId}] Lexical activated: hits=${lexicalRaw.length}, latency=${lexicalLatencyMs}ms, overlap=${overlap}, finalMix=${JSON.stringify(sourceMix)}`);
  }

  const pineconeIds = merged.map(r => r.id);
  const metadataDocs = await JamieVectorMetadata.find({
    pineconeId: { $in: pineconeIds },
    type: 'paragraph',
  })
    .select('pineconeId metadataRaw')
    .lean();

  const metadataMap = new Map();
  metadataDocs.forEach(doc => metadataMap.set(doc.pineconeId, doc.metadataRaw));

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
  const results = merged
    .map(merge => {
      const metadata = metadataMap.get(merge.id);
      if (!metadata) return null;

      const hierarchyLevel = metadata.type || 'paragraph';
      const quote = hierarchyLevel === 'chapter'
        ? (metadata.headline || metadata.summary || metadata.text || 'Quote unavailable')
        : (metadata.text || metadata.summary || metadata.headline || 'Quote unavailable');

      const vectorScore = typeof merge.vectorScore === 'number' ? merge.vectorScore : null;
      const lexicalScore = typeof merge.lexicalScore === 'number' ? merge.lexicalScore : null;

      return {
        shareUrl: `${baseUrl}/share?clip=${merge.id}`,
        shareLink: merge.id,
        quote,
        episode: metadata.episode || metadata.title || 'Unknown episode',
        creator: metadata.creator || 'Creator not specified',
        audioUrl: metadata.audioUrl || 'URL unavailable',
        episodeImage: metadata.episodeImage || 'Image unavailable',
        listenLink: metadata.listenLink || '',
        date: metadata.publishedDate || 'Date not provided',
        source: merge.source,
        similarity: {
          combined: vectorScore !== null ? parseFloat(vectorScore.toFixed(4)) : null,
          vector: vectorScore !== null ? parseFloat(vectorScore.toFixed(4)) : null,
          lexical: lexicalScore !== null ? parseFloat(lexicalScore.toFixed(4)) : null,
        },
        timeContext: {
          start_time: metadata.start_time || null,
          end_time: metadata.end_time || null,
        },
      };
    })
    .filter(Boolean);

  printLog(`[${requestId}] searchQuotes complete: ${results.length} results`);

  const response = {
    query,
    results,
    total: results.length,
    model: 'text-embedding-ada-002',
    relatedEndpoints: {
      discoverPodcasts: {
        description: 'Search the full Podcast Index catalog for podcasts not yet in our corpus',
        method: 'POST',
        url: '/api/discover-podcasts',
      },
      requestTranscription: {
        description: 'Submit untranscribed podcast episodes for transcription, timestamped chaptering, and indexing',
        method: 'POST',
        url: '/api/on-demand/submitOnDemandRun',
      },
    },
  };
  if (lexicalActivated) {
    response.lexical = {
      activated: true,
      latencyMs: lexicalLatencyMs,
      hits: Array.isArray(lexicalRaw) ? lexicalRaw.length : 0,
    };
  }
  if (triageResult) {
    response.originalQuery = originalQuery;
    response.triage = triageResult.triage;
  }
  return response;
}

module.exports = { searchQuotes, mergeVectorAndLexical };
