# Podcast Search Filters - API Reference

## Overview

The `/api/search-quotes` endpoint now supports advanced filtering capabilities to refine search results by date range and episode name. All filters are applied at the **Pinecone vector database level** for optimal performance and reliable results.

**Last Updated**: November 5, 2025

---

## Table of Contents

1. [Available Filters](#available-filters)
2. [API Usage](#api-usage)
3. [Implementation Details](#implementation-details)
4. [Filter Behavior](#filter-behavior)
5. [Performance Considerations](#performance-considerations)
6. [Examples](#examples)
7. [Troubleshooting](#troubleshooting)

---

## Available Filters

### 1. **Date Range Filters**

Filter search results by publication date using `minDate` and/or `maxDate`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `minDate` | String (ISO 8601) or Timestamp | No | Minimum publication date (inclusive) |
| `maxDate` | String (ISO 8601) or Timestamp | No | Maximum publication date (inclusive) |

**Supported Formats**:
- ISO 8601 date string: `"2025-11-01"` or `"2025-11-01T00:00:00.000Z"`
- Unix timestamp (milliseconds): `1730419200000`

**Filter Logic**:
- Uses `publishedTimestamp` field in Pinecone metadata
- Applied at database query level (not post-processing)
- Both filters can be used together to create a date range
- Either filter can be used independently

---

### 2. **Episode Name Filter**

Filter results to paragraphs from a specific episode using exact title matching.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `episodeName` | String | No | **EXACT** episode title (case-sensitive) |

**Important Constraints**:
- ⚠️ **Exact match only** - No substring or partial matching
- Must match the `episode` field in Pinecone metadata exactly
- Case-sensitive matching
- Applied at Pinecone query level for efficiency

**Why Exact Match?**

Pinecone (vector database) does not support substring or regex filtering in metadata. The episode name must match exactly as stored in the database. Use the search results to discover exact episode titles, then use those titles for filtering.

---

## API Usage

### Endpoint

```
POST /api/search-quotes
```

### Request Body

```json
{
  "query": "search query text",
  "limit": 5,
  "feedIds": ["feedId1", "feedId2"],
  "minDate": "2025-10-01",
  "maxDate": "2025-11-05",
  "episodeName": "Exact Episode Title"
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | String | Yes | - | Semantic search query |
| `limit` | Integer | No | 5 | Maximum results to return |
| `feedIds` | Array[String] | No | `[]` | Filter by podcast feed IDs |
| `minDate` | String | No | `null` | Minimum publication date |
| `maxDate` | String | No | `null` | Maximum publication date |
| `episodeName` | String | No | `null` | Exact episode title |

### Response Format

```json
{
  "query": "search query text",
  "results": [
    {
      "shareUrl": "https://pullthatupjamie.ai/share?clip=...",
      "shareLink": "episode_guid_p123",
      "quote": "Paragraph text content...",
      "episode": "Episode Title",
      "creator": "Creator Name",
      "audioUrl": "https://...",
      "episodeImage": "https://...",
      "listenLink": "https://...",
      "date": "2025-11-02T13:00:01.000Z",
      "similarity": {
        "combined": 0.8812,
        "vector": 0.8303
      },
      "timeContext": {
        "start_time": 3129.29,
        "end_time": 3179.46
      }
    }
  ],
  "total": 5,
  "model": "text-embedding-ada-002"
}
```

---

## Implementation Details

### Pinecone Filter Structure

All filters are combined into a single Pinecone metadata filter:

```javascript
const filter = {
  type: "paragraph",
  feedId: { $in: [intFeedIds] },           // If feedIds provided
  guid: "episode-guid",                     // If guid provided
  publishedTimestamp: { 
    $gte: minTimestamp,                     // If minDate provided
    $lte: maxTimestamp                      // If maxDate provided
  },
  episode: { $eq: "Exact Episode Title" }  // If episodeName provided
};
```

### Filter Processing Order

1. **Pinecone Query** - All metadata filters applied at database level
2. **Vector Search** - Semantic similarity scoring on filtered results
3. **Hybrid Ranking** - TF-IDF keyword scoring combined with vector scores
4. **Result Formatting** - Convert to API response format
5. **Limit Application** - Return top N results

### Performance Optimization

- **No post-processing filtering**: All filters run at Pinecone query level
- **Efficient date filtering**: Uses indexed `publishedTimestamp` field
- **Early termination**: Returns empty results immediately if no matches
- **Minimal data transfer**: Only matching paragraphs retrieved from database

---

## Filter Behavior

### Empty Results

When filters exclude all results, the API returns:

```json
{
  "query": "search query",
  "results": [],
  "total": 0,
  "model": "text-embedding-ada-002"
}
```

**Common causes of empty results**:
- No content published in specified date range
- Episode name doesn't match exactly (check spelling, capitalization, punctuation)
- Combination of filters too restrictive
- Feed ID has no content matching query + filters

### Date Range Behavior

| Scenario | minDate | maxDate | Behavior |
|----------|---------|---------|----------|
| Future dates | `2026-01-01` | `2026-12-31` | Returns empty (no future content) |
| Past dates | `2020-01-01` | `2020-12-31` | Returns results if content exists |
| Single day | `2025-11-02` | `2025-11-02` | Returns content from that exact day |
| Only minimum | `2025-10-01` | `null` | Returns all content after Oct 1 |
| Only maximum | `null` | `2025-11-05` | Returns all content before Nov 5 |

### Episode Name Matching

```javascript
// ✅ WILL MATCH
episodeName: "The Doctor Who Escaped Fiat Medicine With Bitcoin"
// Database value: "The Doctor Who Escaped Fiat Medicine With Bitcoin"

// ❌ WILL NOT MATCH
episodeName: "Doctor Who Escaped"           // Partial match
episodeName: "doctor who escaped..."        // Case mismatch
episodeName: "Fiat Medicine With Bitcoin"   // Missing beginning
```

---

## Performance Considerations

### Best Practices

1. **Use date filters when possible** - Significantly reduces search space
2. **Combine filters strategically** - More filters = faster, more precise results
3. **Exact episode titles** - Prevents unnecessary empty result queries
4. **Reasonable limits** - Lower limits reduce processing time

### Query Timing

| Filter Combination | Typical Response Time |
|-------------------|----------------------|
| No filters | 2-3 seconds |
| Date filters only | 1-2 seconds |
| Episode filter only | 1-2 seconds |
| All filters | 1-2 seconds |
| No matches (empty) | < 1 second |

---

## Examples

### Example 1: Search Recent Content

Find discussions about "Bitcoin" from the last month:

```bash
curl 'http://localhost:4132/api/search-quotes' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "query": "Bitcoin price prediction",
    "limit": 10,
    "minDate": "2025-10-05",
    "maxDate": "2025-11-05"
  }'
```

### Example 2: Search Specific Episode

Find content about "dreams" in a specific episode:

```bash
curl 'http://localhost:4132/api/search-quotes' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "query": "unconscious dreams nature",
    "limit": 5,
    "feedIds": ["6708272"],
    "episodeName": "The Doctor Who Escaped Fiat Medicine With Bitcoin"
  }'
```

### Example 3: Date Range + Episode Filter

Combine all filters for precise results:

```bash
curl 'http://localhost:4132/api/search-quotes' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "query": "health medicine",
    "limit": 5,
    "feedIds": ["6708272"],
    "episodeName": "The Doctor Who Escaped Fiat Medicine With Bitcoin",
    "minDate": "2025-11-01",
    "maxDate": "2025-11-30"
  }'
```

### Example 4: Get Recent Episodes from Specific Podcast

```bash
curl 'http://localhost:4132/api/search-quotes' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "query": "artificial intelligence",
    "limit": 20,
    "feedIds": ["229239"],
    "minDate": "2025-09-01"
  }'
```

---

## Troubleshooting

### Issue: Getting Empty Results with Episode Filter

**Problem**: `episodeName` filter returns 0 results even though episode exists.

**Solutions**:
1. First search without episode filter to find exact title:
   ```json
   {
     "query": "your search",
     "feedIds": ["feedId"]
   }
   ```
2. Copy the **exact** episode title from results
3. Use that exact title in `episodeName` filter

### Issue: Date Filter Not Working as Expected

**Problem**: Results outside date range appearing.

**Solutions**:
1. Verify date format is ISO 8601: `"2025-11-01"`
2. Check that dates are realistic (not future dates)
3. Ensure timezone considerations (dates converted to UTC timestamps)

### Issue: Slow Query Performance

**Problem**: Queries taking longer than expected.

**Solutions**:
1. Add date filters to reduce search space
2. Lower the `limit` parameter
3. Use more specific search queries
4. Ensure feedIds are provided when searching specific podcasts

### Issue: No Results Found

**Checklist**:
- [ ] Are dates within range of available content?
- [ ] Is episode name spelled exactly as stored?
- [ ] Are feedIds correct?
- [ ] Is the query semantic enough to match content?
- [ ] Try removing filters one by one to identify issue

---

## Technical Notes

### Database Schema Requirements

The following metadata fields must be indexed in Pinecone:

```javascript
{
  type: "paragraph",           // Document type
  feedId: 6708272,            // Podcast feed identifier
  guid: "episode-guid",        // Episode unique identifier
  episode: "Episode Title",    // Full episode title
  publishedDate: "2025-11-02T13:00:01.000Z",  // ISO date string
  publishedTimestamp: 1730808001000,          // Unix timestamp (ms)
  publishedYear: 2025,         // Year (for analytics)
  publishedMonth: 11,          // Month (for analytics)
  text: "Paragraph content",   // Full text content
  start_time: 3129.29,         // Audio start time
  end_time: 3179.46            // Audio end time
}
```

### Migration from Old Implementation

**Previous Behavior** (❌ Inefficient):
- Filters applied after Pinecone query in JavaScript
- Limited result set could miss matches
- Post-processing caused timeouts on empty results

**Current Behavior** (✅ Optimized):
- All filters applied at Pinecone query level
- Full result set available for filtering
- Fast empty result handling
- Exact match requirement for episode names

---

## Related Documentation

- [MODELS_SUMMARY.md](./data-models/MODELS_SUMMARY.md) - Data model overview
- [SEARCH_TROUBLESHOOTING.md](./troubleshooting/SEARCH_TROUBLESHOOTING.md) - Search debugging guide
- [Pinecone Documentation](https://docs.pinecone.io/) - Vector database documentation

---

## Changelog

### Version 2.0 (November 5, 2025)
- ✅ Added `minDate` and `maxDate` filters
- ✅ Added `episodeName` exact match filter
- ✅ Moved all filtering to Pinecone query level
- ✅ Improved empty result handling
- ✅ Enhanced performance and reliability

### Version 1.0 (Initial)
- Basic semantic search with `query` parameter
- Feed filtering via `feedIds`
- No date or episode filtering

