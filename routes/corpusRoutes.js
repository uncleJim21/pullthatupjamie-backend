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
const corpusService = require('../services/corpusService');

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
  // #swagger.tags = ['Corpus Discovery']
  // #swagger.summary = 'Get API specification as markdown'
  // #swagger.description = 'Returns the Corpus API specification as a markdown document. Useful for agents to understand available endpoints.'
  /* #swagger.responses[200] = {
    description: 'Markdown API specification',
    content: { 'text/markdown': { schema: { type: 'string' } } }
  } */
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
| GET | \`/feeds/:feedId/stats\` | Get feed statistics (depth check) |
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

### GET /feeds/:feedId/stats

Get statistics for a specific feed. Useful for agents to assess feed depth before searching.

**Response:**
\`\`\`json
{
  "feedId": "1015378",
  "title": "What Bitcoin Did",
  "episodeCount": 824,
  "chapterCount": 3200,
  "paragraphCount": 45000,
  "dateRange": { "earliest": "2018-11-01", "latest": "2026-02-06" },
  "generatedAt": "2026-02-09T..."
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
  // #swagger.tags = ['Corpus Discovery']
  // #swagger.summary = 'Get corpus-wide statistics'
  // #swagger.description = 'Returns aggregate counts for feeds, episodes, chapters, paragraphs, people, and topics across the entire corpus.'
  /* #swagger.responses[200] = {
    description: 'Corpus statistics',
    schema: {
      feeds: { total: 10 },
      episodes: { total: 5000 },
      chapters: { total: 50000 },
      paragraphs: { total: 500000 },
      people: { creators: 10, guests: 500, total: 510 },
      topics: { total: 2000 },
      generatedAt: '2026-02-13T00:00:00.000Z'
    }
  } */
  /* #swagger.responses[500] = {
    description: 'Server error',
    schema: { $ref: '#/components/schemas/Error' }
  } */
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
  // #swagger.tags = ['Corpus Discovery']
  // #swagger.summary = 'List all podcast feeds'
  // #swagger.description = 'Returns a paginated list of all podcast feeds in the corpus.'
  /* #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Results per page (default: 50, max: 200)', required: false } */
  /* #swagger.parameters['page'] = { in: 'query', type: 'integer', description: 'Page number (default: 1)', required: false } */
  /* #swagger.responses[200] = {
    description: 'Paginated feed list',
    schema: {
      data: [{ $ref: '#/components/schemas/Feed' }],
      pagination: { $ref: '#/components/schemas/Pagination' }
    }
  } */
  /* #swagger.responses[500] = {
    description: 'Server error',
    schema: { $ref: '#/components/schemas/Error' }
  } */
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
 * GET /feeds/:feedId/stats
 * Get statistics for a specific feed
 * Useful for agents to assess feed depth before searching
 */
router.get('/feeds/:feedId/stats', async (req, res) => {
  // #swagger.tags = ['Corpus Discovery']
  // #swagger.summary = 'Get statistics for a specific feed'
  // #swagger.description = 'Returns episode, chapter, and paragraph counts plus date range for a specific feed. Useful for agents to assess feed depth before searching.'
  /* #swagger.parameters['feedId'] = { in: 'path', required: true, type: 'string', description: 'Feed identifier' } */
  /* #swagger.responses[200] = {
    description: 'Feed statistics',
    schema: {
      feedId: '1015378',
      title: 'What Bitcoin Did',
      episodeCount: 824,
      chapterCount: 3200,
      paragraphCount: 45000,
      dateRange: { earliest: '2018-11-01', latest: '2026-02-06' },
      generatedAt: '2026-02-13T00:00:00.000Z'
    }
  } */
  /* #swagger.responses[404] = {
    description: 'Feed not found',
    schema: { error: 'Feed not found', feedId: '1015378' }
  } */
  /* #swagger.responses[500] = {
    description: 'Server error',
    schema: { $ref: '#/components/schemas/Error' }
  } */
  try {
    const { feedId } = req.params;

    // First, get the feed to verify it exists and get its title
    const feed = await JamieVectorMetadata.findOne({ 
      type: 'feed', 
      feedId: feedId 
    })
      .select('feedId metadataRaw')
      .lean();

    if (!feed) {
      return res.status(404).json({ error: 'Feed not found', feedId });
    }

    // Run all counts and date range query in parallel
    const [
      episodeCount,
      chapterCount,
      paragraphCount,
      dateRangeAgg
    ] = await Promise.all([
      JamieVectorMetadata.countDocuments({ type: 'episode', feedId }),
      JamieVectorMetadata.countDocuments({ type: 'chapter', feedId }),
      JamieVectorMetadata.countDocuments({ type: 'paragraph', feedId }),
      // Get earliest and latest episode dates
      JamieVectorMetadata.aggregate([
        { $match: { type: 'episode', feedId, publishedTimestamp: { $exists: true, $ne: null } } },
        {
          $group: {
            _id: null,
            earliest: { $min: '$publishedTimestamp' },
            latest: { $max: '$publishedTimestamp' }
          }
        }
      ])
    ]);

    const dateRange = dateRangeAgg[0] || {};
    const meta = feed.metadataRaw || {};

    res.json({
      feedId,
      title: meta.title || null,
      episodeCount,
      chapterCount,
      paragraphCount,
      dateRange: {
        earliest: dateRange.earliest ? new Date(dateRange.earliest).toISOString().split('T')[0] : null,
        latest: dateRange.latest ? new Date(dateRange.latest).toISOString().split('T')[0] : null
      },
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[corpusRoutes] Error fetching feed stats:', error);
    res.status(500).json({ error: 'Failed to fetch feed stats', details: error.message });
  }
});

/**
 * GET /feeds/:feedId
 * Get a single feed by feedId
 */
router.get('/feeds/:feedId', async (req, res) => {
  // #swagger.tags = ['Corpus Discovery']
  // #swagger.summary = 'Get a single feed by ID'
  // #swagger.description = 'Returns details for a specific podcast feed.'
  /* #swagger.parameters['feedId'] = { in: 'path', required: true, type: 'string', description: 'Feed identifier' } */
  /* #swagger.responses[200] = {
    description: 'Feed details',
    schema: { data: { $ref: '#/components/schemas/Feed' } }
  } */
  /* #swagger.responses[404] = {
    description: 'Feed not found',
    schema: { error: 'Feed not found', feedId: '1015378' }
  } */
  /* #swagger.responses[500] = {
    description: 'Server error',
    schema: { $ref: '#/components/schemas/Error' }
  } */
  try {
    const result = await corpusService.getFeed({ feedId: req.params.feedId });
    if (!result) return res.status(404).json({ error: 'Feed not found', feedId: req.params.feedId });
    res.json(result);
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
  // #swagger.tags = ['Corpus Discovery']
  // #swagger.summary = 'List episodes for a feed'
  // #swagger.description = 'Returns a paginated list of episodes for a specific feed, with optional date filtering and sort order.'
  /* #swagger.parameters['feedId'] = { in: 'path', required: true, type: 'string', description: 'Feed identifier' } */
  /* #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Results per page (default: 50, max: 200)', required: false } */
  /* #swagger.parameters['page'] = { in: 'query', type: 'integer', description: 'Page number (default: 1)', required: false } */
  /* #swagger.parameters['sort'] = { in: 'query', type: 'string', description: 'Sort order: newest (default) or oldest', required: false, enum: ['newest', 'oldest'] } */
  /* #swagger.parameters['minDate'] = { in: 'query', type: 'string', description: 'Minimum published date (ISO format)', required: false } */
  /* #swagger.parameters['maxDate'] = { in: 'query', type: 'string', description: 'Maximum published date (ISO format)', required: false } */
  /* #swagger.responses[200] = {
    description: 'Paginated episode list',
    schema: {
      data: [{ $ref: '#/components/schemas/Episode' }],
      pagination: { $ref: '#/components/schemas/Pagination' }
    }
  } */
  /* #swagger.responses[500] = {
    description: 'Server error',
    schema: { $ref: '#/components/schemas/Error' }
  } */
  try {
    const result = await corpusService.getFeedEpisodes({
      feedId: req.params.feedId,
      limit: req.query.limit,
      page: req.query.page,
      sort: req.query.sort,
      minDate: req.query.minDate,
      maxDate: req.query.maxDate,
    });
    res.json(result);
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
  // #swagger.tags = ['Corpus Discovery']
  // #swagger.summary = 'Get a single episode by GUID'
  // #swagger.description = 'Returns details for a specific episode by its GUID.'
  /* #swagger.parameters['guid'] = { in: 'path', required: true, type: 'string', description: 'Episode GUID' } */
  /* #swagger.responses[200] = {
    description: 'Episode details',
    schema: { data: { $ref: '#/components/schemas/Episode' } }
  } */
  /* #swagger.responses[404] = {
    description: 'Episode not found',
    schema: { error: 'Episode not found', guid: 'abc123' }
  } */
  /* #swagger.responses[500] = {
    description: 'Server error',
    schema: { $ref: '#/components/schemas/Error' }
  } */
  try {
    const result = await corpusService.getEpisode({ guid: req.params.guid });
    if (!result) return res.status(404).json({ error: 'Episode not found', guid: req.params.guid });
    res.json(result);
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
  // #swagger.tags = ['Corpus Discovery']
  // #swagger.summary = 'List chapters for an episode'
  // #swagger.description = 'Returns a paginated list of chapters for a specific episode, sorted by start time.'
  /* #swagger.parameters['guid'] = { in: 'path', required: true, type: 'string', description: 'Episode GUID' } */
  /* #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Results per page (default: 50, max: 200)', required: false } */
  /* #swagger.parameters['page'] = { in: 'query', type: 'integer', description: 'Page number (default: 1)', required: false } */
  /* #swagger.responses[200] = {
    description: 'Paginated chapter list',
    schema: {
      data: [{ $ref: '#/components/schemas/Chapter' }],
      pagination: { $ref: '#/components/schemas/Pagination' }
    }
  } */
  /* #swagger.responses[500] = {
    description: 'Server error',
    schema: { $ref: '#/components/schemas/Error' }
  } */
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

/**
 * GET /chapters
 * Batch fetch chapters for multiple episodes by GUIDs or feedIds
 *
 * Query params:
 *   - guids: comma-separated episode GUIDs
 *   - feedIds: comma-separated feed IDs
 *   - limit (default: 100, max: 200)
 */
router.get('/chapters', async (req, res) => {
  try {
    const result = await corpusService.listChapters({
      guids: req.query.guids,
      feedIds: req.query.feedIds,
      limit: req.query.limit,
    });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    console.error('[corpusRoutes] Error fetching batch chapters:', error);
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
  // #swagger.tags = ['Corpus Discovery']
  // #swagger.summary = 'List aggregated topics'
  // #swagger.description = 'Returns aggregated topics derived from chapter keywords, sorted by frequency. Optionally filter by feedId.'
  /* #swagger.parameters['feedId'] = { in: 'query', type: 'string', description: 'Filter topics to a specific feed', required: false } */
  /* #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Results per page (default: 50, max: 200)', required: false } */
  /* #swagger.parameters['page'] = { in: 'query', type: 'integer', description: 'Page number (default: 1)', required: false } */
  /* #swagger.responses[200] = {
    description: 'Paginated topic list',
    schema: {
      data: [{ $ref: '#/components/schemas/Topic' }],
      pagination: { $ref: '#/components/schemas/Pagination' }
    }
  } */
  /* #swagger.responses[500] = {
    description: 'Server error',
    schema: { $ref: '#/components/schemas/Error' }
  } */
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
  // #swagger.tags = ['Corpus Discovery']
  // #swagger.summary = 'List people (creators and guests)'
  // #swagger.description = 'Returns a paginated list of people (podcast creators and guests), sorted by number of appearances. Supports filtering by role, name search, and feed.'
  /* #swagger.parameters['guestsOnly'] = { in: 'query', type: 'boolean', description: 'Exclude hosts/creators, only show guests (default: false)', required: false } */
  /* #swagger.parameters['search'] = { in: 'query', type: 'string', description: 'Partial name match (case-insensitive)', required: false } */
  /* #swagger.parameters['feedId'] = { in: 'query', type: 'string', description: 'Filter to a specific podcast', required: false } */
  /* #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Results per page (default: 50, max: 200)', required: false } */
  /* #swagger.parameters['page'] = { in: 'query', type: 'integer', description: 'Page number (default: 1)', required: false } */
  /* #swagger.responses[200] = {
    description: 'Paginated people list',
    schema: {
      data: [{ $ref: '#/components/schemas/Person' }],
      pagination: { $ref: '#/components/schemas/Pagination' },
      query: { guestsOnly: false, search: null, feedId: null }
    }
  } */
  /* #swagger.responses[500] = {
    description: 'Server error',
    schema: { $ref: '#/components/schemas/Error' }
  } */
  try {
    const result = await corpusService.findPeople(req.query);
    res.json(result);
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
  // #swagger.tags = ['Corpus Discovery']
  // #swagger.summary = 'Get episodes featuring a person'
  // #swagger.description = 'Returns a paginated list of episodes that feature a specific person (as guest or creator). Requires person name in request body.'
  /* #swagger.parameters['body'] = {
    in: 'body',
    required: true,
    schema: {
      name: 'Elon Musk',
      guestsOnly: false,
      feedId: '',
      limit: 50,
      page: 1
    }
  } */
  /* #swagger.responses[200] = {
    description: 'Paginated episodes featuring the person',
    schema: {
      data: [{
        guid: 'abc123',
        title: '#252 - Elon Musk: SpaceX, Mars...',
        feedId: '123',
        feedTitle: 'Lex Fridman Podcast',
        publishedDate: '2024-03-15',
        role: 'guest',
        imageUrl: 'https://...',
        duration: '2:30:00'
      }],
      pagination: { $ref: '#/components/schemas/Pagination' },
      query: { name: 'Elon Musk', guestsOnly: false, feedId: null }
    }
  } */
  /* #swagger.responses[400] = {
    description: 'Missing or invalid name',
    schema: { error: 'Bad request', message: 'name is required in request body' }
  } */
  /* #swagger.responses[500] = {
    description: 'Server error',
    schema: { $ref: '#/components/schemas/Error' }
  } */
  try {
    const result = await corpusService.getPersonEpisodes(req.body);
    if (result.status) return res.status(result.status).json(result);
    res.json(result);
  } catch (error) {
    console.error('[corpusRoutes] Error fetching episodes by person:', error);
    res.status(500).json({ error: 'Failed to fetch episodes', details: error.message });
  }
});

module.exports = router;
