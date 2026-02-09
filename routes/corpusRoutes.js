/**
 * Corpus Routes - Read-only API for navigating the podcast corpus hierarchy
 * 
 * Hierarchy: Feeds → Episodes → Chapters
 * Plus: Topics (aggregated from chapter keywords)
 *       People (creators and guests)
 * 
 * Designed for AI agents to scan and explore the corpus efficiently.
 * 
 * GET /spec - Returns this API specification as markdown
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
    imageUrl: meta.imageUrl || meta.episodeImage || null,
    guests: meta.guests || []
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
// SPEC ENDPOINT - API Documentation
// =============================================================================

/**
 * GET /spec
 * Returns the API specification as markdown
 */
router.get('/spec', (req, res) => {
  const spec = `# Corpus API Specification

Base URL: \`/api/corpus\`

## Overview

Read-only API for navigating the podcast corpus hierarchy. Designed for AI agents and applications to explore podcast content efficiently.

**Rate Limit:** 200 requests/minute per IP

---

## Endpoints

### Stats & Documentation

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | \`/stats\` | Corpus-wide statistics |
| GET | \`/spec\` | This API specification (markdown) |

### Feeds (Podcasts)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | \`/feeds\` | List all feeds |
| GET | \`/feeds/:feedId\` | Get single feed |
| GET | \`/feeds/:feedId/episodes\` | List episodes for feed |

### Episodes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | \`/episodes/:guid\` | Get single episode |
| GET | \`/episodes/:guid/chapters\` | List chapters for episode |

### Topics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | \`/topics\` | Aggregated topics from chapter keywords |

### People (Creators & Guests)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | \`/people\` | List/search people (creators + guests) |
| POST | \`/people/episodes\` | Get episodes featuring a person |

---

## Common Query Parameters

| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| \`limit\` | number | 50 | 200 | Results per page |
| \`page\` | number | 1 | - | Page number |

---

## Endpoint Details

### GET /stats

Returns corpus-wide statistics.

**Response:**
\`\`\`json
{
  "feeds": { "total": 10 },
  "episodes": { "total": 5000 },
  "chapters": { "total": 50000 },
  "paragraphs": { "total": 500000 },
  "people": { "creators": 10, "guests": 500, "total": 510 },
  "topics": { "total": 2000 }
}
\`\`\`

---

### GET /feeds

List all podcast feeds.

**Query params:**
- \`limit\` (default: 50)
- \`page\` (default: 1)

**Response:**
\`\`\`json
{
  "data": [
    {
      "feedId": "123",
      "title": "Lex Fridman Podcast",
      "author": "Lex Fridman",
      "description": "...",
      "episodeCount": 481,
      "imageUrl": "https://..."
    }
  ],
  "pagination": { "page": 1, "totalPages": 1, "totalCount": 10, "limit": 50, "hasMore": false }
}
\`\`\`

---

### GET /feeds/:feedId/episodes

List episodes for a specific feed.

**Query params:**
- \`limit\` (default: 50)
- \`page\` (default: 1)
- \`sort\`: \`newest\` (default) or \`oldest\`
- \`minDate\`: ISO date string (optional)
- \`maxDate\`: ISO date string (optional)

---

### GET /topics

Aggregated topics from chapter keywords.

**Query params:**
- \`feedId\`: Filter by feed (optional)
- \`limit\` (default: 50)
- \`page\` (default: 1)

**Response:**
\`\`\`json
{
  "data": [
    {
      "keyword": "artificial intelligence",
      "count": 150,
      "feeds": [{ "feedId": "123", "title": "Lex Fridman Podcast" }],
      "sampleEpisodes": [{ "guid": "...", "title": "..." }]
    }
  ],
  "pagination": { ... }
}
\`\`\`

---

### GET /people

List/search people (creators and guests).

**Query params:**
- \`guestsOnly\`: boolean (default: false) - Exclude hosts/creators
- \`search\`: string - Partial name match (case-insensitive)
- \`feedId\`: string - Filter to specific podcast
- \`limit\` (default: 50)
- \`page\` (default: 1)

**Response:**
\`\`\`json
{
  "data": [
    {
      "name": "Elon Musk",
      "role": "guest",
      "appearances": 3,
      "feeds": [{ "feedId": "123", "title": "Lex Fridman Podcast" }],
      "recentEpisodes": [{ "guid": "...", "title": "...", "publishedDate": "..." }]
    }
  ],
  "pagination": { ... }
}
\`\`\`

---

### POST /people/episodes

Get episodes featuring a specific person.

**Request body:**
\`\`\`json
{
  "name": "Elon Musk",
  "guestsOnly": true,
  "feedId": "123",
  "limit": 50,
  "page": 1
}
\`\`\`

**Response:**
\`\`\`json
{
  "data": [
    {
      "guid": "abc123",
      "title": "#252 – Elon Musk: SpaceX, Mars...",
      "feedId": "123",
      "feedTitle": "Lex Fridman Podcast",
      "publishedDate": "2024-03-15",
      "role": "guest",
      "imageUrl": "https://..."
    }
  ],
  "pagination": { ... },
  "query": { "name": "Elon Musk", "guestsOnly": true }
}
\`\`\`

---

## Error Responses

All errors follow this format:
\`\`\`json
{
  "error": "Error type",
  "message": "Human-readable message",
  "details": "Technical details (when available)"
}
\`\`\`

Common HTTP status codes:
- \`400\` - Bad request (invalid parameters)
- \`404\` - Resource not found
- \`429\` - Rate limit exceeded
- \`500\` - Server error
`;

  res.type('text/markdown').send(spec);
});

