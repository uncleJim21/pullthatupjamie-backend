# 3D Multi-Search Session API Documentation

**Version**: 1.0.0  
**Endpoints**: `POST /api/search-quotes-3d` (with `createSession`), `POST /api/search-quotes-3d/expand`  
**Status**: Beta

---

## Overview

The Multi-Search Session feature extends the 3D Semantic Search to support **iterative exploration**. Instead of a single search query, users can build up a collection of results from multiple queries, with all items re-projected into a unified 3D space after each addition.

**Key Features:**
- Create a session from an initial 3D search
- Expand sessions with additional queries (up to 5 per request)
- Automatic deduplication by `pineconeId`
- Full UMAP re-projection after each expansion
- Axis labels regenerated to reflect combined semantic space
- In-memory caching with configurable TTL and capacity limits
- Track which query found each result via `sourceQueryIndex`

**Use Cases:**
- Exploratory research across multiple related topics
- Building curated collections of clips
- Comparing how different queries cluster in semantic space

---

## Session Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Initial Search (createSession: true)                        │
│     POST /api/search-quotes-3d                                  │
│     → Returns sessionId + results with 3D coordinates           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Expand Session (one or more times)                          │
│     POST /api/search-quotes-3d/expand                           │
│     → Adds new items, re-runs UMAP on ALL items                 │
│     → Returns full updated results with new coordinates         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Session Expires                                             │
│     After 30 minutes of inactivity (configurable)               │
│     Or evicted when cache reaches capacity (circular buffer)    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Endpoint 1: Create Session

### Request

```
POST /api/search-quotes-3d
```

Add `createSession: true` to the standard 3D search request.

### Request Body

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | **Yes** | - | Search query text |
| `createSession` | boolean | No | false | **Set to `true` to create a session** |
| `limit` | integer | No | 50 | Max results (capped at 50) |
| `feedIds` | array | No | [] | Filter by podcast feed IDs |
| `minDate` | string | No | null | Minimum publication date |
| `maxDate` | string | No | null | Maximum publication date |
| `episodeName` | string | No | null | Exact episode name match |
| `fastMode` | boolean | No | false | Enable fast UMAP mode |
| `extractAxisLabels` | boolean | No | false | Generate semantic axis labels |

### Example Request

```bash
curl -X POST http://localhost:4132/api/search-quotes-3d \
  -H "Content-Type: application/json" \
  -d '{
    "query": "bitcoin monetary policy",
    "limit": 25,
    "createSession": true,
    "extractAxisLabels": true
  }'
```

### Response (with session)

```json
{
  "query": "bitcoin monetary policy",
  "sessionId": "msess_mkg2siut_51frdewz",
  "results": [
    {
      "shareLink": "b1699eea-bf82-41bc-8b08-84f8ccd0b7d6_p78",
      "quote": "Like, we can at least raise interest rates...",
      "episode": "The System is Bankrupt",
      "creator": "Robin Seyr",
      "coordinates3d": { "x": -0.102, "y": -1.0, "z": -0.506 },
      "hierarchyLevel": "paragraph"
      // ... other standard fields
    }
    // ... more results
  ],
  "total": 25,
  "metadata": {
    "sessionCreated": true,
    "numResults": 25,
    "totalTimeMs": 4335
    // ... timing breakdown
  },
  "axisLabels": {
    "center": "Interest Rates",
    "xPositive": "Interest Rates",
    "xNegative": "Bitcoin Policy",
    "yPositive": "Monetary Narrative",
    "yNegative": "Bitcoin Yield",
    "zPositive": "Bullish Outlook",
    "zNegative": "Inflation Risks"
  }
}
```

**Important**: Store the `sessionId` — you'll need it for expand requests.

---

## Endpoint 2: Expand Session

### Request

```
POST /api/search-quotes-3d/expand
```

### Request Body

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `sessionId` | string | **Yes** | - | Session ID from initial search |
| `queries` | array | **Yes** | - | Array of query objects (1-5) |
| `fastMode` | boolean | No | false | Enable fast UMAP mode |
| `extractAxisLabels` | boolean | No | false | Regenerate axis labels |

### Query Object

Each object in the `queries` array:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | **Yes** | - | Search query text |
| `limit` | integer | No | 25 | Max results per query |
| `feedIds` | array | No | [] | Filter by podcast feed IDs |
| `guid` | string | No | null | Filter to specific episode |
| `minDate` | string | No | null | Minimum publication date |
| `maxDate` | string | No | null | Maximum publication date |
| `episodeName` | string | No | null | Exact episode name match |

### Example Request

```bash
curl -X POST http://localhost:4132/api/search-quotes-3d/expand \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "msess_mkg2siut_51frdewz",
    "queries": [
      { "query": "federal reserve interest rates", "limit": 15 },
      { "query": "gold standard history", "limit": 15 }
    ],
    "extractAxisLabels": true
  }'
```

