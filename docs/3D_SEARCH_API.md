# 3D Semantic Search API Documentation

**Version**: 1.0.0  
**Endpoint**: `POST /api/search-quotes-3d`  
**Status**: Beta

---

## Overview

The 3D Semantic Search endpoint extends the standard podcast search functionality with three-dimensional spatial coordinates for galaxy view visualization. Results are projected into 3D space using UMAP (Uniform Manifold Approximation and Projection), where proximity in space indicates semantic similarity.

**Key Features:**
- Returns all standard search results plus 3D coordinates (x, y, z)
- Coordinates normalized to [-1, 1] range for easy rendering
- Includes hierarchy level for color-coding (paragraph, chapter, episode, feed)
- Supports all existing search filters (feeds, dates, episode name)
- Optional fast mode for reduced latency
- Deterministic results (same query always returns same coordinates)

---

## Authentication

**Current Status**: No authentication required (public endpoint)

**Planned**: IP-based rate limiting before production release
- Standard mode: 10 requests/minute per IP
- Fast mode: 15 requests/minute per IP

---

## Request

### Endpoint
```
POST /api/search-quotes-3d
```

### Headers
```
Content-Type: application/json
```

### Request Body

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | **Yes** | - | Search query text |
| `limit` | integer | No | 100 | Max results to return (1-200) |
| `feedIds` | array[string] | No | [] | Filter by podcast feed IDs |
| `minDate` | string | No | null | Minimum publication date (ISO 8601) |
| `maxDate` | string | No | null | Maximum publication date (ISO 8601) |
| `episodeName` | string | No | null | Exact episode name match |
| `fastMode` | boolean | No | false | Enable fast mode (lower quality, faster) |

### Example Request

```json
{
  "query": "artificial intelligence and machine learning",
  "limit": 100,
  "feedIds": ["1", "42"],
  "minDate": "2024-01-01",
  "maxDate": "2024-12-31",
  "fastMode": false
}
```

### cURL Example

```bash
curl -X POST http://localhost:4132/api/search-quotes-3d \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Bitcoin mining",
    "limit": 50,
    "fastMode": true
  }'
```

---

## Response

### Success Response (200 OK)

```json
{
  "query": "artificial intelligence",
  "results": [
    {
      "shareLink": "https___example_com_episode_123_p45",
      "shareUrl": "http://localhost:3001/share?clip=https___example_com_episode_123_p45",
      "quote": "The advancement of artificial intelligence has...",
      "episode": "AI and the Future",
      "creator": "Tech Podcast",
      "audioUrl": "https://example.com/audio.mp3",
      "episodeImage": "https://example.com/image.jpg",
      "date": "2024-03-15",
      "listenLink": "https://example.com/listen",
      "similarity": {
        "combined": 0.8923,
        "vector": 0.8923
      },
      "timeContext": {
        "start_time": 1234.5,
        "end_time": 1267.8
      },
      "additionalFields": {
        "feedId": "1",
        "guid": "episode-123-guid",
        "sequence": 45,
        "num_words": 42
      },
      "coordinates3d": {
        "x": 0.234,
        "y": -0.456,
        "z": 0.123
      },
      "hierarchyLevel": "paragraph"
    }
    // ... more results
  ],
  "total": 100,
  "model": "text-embedding-ada-002",
  "metadata": {
    "numResults": 100,
    "embeddingTimeMs": 87,
    "searchTimeMs": 423,
    "umapTimeMs": 1234,
    "totalTimeMs": 1744,
    "fastMode": false,
    "umapConfig": "standard"
  }
}
```

### Response Fields

#### Result Object

All fields from standard `/api/search-quotes` endpoint, plus:

| Field | Type | Description |
|-------|------|-------------|
| `coordinates3d` | object | 3D spatial coordinates |
| `coordinates3d.x` | number | X coordinate, range [-1, 1] |
| `coordinates3d.y` | number | Y coordinate, range [-1, 1] |
| `coordinates3d.z` | number | Z coordinate, range [-1, 1] |
| `hierarchyLevel` | string | Entity type: "paragraph", "chapter", "episode", or "feed" |

#### Metadata Object

| Field | Type | Description |
|-------|------|-------------|
| `numResults` | integer | Number of results returned |
| `embeddingTimeMs` | integer | Time to generate query embedding (ms) |
| `searchTimeMs` | integer | Time to search Pinecone (ms) |
| `umapTimeMs` | integer | Time for UMAP projection (ms) |
| `totalTimeMs` | integer | Total request time (ms) |
| `fastMode` | boolean | Whether fast mode was used |
| `umapConfig` | string | UMAP configuration: "standard" or "fast" |

---

## Error Responses

### 400 Bad Request - Missing Query

```json
{
  "error": "Query is required"
}
```

### 400 Bad Request - Insufficient Results

```json
{
  "error": "Insufficient results for 3D visualization",
  "message": "UMAP requires at least 4 results for 3D projection. Found: 2",
  "suggestion": "Try broadening your search query or removing filters",
  "resultCount": 2
}
```

