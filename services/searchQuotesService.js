/**
 * Search Quotes Service — semantic vector search across podcast transcripts.
 *
 * Pure business logic: accepts params + dependencies, returns data. No req/res.
 */

const { printLog } = require('../constants.js');
const { findSimilarDiscussions } = require('../agent-tools/pineconeTools.js');
const { triageQuery } = require('../utils/queryTriage');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

/**
 * @param {object} params - Search parameters from caller
 * @param {object} deps   - Injected dependencies
 * @param {object} deps.openai - OpenAI client (required for embeddings)
 */
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

  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: query,
  });
  const embedding = embeddingResponse.data[0].embedding;

  const minimalResults = await findSimilarDiscussions({
    embedding, feedIds, guids, limit, query,
    minDate, maxDate, episodeName, includeMetadata: false,
  });
  printLog(`[${requestId}] Pinecone returned ${minimalResults.length} results`);

  const pineconeIds = minimalResults.map(r => r.id);
  const metadataDocs = await JamieVectorMetadata.find({
    pineconeId: { $in: pineconeIds },
    type: 'paragraph',
  })
    .select('pineconeId metadataRaw')
    .lean();

  const metadataMap = new Map();
  metadataDocs.forEach(doc => metadataMap.set(doc.pineconeId, doc.metadataRaw));

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
  const results = minimalResults
    .map(minimalResult => {
      const metadata = metadataMap.get(minimalResult.id);
      if (!metadata) return null;

      const hierarchyLevel = metadata.type || 'paragraph';
      const quote = hierarchyLevel === 'chapter'
        ? (metadata.headline || metadata.summary || metadata.text || 'Quote unavailable')
        : (metadata.text || metadata.summary || metadata.headline || 'Quote unavailable');

      return {
        shareUrl: `${baseUrl}/share?clip=${minimalResult.id}`,
        shareLink: minimalResult.id,
        quote,
        episode: metadata.episode || metadata.title || 'Unknown episode',
        creator: metadata.creator || 'Creator not specified',
        audioUrl: metadata.audioUrl || 'URL unavailable',
        episodeImage: metadata.episodeImage || 'Image unavailable',
        listenLink: metadata.listenLink || '',
        date: metadata.publishedDate || 'Date not provided',
        similarity: {
          combined: parseFloat(minimalResult.score.toFixed(4)),
          vector: parseFloat(minimalResult.score.toFixed(4)),
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
  if (triageResult) {
    response.originalQuery = originalQuery;
    response.triage = triageResult.triage;
  }
  return response;
}

module.exports = { searchQuotes };
