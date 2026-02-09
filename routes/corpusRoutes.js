/**
 * Corpus Routes - Read-only API for navigating the podcast corpus hierarchy
 * 
 * Hierarchy: Feeds → Episodes → Chapters
 * Plus: Topics (aggregated from chapter keywords)
 * 
 * Designed for AI agents to scan and explore the corpus efficiently.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

// =============================================================================
// RATE LIMITING - Permissive but present
// =============================================================================

const corpusRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests',
    message: 'Rate limit exceeded. Please wait before making more requests.',
    retryAfter: 60
  }
});

router.use(corpusRateLimiter);

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Parse and validate pagination params
 */
function getPaginationParams(query) {
  let limit = parseInt(query.limit, 10) || DEFAULT_LIMIT;
  limit = Math.min(Math.max(1, limit), MAX_LIMIT);
  
  let page = parseInt(query.page, 10) || 1;
  page = Math.max(1, page);
  
  const skip = (page - 1) * limit;
  
  return { limit, page, skip };
}

/**
 * Build pagination response object
 */
function buildPagination(page, limit, totalCount) {
  const totalPages = Math.ceil(totalCount / limit);
  return {
    page,
    totalPages,
    totalCount,
    limit,
    hasMore: page < totalPages
  };
}

/**
 * Format feed for slim response
 */
function formatFeed(doc) {
  const meta = doc.metadataRaw || {};
  return {
    feedId: doc.feedId || meta.feedId,
    title: meta.title || null,
    author: meta.author || null,
    description: meta.description || null,
    episodeCount: meta.episodeCount || null,
    imageUrl: meta.imageUrl || null
  };
}

/**
 * Format episode for slim response
 */
function formatEpisode(doc) {
  const meta = doc.metadataRaw || {};
  return {
    guid: doc.guid || meta.guid,
    title: meta.title || null,
    creator: meta.creator || null,
    description: meta.description || null,
    publishedDate: meta.publishedDate || doc.publishedDate || null,
    duration: meta.duration || null,
    imageUrl: meta.imageUrl || meta.episodeImage || null
  };
}

/**
 * Format chapter for slim response
 */
function formatChapter(doc) {
  const meta = doc.metadataRaw || {};
  return {
    pineconeId: doc.pineconeId,
    chapterNumber: meta.chapterNumber ?? meta.chapter_number ?? null,
    headline: meta.headline || null,
    keywords: meta.keywords || [],
    summary: meta.summary || null,
    startTime: meta.startTime ?? meta.start_time ?? doc.start_time ?? null,
    endTime: meta.endTime ?? meta.end_time ?? doc.end_time ?? null,
    duration: meta.duration || null
  };
}

// =============================================================================
// FEEDS ENDPOINTS
// =============================================================================

/**
 * GET /feeds
 * List all feeds (no arguments required)
 * 
 * Query params:
 *   - limit (default: 50, max: 200)
 *   - page (default: 1)
 */
router.get('/feeds', async (req, res) => {
  try {
    const { limit, page, skip } = getPaginationParams(req.query);
    
    // Get total count
    const totalCount = await JamieVectorMetadata.countDocuments({ type: 'feed' });
    
    // Fetch feeds
    const feeds = await JamieVectorMetadata.find({ type: 'feed' })
      .select('feedId metadataRaw')
      .sort({ 'metadataRaw.title': 1 })
      .skip(skip)
      .limit(limit)
      .lean();
    
    res.json({
      data: feeds.map(formatFeed),
      pagination: buildPagination(page, limit, totalCount)
    });
  } catch (error) {
    console.error('[corpusRoutes] Error fetching feeds:', error);
    res.status(500).json({ error: 'Failed to fetch feeds', details: error.message });
  }
});

/**
 * GET /feeds/:feedId
 * Get a single feed by feedId
 */
router.get('/feeds/:feedId', async (req, res) => {
  try {
    const { feedId } = req.params;
    
    const feed = await JamieVectorMetadata.findOne({ 
      type: 'feed', 
      feedId: feedId 
    })
      .select('feedId metadataRaw')
      .lean();
    
    if (!feed) {
      return res.status(404).json({ error: 'Feed not found', feedId });
    }
    
    res.json({ data: formatFeed(feed) });
  } catch (error) {
    console.error('[corpusRoutes] Error fetching feed:', error);
    res.status(500).json({ error: 'Failed to fetch feed', details: error.message });
  }
});

/**
 * GET /feeds/:feedId/episodes
 * List episodes for a specific feed
 * 
 * Query params:
 *   - limit (default: 50, max: 200)
 *   - page (default: 1)
 *   - sort: 'newest' (default) or 'oldest'
 *   - minDate: ISO date string (optional)
 *   - maxDate: ISO date string (optional)
 */