**Why this happens**: UMAP dimensionality reduction requires a minimum of 4 data points. This typically occurs when:
- Very specific search query with few matches
- Highly restrictive filters (date range, specific podcast, episode name)
- Combination of narrow query + filters

**Solutions**:
- Broaden the search query
- Remove or relax date filters
- Remove episode name filter
- Increase the search to include more podcasts

### 500 Internal Server Error - UMAP Failure

```json
{
  "error": "Failed to generate 3D projection",
  "message": "The dimensionality reduction algorithm encountered an error. Please try again.",
  "details": "UMAP projection failed: convergence error",
  "requestId": "SEARCH-3D-1234567890-abc123"
}
```

### 500 Internal Server Error - General Failure

```json
{
  "error": "Failed to perform 3D search",
  "message": "An unexpected error occurred. Please try again.",
  "details": "Connection timeout to Pinecone",
  "requestId": "SEARCH-3D-1234567890-abc123"
}
```

---

## Performance

### Expected Latency

| Configuration | Expected Time | Notes |
|--------------|---------------|-------|
| Standard mode, 50 results | 1.0-1.5s | Recommended for most use cases |
| Standard mode, 100 results | 1.5-2.0s | Default configuration |
| Standard mode, 200 results | 2.5-3.5s | Maximum limit |
| Fast mode, 50 results | 0.7-1.0s | Reduced quality |
| Fast mode, 100 results | 1.0-1.5s | Acceptable trade-off |

**Latency Breakdown** (100 results, standard mode):
- Query embedding: ~50-100ms
- Pinecone search: ~200-400ms (slightly slower with `includeValues: true`)
- UMAP projection: ~800-1500ms (bulk of the time)
- Response building: ~50-100ms

### Performance Optimization

1. **Use Fast Mode**: Set `fastMode: true` for ~30% faster UMAP at slight quality cost
2. **Limit Results**: Fewer results = faster UMAP (linear relationship)
3. **Cache Results**: Client-side caching recommended (same query = same coordinates)

---

## Fast Mode

Fast mode uses optimized UMAP parameters for reduced latency:

| Parameter | Standard | Fast |
|-----------|----------|------|
| nNeighbors | 15 | 8 |
| minDist | 0.1 | 0.05 |
| Quality | Higher | Lower |
| Speed | Slower | ~30% faster |

**When to use fast mode:**
- Real-time exploration/interaction
- Less critical visualization quality
- Mobile/bandwidth-constrained environments

**When to use standard mode:**
- Final presentation/screenshots
- Analysis requiring precise spatial relationships
- First impression (better quality)

---

## Best Practices

### 1. Handle Insufficient Results

Always be prepared to handle 400 errors when result count < 4:

```javascript
try {
  const response = await fetch('/api/search-quotes-3d', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: 100 })
  });
  
  if (response.status === 400) {
    // Fall back to regular list view
    return fetchRegularSearch(query);
  }
  
  const data = await response.json();
  renderGalaxyView(data.results);
} catch (error) {
  console.error('3D search failed:', error);
  // Fall back to regular list view
}
```

### 2. Show Loading States

3D search takes 1-2 seconds. Show appropriate loading UI:

```javascript
setLoading(true);
setLoadingMessage('Searching and projecting results to 3D space...');

const response = await fetch3DSearch(query);

setLoading(false);
renderGalaxyView(response.results);
```

### 3. Cache Results

Same query always returns same coordinates (deterministic UMAP seed):

```javascript
const cacheKey = `3d-search:${query}:${JSON.stringify(filters)}`;
const cached = localStorage.getItem(cacheKey);

if (cached) {
  return JSON.parse(cached);
}

const response = await fetch3DSearch(query);
localStorage.setItem(cacheKey, JSON.stringify(response));
return response;
```

### 4. Coordinate Validation

Always validate coordinates before rendering:

```javascript
function isValidCoordinate(coord) {
  return coord && 
         typeof coord.x === 'number' && 
         typeof coord.y === 'number' && 
         typeof coord.z === 'number' &&
         coord.x >= -1 && coord.x <= 1 &&
         coord.y >= -1 && coord.y <= 1 &&
         coord.z >= -1 && coord.z <= 1;
}

results.forEach(result => {
  if (!isValidCoordinate(result.coordinates3d)) {
    console.error('Invalid coordinates:', result.shareLink);
  }
});
```

### 5. Use Appropriate Limits

```javascript
// Mobile: Lower limit for faster load
const limit = isMobile ? 50 : 100;

// Exploration: Standard limit
const limit = 100;

// Analysis: Higher limit (but slower)
const limit = 200;
```

---

## Visualization Guidelines

### Rendering 3D Coordinates

Coordinates are normalized to [-1, 1] on all axes for easy Three.js rendering:

```javascript
import * as THREE from 'three';

// Create geometry for each result
results.forEach(result => {
  const geometry = new THREE.SphereGeometry(0.02);
  const material = new THREE.MeshBasicMaterial({ 
    color: getColorForHierarchy(result.hierarchyLevel)
  });
  const sphere = new THREE.Mesh(geometry, material);
  
  // Coordinates are already in [-1, 1] range, scale as needed
  sphere.position.set(
    result.coordinates3d.x * scale,
    result.coordinates3d.y * scale,
    result.coordinates3d.z * scale
  );
  
  scene.add(sphere);
});
```