### Response

```json
{
  "sessionId": "msess_mkg2siut_51frdewz",
  "query": "federal reserve interest rates | gold standard history",
  "results": [
    {
      "shareLink": "b1699eea-bf82-41bc-8b08-84f8ccd0b7d6_p78",
      "quote": "Like, we can at least raise interest rates...",
      "coordinates3d": { "x": 0.234, "y": -0.456, "z": 0.123 },
      "hierarchyLevel": "paragraph",
      "sourceQueryIndex": 0
    },
    {
      "shareLink": "abc123_p45",
      "quote": "The Federal Reserve's role in...",
      "coordinates3d": { "x": 0.567, "y": 0.234, "z": -0.345 },
      "hierarchyLevel": "paragraph",
      "sourceQueryIndex": 1
    }
    // ... all items from all queries
  ],
  "total": 55,
  "added": 30,
  "duplicatesSkipped": 0,
  "queryResults": [
    { "query": "federal reserve interest rates", "found": 15 },
    { "query": "gold standard history", "found": 15 }
  ],
  "metadata": {
    "numResults": 55,
    "queriesProcessed": 2,
    "totalTimeMs": 5484,
    "approach": "multi-search-expand"
  },
  "axisLabels": {
    "center": "Interest Rates",
    "xPositive": "Bitcoin Independence",
    "xNegative": "Historical Standards",
    "yPositive": "Fed Critique",
    "yNegative": "Book Promotion",
    "zPositive": "Gold Standard Influence",
    "zNegative": "Monetary Policy Narratives"
  }
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string | The session ID |
| `query` | string | Combined query string (pipe-separated) |
| `results` | array | **All** items in session with updated coordinates |
| `total` | integer | Total items in session |
| `added` | integer | New items added this request |
| `duplicatesSkipped` | integer | Items skipped (already in session) |
| `queryResults` | array | Per-query breakdown of results found |
| `axisLabels` | object | Updated semantic axis labels |

### The `sourceQueryIndex` Field

Each result includes `sourceQueryIndex` indicating which query found it:

| Value | Meaning |
|-------|---------|
| `0` | Initial search query |
| `1` | First expand request |
| `2` | Second expand request |
| ... | Subsequent expands |

Use this to color-code or filter results by query in your visualization.

---

## Error Responses

### 400 Bad Request - Missing Session ID

```json
{
  "error": "sessionId is required"
}
```

### 400 Bad Request - Empty Queries

```json
{
  "error": "queries array is required and must not be empty"
}
```

### 400 Bad Request - Too Many Queries

```json
{
  "error": "Maximum 5 queries per expand request",
  "provided": 7
}
```

### 404 Not Found - Session Expired/Missing

```json
{
  "error": "Session not found or expired",
  "sessionId": "msess_abc123"
}
```

### 400 Bad Request - Session at Capacity

```json
{
  "error": "Session is at capacity",
  "currentItems": 100,
  "maxItems": 100
}
```

---

## Session Limits & Configuration

### Default Limits

| Limit | Default | Env Variable |
|-------|---------|--------------|
| Max sessions | 100 | `MULTI_SEARCH_MAX_SESSIONS` |
| Max items per session | 100 | `MULTI_SEARCH_MAX_ITEMS_PER_SESSION` |
| Session TTL | 30 minutes | `MULTI_SEARCH_MAX_AGE_MS` |
| Cleanup interval | 5 minutes | `MULTI_SEARCH_CLEANUP_INTERVAL_MS` |
| Max queries per expand | 5 | Hardcoded |
| Default limit per query | 25 | Hardcoded |

### Memory Usage

Estimated memory per session:
- ~8KB per item (6KB embedding + 2KB metadata)
- 100 sessions × 100 items × 8KB = **~80MB total**

### Eviction Policy

Sessions are managed with a **circular buffer** approach:
1. When cache reaches `maxSessions`, the oldest session is evicted
2. Sessions also expire after `maxAgeMs` of inactivity
3. Accessing a session updates its `lastAccessedAt` timestamp

---

## Frontend Integration

### Basic Flow

```javascript
// 1. Initial search with session creation
async function startExploration(query) {
  const response = await fetch('/api/search-quotes-3d', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      limit: 25,
      createSession: true,
      extractAxisLabels: true
    })
  });
  
  const data = await response.json();
  
  // Store session ID for later
  setSessionId(data.sessionId);
  
  // Render initial results
  renderGalaxyView(data.results, data.axisLabels);
  
  return data;
}

