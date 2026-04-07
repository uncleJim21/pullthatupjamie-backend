const { printLog } = require('../constants.js');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const WorkProductV2 = require('../models/WorkProductV2');
const { findSimilarDiscussions } = require('../agent-tools/pineconeTools');
const { discoverInternal } = require('../routes/discoverRoutes');

const BASE_URL = process.env.FRONTEND_URL || 'https://www.pullthatupjamie.ai';

/**
 * Build a canonical share URL for a search result.
 */
function buildShareUrl(pineconeId) {
  return `${BASE_URL}/app/share?clip=${pineconeId}`;
}

/**
 * Build mini-player metadata for a search result.
 */
function buildMiniPlayer(result) {
  return {
    pineconeId: result.shareLink || result.pineconeId,
    timestamp: result.timeContext?.start_time || null,
    duration: (result.timeContext?.end_time && result.timeContext?.start_time)
      ? result.timeContext.end_time - result.timeContext.start_time
      : null,
    episode: result.episode || null,
    speaker: result.creator || null,
    audioUrl: result.audioUrl || null,
  };
}

// ========== Step: Search Quotes (Semantic Vector Search) ==========

async function stepSearchQuotes({ query, feedIds = [], guids = [], limit = 10, minDate = null, maxDate = null, openai }) {
  const debugPrefix = '[STEP:search-quotes]';
  const startTime = Date.now();

  try {
    printLog(`${debugPrefix} query="${query}", feedIds=${feedIds.length}, guids=${guids.length}, limit=${limit}`);

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: query
    });
    const embedding = embeddingResponse.data[0].embedding;

    const minimalResults = await findSimilarDiscussions({
      embedding,
      feedIds,
      guids,
      limit,
      query,
      minDate,
      maxDate,
      includeMetadata: false
    });

    const pineconeIds = minimalResults.map(r => r.id);
    const metadataDocs = await JamieVectorMetadata.find({
      pineconeId: { $in: pineconeIds },
      type: 'paragraph'
    }).select('pineconeId metadataRaw').lean();

    const metadataMap = new Map();
    metadataDocs.forEach(doc => metadataMap.set(doc.pineconeId, doc.metadataRaw));

    const results = minimalResults.map(r => {
      const metadata = metadataMap.get(r.id);
      if (!metadata) return null;

      return {
        pineconeId: r.id,
        shareUrl: buildShareUrl(r.id),
        shareLink: r.id,
        quote: metadata.text || metadata.summary || metadata.headline || 'Quote unavailable',
        episode: metadata.episode || metadata.title || 'Unknown episode',
        creator: metadata.creator || 'Unknown',
        audioUrl: metadata.audioUrl || null,
        episodeImage: metadata.episodeImage || null,
        date: metadata.publishedDate || null,
        similarity: parseFloat(r.score.toFixed(4)),
        timeContext: {
          start_time: metadata.start_time || null,
          end_time: metadata.end_time || null,
        },
        guid: metadata.guid || null,
        feedId: metadata.feedId || null,
      };
    }).filter(Boolean);

    const latencyMs = Date.now() - startTime;
    printLog(`${debugPrefix} complete (${latencyMs}ms): ${results.length} results`);

    const avgSimilarity = results.length > 0
      ? results.reduce((sum, r) => sum + r.similarity, 0) / results.length
      : 0;

    return {
      stepType: 'search-quotes',
      results: results.map(r => ({
        ...r,
        miniPlayer: buildMiniPlayer(r),
      })),
      metadata: { latencyMs, query, feedIds, guids, limit },
      quality: {
        resultCount: results.length,
        avgSimilarity: parseFloat(avgSimilarity.toFixed(4)),
        hasResults: results.length > 0,
      },
    };
  } catch (error) {
    printLog(`${debugPrefix} ERROR: ${error.message}`);
    return {
      stepType: 'search-quotes',
      results: [],
      metadata: { latencyMs: Date.now() - startTime, error: error.message },
      quality: { resultCount: 0, avgSimilarity: 0, hasResults: false },
    };
  }
}