### Color Coding by Hierarchy

Recommended color scheme:

```javascript
function getColorForHierarchy(level) {
  const colors = {
    'feed': 0xFF0000,      // Red
    'episode': 0x00FF00,   // Green
    'chapter': 0x0000FF,   // Blue
    'paragraph': 0xFFFFFF  // White (default)
  };
  return colors[level] || 0xFFFFFF;
}
```

### Interpreting Spatial Relationships

- **Close points**: Semantically similar content
- **Distant points**: Semantically different content
- **Clusters**: Topics or themes
- **Outliers**: Unique or tangential content

---

## Comparison with Regular Search

| Feature | `/api/search-quotes` | `/api/search-quotes-3d` |
|---------|---------------------|------------------------|
| Returns results | ✅ | ✅ |
| Semantic similarity | ✅ | ✅ |
| Filters (date, feed, etc.) | ✅ | ✅ |
| 3D coordinates | ❌ | ✅ |
| Hierarchy level | ❌ | ✅ |
| Latency | ~300-500ms | ~1500-2000ms |
| Use case | List view, quick search | Galaxy view, exploration |

---

## Troubleshooting

### Problem: Always getting "Insufficient results" error

**Cause**: Query + filters too restrictive, returning <4 results

**Solutions**:
1. Remove filters and try again
2. Broaden the query (remove specific terms)
3. Check if the podcast actually has content matching your query
4. Fall back to regular `/api/search-quotes` endpoint

### Problem: UMAP projection is slow (>3 seconds)

**Cause**: High result count or slow hardware

**Solutions**:
1. Enable `fastMode: true`
2. Reduce `limit` to 50 or less
3. Check server CPU usage (UMAP is CPU-intensive)
4. Consider horizontal scaling if traffic is high

### Problem: Coordinates seem clustered (all in same area)

**Cause**: Results are semantically very similar

**Expected behavior**: This is correct! If all results are about the same narrow topic, they should cluster.

**If unexpected**:
1. Check the search query (is it too broad?)
2. Verify result diversity in the list view
3. Check UMAP logs for warnings about degenerate distributions

### Problem: Same query returns slightly different coordinates

**Cause**: UMAP random seed not properly set

**Solutions**:
1. Set `UMAP_RANDOM_SEED` environment variable
2. Verify seed is being used in `UmapProjector.js`
3. Check for client-side cache misses

---

## Migration from Regular Search

### Step 1: Add fallback logic

```javascript
async function searchWithFallback(query, options) {
  try {
    const response = await fetch('/api/search-quotes-3d', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, ...options })
    });
    
    if (response.status === 400) {
      // Fall back to regular search
      return await fetchRegularSearch(query, options);
    }
    
    return await response.json();
  } catch (error) {
    // Fall back to regular search on any error
    return await fetchRegularSearch(query, options);
  }
}
```

### Step 2: Update UI to show loading

```javascript
setLoading(true);
setView('galaxy'); // Show 3D view loading state

const results = await searchWithFallback(query, { limit: 100 });

if (results.results[0].coordinates3d) {
  renderGalaxyView(results);
} else {
  renderListView(results);
}

setLoading(false);
```

### Step 3: Add toggle between views

```javascript
const [viewMode, setViewMode] = useState('list'); // or 'galaxy'

// Fetch appropriate data
const results = viewMode === 'galaxy' 
  ? await fetch3DSearch(query)
  : await fetchRegularSearch(query);

// Render appropriate view
{viewMode === 'galaxy' ? (
  <GalaxyView results={results.results} />
) : (
  <ListView results={results.results} />
)}
```

---

## Rate Limiting (Planned)

**Status**: Not yet implemented (see Pre-Release Checklist)

**Planned limits**:
- 10 requests/minute per IP (standard mode)
- 15 requests/minute per IP (fast mode)
- 429 response when limit exceeded

**Response when rate limited**:
```json
{
  "error": "Rate limit exceeded",
  "message": "Too many requests. Please try again in 60 seconds.",
  "retryAfter": 60
}
```

---

## Testing

### Manual Testing

```bash
# Run the test script
node test/test-3d-search.js

# Test specific query
curl -X POST http://localhost:4132/api/search-quotes-3d \
  -H "Content-Type: application/json" \
  -d '{"query": "Bitcoin", "limit": 50}'
```

### Integration Testing

The test suite includes:
- Standard search (100 results)
- Fast mode (50 results)
- Small result set (10 results)
- With filters (feed + date)
- Insufficient results case (<4 results)

Run with: `./test/test-3d-search.js`

---

## Support

**Issues**: Report issues via GitHub or internal issue tracker

**Request ID**: Include the `requestId` from error responses when reporting issues

**Logs**: Server logs include detailed timing and debugging information

---

## Changelog

### Version 1.0.0 (2024)
- Initial implementation
- UMAP-based 3D projection
- Fast mode support
- Comprehensive error handling
- Deterministic results with seeded random