// 2. Expand with additional queries
async function expandExploration(sessionId, newQueries) {
  const response = await fetch('/api/search-quotes-3d/expand', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      queries: newQueries.map(q => ({ query: q, limit: 20 })),
      extractAxisLabels: true
    })
  });
  
  const data = await response.json();
  
  // Re-render with ALL items (coordinates have changed!)
  renderGalaxyView(data.results, data.axisLabels);
  
  // Show expansion stats
  showNotification(`Added ${data.added} new items (${data.duplicatesSkipped} duplicates)`);
  
  return data;
}
```

### Color-Coding by Query

```javascript
function getColorForQueryIndex(sourceQueryIndex) {
  const colors = [
    0x4285F4,  // Blue - Initial query
    0xEA4335,  // Red - First expand
    0xFBBC05,  // Yellow - Second expand
    0x34A853,  // Green - Third expand
    0x9C27B0,  // Purple - Fourth expand
    0xFF5722   // Orange - Fifth expand
  ];
  return colors[sourceQueryIndex % colors.length];
}

// In your Three.js rendering
results.forEach(result => {
  const material = new THREE.MeshBasicMaterial({
    color: getColorForQueryIndex(result.sourceQueryIndex)
  });
  // ... create mesh
});
```

### Handling Session Expiry

```javascript
async function expandWithRetry(sessionId, queries) {
  try {
    const response = await fetch('/api/search-quotes-3d/expand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, queries })
    });
    
    if (response.status === 404) {
      // Session expired - offer to start fresh
      const shouldRestart = await showConfirm(
        'Your session has expired. Start a new exploration?'
      );
      
      if (shouldRestart) {
        // Re-run initial query
        return await startExploration(queries[0].query);
      }
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error('Expand failed:', error);
    throw error;
  }
}
```

### Session State Management

```javascript
// React example with state
const [sessionId, setSessionId] = useState(null);
const [queries, setQueries] = useState([]);
const [results, setResults] = useState([]);

// Track queries for UI display
function addQuery(query) {
  setQueries(prev => [...prev, query]);
}

// Display query history
function QueryHistory({ queries }) {
  return (
    <div className="query-history">
      {queries.map((q, i) => (
        <span 
          key={i} 
          style={{ color: getColorForQueryIndex(i) }}
        >
          {q}
        </span>
      ))}
    </div>
  );
}
```

---

## Important Notes

### Coordinates Change on Expand

**Critical**: When you expand a session, **all coordinates are recalculated**. The UMAP projection considers all items together, so existing items will move to new positions.

```javascript
// WRONG - assuming old coordinates are still valid
const oldResults = [...currentResults];
const newResults = expandResponse.results.filter(r => r.sourceQueryIndex > 0);
renderGalaxyView([...oldResults, ...newResults]); // ❌ Old coordinates are stale!

// CORRECT - use the full response
renderGalaxyView(expandResponse.results); // ✅ All coordinates are fresh
```

### Deduplication Behavior

Items are deduplicated by `pineconeId` (their unique identifier in the vector database). If you search for two overlapping queries, common results will only appear once:

```javascript
// Query 1: "bitcoin" - finds clips A, B, C
// Query 2: "cryptocurrency" - finds clips B, C, D

// Session will contain: A, B, C, D (not A, B, C, B, C, D)
// duplicatesSkipped: 2 (B and C from query 2)
```

### Session Capacity

Sessions have a hard cap (default 100 items). Plan your limits accordingly:

```javascript
// Bad: 5 queries × 25 limit = 125 items (will hit cap)
const queries = [
  { query: "topic1", limit: 25 },
  { query: "topic2", limit: 25 },
  { query: "topic3", limit: 25 },
  { query: "topic4", limit: 25 },
  { query: "topic5", limit: 25 }
];

// Good: Distribute within cap
const queries = [
  { query: "topic1", limit: 20 },
  { query: "topic2", limit: 20 },
  { query: "topic3", limit: 20 },
  { query: "topic4", limit: 20 },
  { query: "topic5", limit: 20 }
]; // Total: 100 items max
```

---

## Performance

### Expected Latency

| Operation | Items | Expected Time |
|-----------|-------|---------------|
| Initial search + session | 25 | 3-5s |
| Expand (2 queries, 20 each) | +40 | 4-6s |
| Expand (1 query, 10) | +10 | 2-3s |

**Note**: UMAP time scales with total items, not just new items.

### Optimization Tips

1. **Use fast mode** for exploratory sessions
2. **Batch queries** - one expand with 3 queries is faster than 3 separate expands
3. **Keep limits reasonable** - 15-25 per query is a good balance
4. **Skip axis labels** during rapid iteration, enable for final view

---

## Changelog

### Version 1.0.0 (January 2026)
- Initial implementation
- Session creation via `createSession` parameter
- Expand endpoint with multi-query support
- In-memory caching with circular buffer eviction
- Configurable TTL and capacity limits
- `sourceQueryIndex` tracking for query attribution