// =============================================================================
// STATS ENDPOINT
// =============================================================================

/**
 * GET /stats
 * Corpus-wide statistics
 */
router.get('/stats', async (req, res) => {
  try {
    // Run all counts in parallel
    const [
      feedCount,
      episodeCount,
      chapterCount,
      paragraphCount,
      topicAgg,
      creatorAgg,
      guestAgg
    ] = await Promise.all([
      JamieVectorMetadata.countDocuments({ type: 'feed' }),
      JamieVectorMetadata.countDocuments({ type: 'episode' }),
      JamieVectorMetadata.countDocuments({ type: 'chapter' }),
      JamieVectorMetadata.countDocuments({ type: 'paragraph' }),
      // Count unique topics (keywords)
      JamieVectorMetadata.aggregate([
        { $match: { type: 'chapter', 'metadataRaw.keywords': { $exists: true, $ne: [] } } },
        { $unwind: '$metadataRaw.keywords' },
        { $group: { _id: { $toLower: '$metadataRaw.keywords' } } },
        { $count: 'total' }
      ]),
      // Count unique creators
      JamieVectorMetadata.aggregate([
        { $match: { type: 'episode', 'metadataRaw.creator': { $exists: true, $ne: null, $ne: '' } } },
        { $group: { _id: { $toLower: '$metadataRaw.creator' } } },
        { $count: 'total' }
      ]),
      // Count unique guests
      JamieVectorMetadata.aggregate([
        { $match: { type: 'episode', 'metadataRaw.guests': { $exists: true, $ne: [] } } },
        { $unwind: '$metadataRaw.guests' },
        { $group: { _id: { $toLower: '$metadataRaw.guests' } } },
        { $count: 'total' }
      ])
    ]);

    const topicCount = topicAgg[0]?.total || 0;
    const creatorCount = creatorAgg[0]?.total || 0;
    const guestCount = guestAgg[0]?.total || 0;

    res.json({
      feeds: { total: feedCount },
      episodes: { total: episodeCount },
      chapters: { total: chapterCount },
      paragraphs: { total: paragraphCount },
      people: {
        creators: creatorCount,
        guests: guestCount,
        total: creatorCount + guestCount
      },
      topics: { total: topicCount },
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[corpusRoutes] Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats', details: error.message });
  }
});

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

// =============================================================================
// PEOPLE ENDPOINTS
// =============================================================================

/**
 * GET /people
 * List/search people (creators and guests)
 * 
 * Query params:
 *   - guestsOnly: boolean (default: false) - Exclude hosts/creators, only show guests
 *   - search: string - Partial name match (case-insensitive)
 *   - feedId: string - Filter to specific podcast
 *   - limit (default: 50, max: 200)
 *   - page (default: 1)
 */
router.get('/people', async (req, res) => {
  try {
    const { guestsOnly, search, feedId } = req.query;
    const { limit, page, skip } = getPaginationParams(req.query);
    const excludeCreators = guestsOnly === 'true' || guestsOnly === true;

    // We'll run two aggregations in parallel: one for guests, one for creators (if not excluded)
    const pipelines = [];

    // --- Guest aggregation pipeline ---
    const guestMatchStage = { 
      type: 'episode', 
      'metadataRaw.guests': { $exists: true, $ne: [] } 
    };
    if (feedId) {
      guestMatchStage.feedId = feedId;
    }

    const guestPipeline = [
      { $match: guestMatchStage },
      { $unwind: '$metadataRaw.guests' },
      // Apply search filter if provided
      ...(search ? [{
        $match: {
          'metadataRaw.guests': { $regex: search, $options: 'i' }
        }
      }] : []),
      {
        $group: {
          _id: { $toLower: '$metadataRaw.guests' },
          name: { $first: '$metadataRaw.guests' }, // Keep original casing
          appearances: { $sum: 1 },
          feeds: { $addToSet: { feedId: '$feedId', title: '$metadataRaw.feedTitle' } },
          recentEpisodes: {
            $push: {
              guid: '$guid',
              title: '$metadataRaw.title',
              publishedDate: '$metadataRaw.publishedDate',
              publishedTimestamp: '$publishedTimestamp'
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          name: 1,
          role: { $literal: 'guest' },
          appearances: 1,
          feeds: { $slice: ['$feeds', 5] },
          recentEpisodes: {
            $slice: [
              { $sortArray: { input: '$recentEpisodes', sortBy: { publishedTimestamp: -1 } } },
              3
            ]
          }
        }
      }
    ];
    pipelines.push(JamieVectorMetadata.aggregate(guestPipeline));

    // --- Creator aggregation pipeline (if not guestsOnly) ---
    if (!excludeCreators) {
      const creatorMatchStage = { 
        type: 'episode', 
        'metadataRaw.creator': { $exists: true, $ne: null, $ne: '' } 
      };
      if (feedId) {
        creatorMatchStage.feedId = feedId;
      }

      const creatorPipeline = [
        { $match: creatorMatchStage },
        // Apply search filter if provided
        ...(search ? [{
          $match: {
            'metadataRaw.creator': { $regex: search, $options: 'i' }
          }
        }] : []),
        {
          $group: {
            _id: { $toLower: '$metadataRaw.creator' },
            name: { $first: '$metadataRaw.creator' },
            appearances: { $sum: 1 },
            feeds: { $addToSet: { feedId: '$feedId', title: '$metadataRaw.feedTitle' } },
            recentEpisodes: {
              $push: {
                guid: '$guid',
                title: '$metadataRaw.title',
                publishedDate: '$metadataRaw.publishedDate',
                publishedTimestamp: '$publishedTimestamp'
              }
            }
          }
        },
        {
          $project: {
            _id: 0,
            name: 1,
            role: { $literal: 'creator' },
            appearances: 1,
            feeds: { $slice: ['$feeds', 5] },
            recentEpisodes: {
              $slice: [
                { $sortArray: { input: '$recentEpisodes', sortBy: { publishedTimestamp: -1 } } },
                3
              ]
            }
          }
        }
      ];
      pipelines.push(JamieVectorMetadata.aggregate(creatorPipeline));
    }

    // Run pipelines in parallel
    const results = await Promise.all(pipelines);
    
    // Merge results
    let allPeople = results.flat();

    // Clean up null feeds and episodes
    allPeople = allPeople.map(person => ({
      ...person,
      feeds: (person.feeds || []).filter(f => f.feedId && f.title),
      recentEpisodes: (person.recentEpisodes || [])
        .filter(e => e.guid && e.title)
        .map(e => ({ guid: e.guid, title: e.title, publishedDate: e.publishedDate }))
    }));

    // Sort by appearances descending
    allPeople.sort((a, b) => b.appearances - a.appearances);

    // Apply pagination
    const totalCount = allPeople.length;
    const paginatedPeople = allPeople.slice(skip, skip + limit);

    res.json({
      data: paginatedPeople,
      pagination: buildPagination(page, limit, totalCount),
      query: {
        guestsOnly: excludeCreators,
        search: search || null,
        feedId: feedId || null
      }
    });
  } catch (error) {
    console.error('[corpusRoutes] Error fetching people:', error);
    res.status(500).json({ error: 'Failed to fetch people', details: error.message });
  }
});

/**
 * POST /people/episodes
 * Get episodes featuring a specific person
 * 
 * Request body:
 *   - name: string (required) - Person name to search for
 *   - guestsOnly: boolean (default: false) - Only match as guest, not creator
 *   - feedId: string (optional) - Filter to specific podcast
 *   - limit (default: 50, max: 200)
 *   - page (default: 1)
 */
router.post('/people/episodes', async (req, res) => {
  try {
    const { name, guestsOnly = false, feedId } = req.body;
    
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ 
        error: 'Bad request', 
        message: 'name is required in request body' 
      });
    }

    const { limit, page, skip } = getPaginationParams(req.body);
    const searchName = name.trim();
    const excludeCreators = guestsOnly === true || guestsOnly === 'true';

    // Build query conditions
    const orConditions = [];

    // Match as guest
    orConditions.push({
      'metadataRaw.guests': { $regex: `^${searchName}$`, $options: 'i' }
    });

    // Match as creator (unless guestsOnly)
    if (!excludeCreators) {
      orConditions.push({
        'metadataRaw.creator': { $regex: `^${searchName}$`, $options: 'i' }
      });
    }

    const query = {
      type: 'episode',
      $or: orConditions
    };

    if (feedId) {
      query.feedId = feedId;
    }

    // Get total count
    const totalCount = await JamieVectorMetadata.countDocuments(query);

    // Fetch episodes
    const episodes = await JamieVectorMetadata.find(query)
      .select('guid feedId publishedDate publishedTimestamp metadataRaw')
      .sort({ publishedTimestamp: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Format response with role information
    const formattedEpisodes = episodes.map(doc => {
      const meta = doc.metadataRaw || {};
      const guests = (meta.guests || []).map(g => g.toLowerCase());
      const creator = (meta.creator || '').toLowerCase();
      const searchLower = searchName.toLowerCase();

      let role = 'unknown';
      if (guests.includes(searchLower)) {
        role = 'guest';
      } else if (creator === searchLower) {
        role = 'creator';
      }

      return {
        guid: doc.guid || meta.guid,
        title: meta.title || null,
        feedId: doc.feedId || meta.feedId,
        feedTitle: meta.feedTitle || null,
        publishedDate: meta.publishedDate || doc.publishedDate || null,
        role,
        imageUrl: meta.imageUrl || meta.episodeImage || null,
        duration: meta.duration || null
      };
    });

    res.json({
      data: formattedEpisodes,
      pagination: buildPagination(page, limit, totalCount),
      query: {
        name: searchName,
        guestsOnly: excludeCreators,
        feedId: feedId || null
      }
    });
  } catch (error) {
    console.error('[corpusRoutes] Error fetching episodes by person:', error);
    res.status(500).json({ error: 'Failed to fetch episodes', details: error.message });
  }
});

module.exports = router;