// ========== Step: Search Chapters (Keyword Match) ==========

async function stepSearchChapters({ search, feedIds = [], limit = 20, page = 1 }) {
  const debugPrefix = '[STEP:search-chapters]';
  const startTime = Date.now();

  try {
    printLog(`${debugPrefix} search="${search}", feedIds=${feedIds.length}, limit=${limit}`);

    const searchTerm = search.trim();
    const lower = searchTerm.toLowerCase();
    const upper = searchTerm.toUpperCase();
    const titleCase = searchTerm.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const firstCap = searchTerm.charAt(0).toUpperCase() + searchTerm.slice(1).toLowerCase();
    const keywordVariants = [...new Set([searchTerm, lower, upper, titleCase, firstCap])];

    const query = {
      type: 'chapter',
      'metadataRaw.keywords': { $in: keywordVariants }
    };

    const feedIdArray = (Array.isArray(feedIds) ? feedIds : [feedIds]).filter(Boolean);
    if (feedIdArray.length > 0) {
      query.feedId = { $in: feedIdArray };
    }

    const skip = (page - 1) * limit;
    const [totalCount, chapters] = await Promise.all([
      JamieVectorMetadata.countDocuments(query),
      JamieVectorMetadata.find(query)
        .select('pineconeId guid feedId start_time end_time metadataRaw')
        .sort({ 'metadataRaw.headline': 1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    const uniqueGuids = [...new Set(chapters.map(c => c.guid).filter(Boolean))];
    const episodeMap = new Map();

    if (uniqueGuids.length > 0) {
      const episodes = await JamieVectorMetadata.find({
        type: 'episode',
        guid: { $in: uniqueGuids }
      }).select('guid feedId publishedDate metadataRaw').lean();

      for (const ep of episodes) {
        episodeMap.set(ep.guid, ep);
      }
    }

    const results = chapters.map(chapter => {
      const meta = chapter.metadataRaw || {};
      const ep = episodeMap.get(chapter.guid);
      const epMeta = ep?.metadataRaw || {};

      return {
        pineconeId: chapter.pineconeId,
        chapterNumber: meta.chapterNumber ?? meta.chapter_number ?? null,
        headline: meta.headline || null,
        keywords: meta.keywords || [],
        summary: meta.summary || null,
        startTime: meta.startTime ?? meta.start_time ?? chapter.start_time ?? null,
        endTime: meta.endTime ?? meta.end_time ?? chapter.end_time ?? null,
        guid: chapter.guid,
        feedId: chapter.feedId,
        episode: {
          guid: ep?.guid || chapter.guid,
          title: epMeta.title || null,
          creator: epMeta.creator || null,
          publishedDate: epMeta.publishedDate || ep?.publishedDate || null,
          feedId: ep?.feedId || chapter.feedId,
        },
      };
    });

    const latencyMs = Date.now() - startTime;
    printLog(`${debugPrefix} complete (${latencyMs}ms): ${results.length} results, ${totalCount} total`);

    return {
      stepType: 'search-chapters',
      results,
      metadata: { latencyMs, search, feedIds, totalCount, page },
      quality: {
        resultCount: results.length,
        totalCount,
        hasResults: results.length > 0,
      },
    };
  } catch (error) {
    printLog(`${debugPrefix} ERROR: ${error.message}`);
    return {
      stepType: 'search-chapters',
      results: [],
      metadata: { latencyMs: Date.now() - startTime, error: error.message },
      quality: { resultCount: 0, totalCount: 0, hasResults: false },
    };
  }
}

// ========== Step: Discover Podcasts ==========

async function stepDiscoverPodcasts({ query, limit = 10 }) {
  const debugPrefix = '[STEP:discover-podcasts]';
  const startTime = Date.now();

  try {
    printLog(`${debugPrefix} query="${query}", limit=${limit}`);

    const routing = await discoverInternal.extractSearchRouting(query);

    const bytermQueries = (routing.byterm_queries || []).slice(0, 2);
    const bypersonQueries = (routing.byperson_queries || []).slice(0, 2);
    const topicHints = (routing.topic_hints || []).slice(0, 2);
    const trendingParams = routing.trending || null;

    const searchPromises = [];
    const searchLabels = [];

    for (const term of bytermQueries) {
      searchPromises.push(discoverInternal.searchByTerm(term));
      searchLabels.push(`byterm:"${term}"`);
    }
    for (const person of bypersonQueries) {
      searchPromises.push(discoverInternal.searchByPerson(person));
      searchLabels.push(`byperson:"${person}"`);
    }
    for (const hint of topicHints) {
      searchPromises.push(discoverInternal.searchByTerm(hint));
      searchLabels.push(`topic_hint:"${hint}"`);
    }
    if (trendingParams) {
      searchPromises.push(discoverInternal.fetchTrending(trendingParams));
      searchLabels.push('trending');
    }

    const rawResults = await Promise.all(searchPromises);

    const feedMap = new Map();
    let resultIdx = 0;

    for (let i = 0; i < bytermQueries.length; i++) {
      const feeds = rawResults[resultIdx++] || [];
      for (const feed of feeds) {
        const normalized = discoverInternal.normalizeFeed(feed);
        if (normalized.feedId && !feedMap.has(normalized.feedId)) {
          feedMap.set(normalized.feedId, normalized);
        }
      }
    }

    for (let i = 0; i < bypersonQueries.length; i++) {
      const rawEpisodes = rawResults[resultIdx++] || [];
      const normalized = rawEpisodes.map(ep => discoverInternal.normalizePersonEpisode(ep));
      const filtered = discoverInternal.filterByPersonRelevance(normalized, bypersonQueries[i]);

      for (const ep of filtered) {
        if (ep.feedId && !feedMap.has(ep.feedId)) {
          feedMap.set(ep.feedId, {
            feedId: ep.feedId,
            feedGuid: ep.podcastGuid || null,
            title: ep.feedTitle,
            url: ep.feedUrl,
            description: '',
            author: ep.feedAuthor,
          });
        }
      }
    }

    for (let i = 0; i < topicHints.length; i++) {
      const feeds = rawResults[resultIdx++] || [];
      for (const feed of feeds) {
        const normalized = discoverInternal.normalizeFeed(feed);
        if (normalized.feedId && !feedMap.has(normalized.feedId)) {
          feedMap.set(normalized.feedId, normalized);
        }
      }
    }

    if (trendingParams) {
      const feeds = rawResults[resultIdx++] || [];
      for (const feed of feeds) {
        const normalized = discoverInternal.normalizeFeed(feed);
        if (normalized.feedId && !feedMap.has(normalized.feedId)) {
          feedMap.set(normalized.feedId, normalized);
        }
      }
    }

    // Check transcript availability
    const feedIds = Array.from(feedMap.keys());
    const transcribedDocs = feedIds.length > 0
      ? await JamieVectorMetadata.find({ type: 'feed', feedId: { $in: feedIds } }).select('feedId').lean()
      : [];
    const transcribedSet = new Set(transcribedDocs.map(f => String(f.feedId)));

    const results = Array.from(feedMap.values()).slice(0, limit).map(feed => ({
      ...feed,
      transcriptAvailable: transcribedSet.has(feed.feedId),
    }));

    const latencyMs = Date.now() - startTime;
    printLog(`${debugPrefix} complete (${latencyMs}ms): ${results.length} feeds, ${results.filter(r => r.transcriptAvailable).length} transcribed`);

    return {
      stepType: 'discover-podcasts',
      results,
      metadata: { latencyMs, query, routing: routing.intent, backendsQueried: searchLabels },
      quality: {
        resultCount: results.length,
        transcribedCount: results.filter(r => r.transcriptAvailable).length,
        hasResults: results.length > 0,
      },
    };
  } catch (error) {
    printLog(`${debugPrefix} ERROR: ${error.message}`);
    return {
      stepType: 'discover-podcasts',
      results: [],
      metadata: { latencyMs: Date.now() - startTime, error: error.message },
      quality: { resultCount: 0, transcribedCount: 0, hasResults: false },
    };
  }
}

// ========== Step: Person Lookup ==========

async function stepPersonLookup({ personName, personVariants = [] }) {
  const debugPrefix = '[STEP:person-lookup]';
  const startTime = Date.now();

  try {
    const nameVariants = personVariants.length > 0 ? personVariants : [personName];
    printLog(`${debugPrefix} personName="${personName}", variants=${nameVariants.length}`);

    const escapedVariants = nameVariants.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const variantRegex = escapedVariants.join('|');

    const episodes = await JamieVectorMetadata.aggregate([
      { $match: {
        type: 'episode',
        'metadataRaw.guests': { $exists: true, $ne: [] },
      }},
      { $unwind: '$metadataRaw.guests' },
      { $match: {
        'metadataRaw.guests': { $regex: variantRegex, $options: 'i' }
      }},
      { $group: {
        _id: '$guid',
        feedId: { $first: '$feedId' },
        title: { $first: '$metadataRaw.title' },
        creator: { $first: '$metadataRaw.creator' },
        publishedDate: { $first: '$metadataRaw.publishedDate' },
        matchedGuest: { $first: '$metadataRaw.guests' },
      }},
      { $sort: { publishedDate: -1 } },
      { $limit: 50 }
    ]);

    const guids = episodes.map(e => e._id).filter(Boolean);
    const feedIds = [...new Set(episodes.map(e => e.feedId).filter(Boolean))];

    const latencyMs = Date.now() - startTime;
    printLog(`${debugPrefix} complete (${latencyMs}ms): ${episodes.length} episodes across ${feedIds.length} feeds`);

    return {
      stepType: 'person-lookup',
      results: episodes.map(e => ({
        guid: e._id,
        feedId: e.feedId,
        title: e.title,
        creator: e.creator,
        publishedDate: e.publishedDate,
        matchedGuest: e.matchedGuest,
      })),
      metadata: { latencyMs, personName, variantsUsed: nameVariants, guids, feedIds },
      quality: {
        resultCount: episodes.length,
        feedCount: feedIds.length,
        hasResults: episodes.length > 0,
      },
    };
  } catch (error) {
    printLog(`${debugPrefix} ERROR: ${error.message}`);
    return {
      stepType: 'person-lookup',
      results: [],
      metadata: { latencyMs: Date.now() - startTime, error: error.message },
      quality: { resultCount: 0, feedCount: 0, hasResults: false },
    };
  }
}

// ========== Step: Submit On-Demand Transcription (Approval-Gated) ==========

async function stepSubmitOnDemand({ episodes, message = '' }) {
  const debugPrefix = '[STEP:submit-on-demand]';
  const startTime = Date.now();

  try {
    printLog(`${debugPrefix} ${episodes.length} episodes`);

    const crypto = require('crypto');
    const axios = require('axios');

    const jobId = crypto.randomBytes(16).toString('hex');

    const awsPayload = {
      jobId,
      message,
      parameters: {},
      episodes: episodes.map(ep => ({
        guid: ep.guid,
        feedGuid: ep.feedGuid,
        feedId: String(ep.feedId),
      })),
    };

    await WorkProductV2.create({
      lookupHash: jobId,
      type: 'on-demand-transcription',
      status: 'processing',
      createdAt: new Date(),
      metadata: { totalEpisodes: episodes.length, episodes: awsPayload.episodes },
    });

    const ingestorUrl = process.env.AWS_INGESTOR_PARALLEL_URL;
    if (ingestorUrl) {
      await axios.post(ingestorUrl, awsPayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      });
    }

    const latencyMs = Date.now() - startTime;
    printLog(`${debugPrefix} complete (${latencyMs}ms): jobId=${jobId}`);

    return {
      stepType: 'submit-on-demand',
      results: [{ jobId, totalEpisodes: episodes.length, status: 'processing' }],
      metadata: { latencyMs, jobId },
      quality: { submitted: true, hasResults: true, resultCount: 1 },
      requiresApproval: true,
    };
  } catch (error) {
    printLog(`${debugPrefix} ERROR: ${error.message}`);
    return {
      stepType: 'submit-on-demand',
      results: [],
      metadata: { latencyMs: Date.now() - startTime, error: error.message },
      quality: { submitted: false, hasResults: false, resultCount: 0 },
      requiresApproval: true,
    };
  }
}

// ========== Step: Poll On-Demand Job Status ==========

async function stepPollOnDemandStatus({ jobId, maxPollMs = 120000, intervalMs = 15000 }) {
  const debugPrefix = '[STEP:poll-on-demand]';
  const startTime = Date.now();

  try {
    printLog(`${debugPrefix} jobId=${jobId}, maxPoll=${maxPollMs}ms`);

    let job = null;
    let elapsed = 0;

    while (elapsed < maxPollMs) {
      job = await WorkProductV2.findOne({ lookupHash: jobId }).lean();

      if (!job) {
        return {
          stepType: 'poll-on-demand',
          results: [],
          metadata: { latencyMs: Date.now() - startTime, jobId, status: 'not_found' },
          quality: { complete: false, hasResults: false, resultCount: 0 },
        };
      }

      if (job.status === 'completed' || job.status === 'complete') {
        const latencyMs = Date.now() - startTime;
        printLog(`${debugPrefix} complete (${latencyMs}ms): job finished`);

        return {
          stepType: 'poll-on-demand',
          results: [{ jobId, status: 'complete' }],
          metadata: { latencyMs, jobId, status: 'complete' },
          quality: { complete: true, hasResults: true, resultCount: 1 },
        };
      }

      if (job.status === 'failed' || job.status === 'error') {
        return {
          stepType: 'poll-on-demand',
          results: [],
          metadata: { latencyMs: Date.now() - startTime, jobId, status: job.status },
          quality: { complete: false, hasResults: false, resultCount: 0 },
        };
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
      elapsed = Date.now() - startTime;
    }

    printLog(`${debugPrefix} timed out after ${maxPollMs}ms`);
    return {
      stepType: 'poll-on-demand',
      results: [{ jobId, status: job?.status || 'timeout' }],
      metadata: { latencyMs: Date.now() - startTime, jobId, status: 'timeout' },
      quality: { complete: false, hasResults: false, resultCount: 0 },
    };
  } catch (error) {
    printLog(`${debugPrefix} ERROR: ${error.message}`);
    return {
      stepType: 'poll-on-demand',
      results: [],
      metadata: { latencyMs: Date.now() - startTime, error: error.message },
      quality: { complete: false, hasResults: false, resultCount: 0 },
    };
  }
}

// ========== Step: Make Clip (STUB — future dev) ==========

async function stepMakeClip({ clipId, timestamps }) {
  return {
    stepType: 'make-clip',
    results: [],
    metadata: { message: 'Clip creation is not yet available in workflow mode. This step is reserved for future development.' },
    quality: { hasResults: false, resultCount: 0 },
    requiresApproval: true,
  };
}

// ========== Step Registry ==========

const STEP_REGISTRY = {
  'search-quotes': stepSearchQuotes,
  'search-chapters': stepSearchChapters,
  'discover-podcasts': stepDiscoverPodcasts,
  'person-lookup': stepPersonLookup,
  'submit-on-demand': stepSubmitOnDemand,
  'poll-on-demand': stepPollOnDemandStatus,
  'make-clip': stepMakeClip,
};

const REQUIRES_APPROVAL = new Set([
  'submit-on-demand',
]);

async function executeStep(stepType, params) {
  const fn = STEP_REGISTRY[stepType];
  if (!fn) {
    throw new Error(`Unknown step type: ${stepType}`);
  }
  return fn(params);
}

module.exports = {
  executeStep,
  STEP_REGISTRY,
  REQUIRES_APPROVAL,
  stepSearchQuotes,
  stepSearchChapters,
  stepDiscoverPodcasts,
  stepPersonLookup,
  stepSubmitOnDemand,
  stepPollOnDemandStatus,
  stepMakeClip,
  buildShareUrl,
  buildMiniPlayer,
};