router.get('/feeds/:feedId/episodes', async (req, res) => {
  try {
    const { feedId } = req.params;
    const { limit, page, skip } = getPaginationParams(req.query);
    const { sort = 'newest', minDate, maxDate } = req.query;
    
    // Build query
    const query = { type: 'episode', feedId: feedId };
    
    // Date filters
    if (minDate || maxDate) {
      query.publishedTimestamp = {};
      if (minDate) {
        query.publishedTimestamp.$gte = new Date(minDate).getTime();
      }
      if (maxDate) {
        query.publishedTimestamp.$lte = new Date(maxDate).getTime();
      }
    }
    
    // Get total count
    const totalCount = await JamieVectorMetadata.countDocuments(query);
    
    // Sort direction
    const sortDir = sort === 'oldest' ? 1 : -1;
    
    // Fetch episodes
    const episodes = await JamieVectorMetadata.find(query)
      .select('guid feedId publishedDate publishedTimestamp metadataRaw')
      .sort({ publishedTimestamp: sortDir })
      .skip(skip)
      .limit(limit)
      .lean();
    
    res.json({
      data: episodes.map(formatEpisode),
      pagination: buildPagination(page, limit, totalCount)
    });
  } catch (error) {
    console.error('[corpusRoutes] Error fetching episodes:', error);
    res.status(500).json({ error: 'Failed to fetch episodes', details: error.message });
  }
});

// =============================================================================
// EPISODES ENDPOINTS
// =============================================================================

/**
 * GET /episodes/:guid
 * Get a single episode by GUID
 */
router.get('/episodes/:guid', async (req, res) => {
  try {
    const { guid } = req.params;
    
    const episode = await JamieVectorMetadata.findOne({ 
      type: 'episode', 
      guid: guid 
    })
      .select('guid feedId publishedDate publishedTimestamp metadataRaw')
      .lean();
    
    if (!episode) {
      return res.status(404).json({ error: 'Episode not found', guid });
    }
    
    res.json({ data: formatEpisode(episode) });
  } catch (error) {
    console.error('[corpusRoutes] Error fetching episode:', error);
    res.status(500).json({ error: 'Failed to fetch episode', details: error.message });
  }
});

/**
 * GET /episodes/:guid/chapters
 * List chapters for a specific episode
 * 
 * Query params:
 *   - limit (default: 50, max: 200)
 *   - page (default: 1)
 */
router.get('/episodes/:guid/chapters', async (req, res) => {
  try {
    const { guid } = req.params;
    const { limit, page, skip } = getPaginationParams(req.query);
    
    // Build query
    const query = { type: 'chapter', guid: guid };
    
    // Get total count
    const totalCount = await JamieVectorMetadata.countDocuments(query);
    
    // Fetch chapters sorted by chapter number or start time
    const chapters = await JamieVectorMetadata.find(query)
      .select('pineconeId guid start_time end_time metadataRaw')
      .sort({ start_time: 1 })
      .skip(skip)
      .limit(limit)
      .lean();
    
    res.json({
      data: chapters.map(formatChapter),
      pagination: buildPagination(page, limit, totalCount)
    });
  } catch (error) {
    console.error('[corpusRoutes] Error fetching chapters:', error);
    res.status(500).json({ error: 'Failed to fetch chapters', details: error.message });
  }
});

// =============================================================================
// TOPICS ENDPOINT
// =============================================================================

/**
 * GET /topics
 * Aggregated topics from chapter keywords (deduplicated)
 * 
 * Query params:
 *   - feedId: filter by specific feed (optional)
 *   - limit (default: 50, max: 200)
 *   - page (default: 1)
 */
router.get('/topics', async (req, res) => {
  try {
    const { feedId } = req.query;
    const { limit, page, skip } = getPaginationParams(req.query);
    
    // Build match stage
    const matchStage = { type: 'chapter', 'metadataRaw.keywords': { $exists: true, $ne: [] } };
    if (feedId) {
      matchStage.feedId = feedId;
    }
    
    // Aggregation pipeline to extract and count keywords
    const pipeline = [
      { $match: matchStage },
      { $unwind: '$metadataRaw.keywords' },
      {
        $group: {
          _id: { $toLower: '$metadataRaw.keywords' },
          count: { $sum: 1 },
          feeds: { $addToSet: { feedId: '$feedId', title: '$metadataRaw.feedTitle' } },
          sampleEpisodes: { 
            $addToSet: { 
              guid: '$guid', 
              title: '$metadataRaw.episodeTitle' 
            } 
          }
        }
      },
      { $sort: { count: -1 } },
      {
        $facet: {
          metadata: [{ $count: 'totalCount' }],
          data: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                keyword: '$_id',
                count: 1,
                feeds: { $slice: ['$feeds', 5] }, // Limit to 5 feeds per keyword
                sampleEpisodes: { $slice: ['$sampleEpisodes', 5] } // Limit to 5 episodes per keyword
              }
            }
          ]
        }
      }
    ];
    
    const [result] = await JamieVectorMetadata.aggregate(pipeline);
    
    const totalCount = result.metadata[0]?.totalCount || 0;
    const topics = result.data || [];
    
    // Clean up null values in feeds and sampleEpisodes
    const cleanedTopics = topics.map(topic => ({
      ...topic,
      feeds: topic.feeds.filter(f => f.feedId && f.title),
      sampleEpisodes: topic.sampleEpisodes.filter(e => e.guid && e.title)
    }));
    
    res.json({
      data: cleanedTopics,
      pagination: buildPagination(page, limit, totalCount)
    });
  } catch (error) {
    console.error('[corpusRoutes] Error fetching topics:', error);
    res.status(500).json({ error: 'Failed to fetch topics', details: error.message });
  }
});

module.exports = router;
