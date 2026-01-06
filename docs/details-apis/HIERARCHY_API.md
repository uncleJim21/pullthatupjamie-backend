# Hierarchy API

## Overview
The Hierarchy API retrieves the complete hierarchical context for a given paragraph, including its parent chapter, episode, and feed (podcast) information. This provides a full "breadcrumb trail" from the paragraph up to the podcast level.

## Endpoint
```
GET /api/get-hierarchy
```

## Authentication
No authentication required.

## Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `paragraphId` | string | Yes | - | The paragraph ID in format `{guid}_p{number}` (e.g., `https___lexfridman_com__p_6320_p715`) |

## How It Works

1. **Fetch Paragraph**: Retrieves the paragraph data from Pinecone by ID

2. **Extract Metadata**: Extracts the `guid`, `feedId`, and timestamps from the paragraph

3. **Find Chapter**: Queries Pinecone for chapters matching:
   - Type: `chapter`
   - GUID: Same as paragraph
   - Timestamp range: Chapter's `startTime` ≤ paragraph's `start_time` ≤ Chapter's `endTime`
   - Takes the first match

4. **Fetch Episode**: Constructs episode ID as `episode_{guid}` and fetches from Pinecone

5. **Fetch Feed**: Constructs feed ID as `feed_{feedId}` and fetches from Pinecone

6. **Build Path**: Creates a human-readable hierarchical path string

## Request Example

```bash
curl -X GET "http://localhost:4132/api/get-hierarchy?paragraphId=https___lexfridman_com__p_6320_p715"
```

## Response Format

```json
{
  "paragraphId": "https___lexfridman_com__p_6320_p715",
  "hierarchy": {
    "paragraph": {
      "id": "https___lexfridman_com__p_6320_p715",
      "metadata": {
        "audioUrl": "https://cascdr-chads-stay-winning.nyc3.cdn.digitaloceanspaces.com/745287/httpslexfridmancomp6320.mp3",
        "creator": "Lex Fridman Podcast",
        "end_time": 15686.3545,
        "episode": "#481 – Norman Ohler: Hitler, Nazis, Drugs, WW2, Blitzkrieg, LSD, MKUltra & CIA",
        "episodeImage": "https://lexfridman.com/wordpress/wp-content/uploads/powerpress/artwork_3000-230.png",
        "feedId": 745287,
        "guid": "https___lexfridman_com__p_6320",
        "listenLink": "https://lexfridman.com/norman-ohler/?utm_source=rss&utm_medium=rss&utm_campaign=norman-ohler",
        "num_words": 56,
        "publishedDate": "2025-09-19T18:34:47.000Z",
        "publishedMonth": 9,
        "publishedTimestamp": 1758306887000,
        "publishedYear": 2025,
        "sequence": 715,
        "start_time": 15670.5205,
        "text": "Peterson talked about this, that every sentence in Nietzsche is, like, chiseled...",
        "type": "paragraph"
      }
    },
    "chapter": {
      "id": "https___lexfridman_com__p_6320_chunked_chapter_22",
      "metadata": {
        "chapterNumber": 22,
        "chunkCount": 18,
        "duration": 685.9210000000003,
        "endTime": 16202.346,
        "episodeTitle": "#481 – Norman Ohler: Hitler, Nazis, Drugs, WW2, Blitzkrieg, LSD, MKUltra & CIA",
        "feedId": 745287,
        "feedTitle": "Lex Fridman Podcast",
        "guid": "https___lexfridman_com__p_6320",
        "headline": "Literature, Philosophy, and Personal Experiences",
        "keywords": ["literature", "Nietzsche", "LSD", "Ulysses", "The Stranger"],
        "model": "gpt-4o-mini",
        "paragraphCount": 33,
        "processingMethod": "chunked",
        "startTime": 15516.425,
        "summary": "Literature, Philosophy, and Personal Experiences: Norman Ohler discusses...",
        "timestamp": "2025-09-19T21:20:26.094Z",
        "totalChapterCount": 22,
        "type": "chapter",
        "wordCount": 1950
      }
    },
    "episode": {
      "id": "episode_https___lexfridman_com__p_6320",
      "metadata": {
        "audioUrl": "https://cascdr-chads-stay-winning.nyc3.cdn.digitaloceanspaces.com/745287/httpslexfridmancomp6320.mp3",
        "creator": "Lex Fridman",
        "description": "Norman Ohler is a historian and author of \"Blitzed: Drugs in the Third Reich\"...",
        "duration": 16281,
        "episodeNumber": "",
        "feedId": "745287",
        "guests": ["Norman Ohler", "Ohler", "Norman", "Historian", "Author", "Blitzed", "Tripped"],
        "guid": "https___lexfridman_com__p_6320",
        "imageUrl": "https://lexfridman.com/wordpress/wp-content/uploads/powerpress/artwork_3000-230.png",
        "publishedDate": "2025-09-19T18:34:47.000Z",
        "publishedMonth": 9,
        "publishedTimestamp": 1758306887000,
        "publishedYear": 2025,
        "title": "#481 – Norman Ohler: Hitler, Nazis, Drugs, WW2, Blitzkrieg, LSD, MKUltra & CIA",
        "type": "episode"
      }
    },
    "feed": {
      "id": "feed_745287",
      "metadata": {
        "author": "Lex Fridman",
        "description": "Conversations about science, technology, history, philosophy and the nature of intelligence...",
        "episodeCount": 486,
        "explicit": false,
        "feedId": "745287",
        "feedUrl": "https://lexfridman.com/feed/podcast/",
        "imageUrl": "https://lexfridman.com/wordpress/wp-content/uploads/powerpress/artwork_3000-230.png",
        "language": "en-US",
        "lastUpdateTime": 1764026807,
        "podcastGuid": "7eeae9d1-141e-5133-9e8f-6c1da695e40c",
        "title": "Lex Fridman Podcast",
        "type": "feed"
      }
    }
  },
  "path": "Lex Fridman Podcast > #481 – Norman Ohler: Hitler, Nazis, Drugs, WW2, Blitzkrieg, LSD, MKUltra & CIA > Chapter 22: Literature, Philosophy, and Personal Experiences"
}
```

## Response Fields

### Top-Level Fields
- `paragraphId` (string): The paragraph ID that was queried
- `hierarchy` (object): Contains the full hierarchy from paragraph to feed
- `path` (string): Human-readable breadcrumb path through the hierarchy

### Hierarchy Object

#### Paragraph
Complete paragraph data including:
- `id`: Paragraph ID
- `metadata`: Full Pinecone metadata
  - `text`: The paragraph text content
  - `start_time` / `end_time`: Timestamp range in seconds
  - `episode`: Episode title
  - `creator`: Podcast creator
  - `guid`: Episode GUID
  - `feedId`: Numeric feed identifier
  - `sequence`: Paragraph sequence number
  - `audioUrl`: Audio file URL
  - `episodeImage`: Episode artwork URL
  - `publishedDate` / `publishedTimestamp`: Publication time
  - Additional metadata fields

#### Chapter (nullable)
Complete chapter data including:
- `id`: Chapter ID (format: `{guid}_chunked_chapter_{chapterNumber}`)
- `metadata`: Chapter metadata
  - `chapterNumber`: Chapter index
  - `headline`: Chapter title/headline
  - `summary`: AI-generated chapter summary
  - `startTime` / `endTime`: Chapter timestamp range
  - `duration`: Chapter duration in seconds
  - `keywords`: Array of topic keywords
  - `paragraphCount`: Number of paragraphs in chapter
  - `wordCount`: Total word count
  - `totalChapterCount`: Total chapters in episode
  - `model`: AI model used for summarization (e.g., "gpt-4o-mini")
  - `processingMethod`: How chapter was generated (e.g., "chunked")

**Note**: Chapter may be `null` if:
- The episode doesn't have chapters
- The paragraph is outside all chapter ranges
- Chapter data hasn't been ingested yet

#### Episode (nullable)
Complete episode data including:
- `id`: Episode ID (format: `episode_{guid}`)
- `metadata`: Episode metadata
  - `title`: Episode title
  - `description`: Full episode description
  - `creator`: Podcast creator/host
  - `duration`: Episode duration in seconds
  - `audioUrl`: Audio file URL
  - `imageUrl`: Episode artwork
  - `publishedDate` / `publishedTimestamp`: Publication time
  - `guests`: Array of guest names
  - `episodeNumber`: Episode number (if available)
  - `guid`: Episode GUID

#### Feed (nullable)
Complete podcast feed data including:
- `id`: Feed ID (format: `feed_{feedId}`)
- `metadata`: Feed metadata
  - `title`: Podcast title
  - `author`: Podcast author/creator
  - `description`: Podcast description
  - `feedUrl`: RSS feed URL
  - `imageUrl`: Podcast artwork
  - `podcastGuid`: Podcast GUID (from podcast namespace)
  - `episodeCount`: Total number of episodes
  - `language`: Podcast language code (e.g., "en-US")
  - `explicit`: Whether podcast is marked explicit
  - `lastUpdateTime`: Last feed update timestamp

### Path String Format
The `path` field provides a human-readable hierarchical path:
```
{Feed Title} > {Episode Title} > Chapter {N}: {Chapter Headline}
```

If any level is missing, it's omitted from the path.

## Error Responses

### 400 Bad Request - Missing Parameter
```json
{
  "error": "Missing required parameter: paragraphId",
  "example": "/api/get-hierarchy?paragraphId=https___lexfridman_com__p_6320_p715"
}
```

### 404 Not Found - Paragraph Not Found
```json
{
  "error": "Paragraph not found",
  "paragraphId": "invalid_id_p999"
}
```

### 400 Bad Request - Missing Metadata
```json
{
  "error": "Paragraph missing required metadata (guid or feedId)",
  "paragraphId": "some_id_p123",
  "metadata": { /* partial metadata */ }
}
```

### 500 Internal Server Error
```json
{
  "error": "Failed to fetch hierarchy",
  "details": "Error message details"
}
```

## Use Cases

1. **Breadcrumb Navigation**: Display where a paragraph sits within the podcast structure

2. **Context Display**: Show users the chapter and episode context when viewing search results

3. **Smart Navigation**: Enable "jump to chapter" or "view full episode" features

4. **Metadata Enrichment**: Enrich paragraph data with full episode and podcast information

5. **Analytics**: Track which podcasts, episodes, and chapters are most accessed

## Chapter Detection Strategy

The API uses **timestamp-based matching** to find the correct chapter:

1. Queries Pinecone for chapters with matching `guid` and `type: "chapter"`
2. Filters by timestamp: `chapter.startTime ≤ paragraph.start_time ≤ chapter.endTime`
3. Takes the first matching result
4. Returns `null` if no chapter matches

### Why This Works
- Chapters have defined `startTime` and `endTime` boundaries
- Paragraphs fall within these boundaries based on their `start_time`
- Pinecone efficiently handles numeric range queries

### Edge Cases
- **No chapters**: Some podcasts don't have AI-generated chapters → `chapter: null`
- **Paragraph at boundary**: Slight overlap is handled by the `≤` comparison
- **Multiple matches**: First match is used (rare, indicates data issue)

## Performance Notes

- Makes 4 API calls to Pinecone:
  1. Fetch paragraph by ID
  2. Query chapter by timestamp filter
  3. Fetch episode by ID
  4. Fetch feed by ID
- Typical response time: 1-3 seconds
- Consider caching results for frequently accessed paragraphs

## Examples

### Basic Hierarchy Query
```bash
curl "http://localhost:4132/api/get-hierarchy?paragraphId=https___lexfridman_com__p_6320_p715"
```

### Paragraph Without Chapter
If a podcast doesn't have chapters:
```json
{
  "paragraphId": "some_guid_p50",
  "hierarchy": {
    "paragraph": { /* data */ },
    "chapter": null,
    "episode": { /* data */ },
    "feed": { /* data */ }
  },
  "path": "Podcast Name > Episode Title"
}
```

### Missing Episode or Feed
Gracefully handles missing data:
```json
{
  "paragraphId": "some_guid_p50",
  "hierarchy": {
    "paragraph": { /* data */ },
    "chapter": null,
    "episode": null,
    "feed": null
  },
  "path": "Unknown"
}
```

## Integration Examples

### Display Breadcrumb UI
```javascript
fetch('/api/get-hierarchy?paragraphId=' + paragraphId)
  .then(res => res.json())
  .then(data => {
    document.getElementById('breadcrumb').textContent = data.path;
  });
```

### Build Chapter Navigation
```javascript
const hierarchy = await fetch('/api/get-hierarchy?paragraphId=' + id).then(r => r.json());
if (hierarchy.hierarchy.chapter) {
  const chapter = hierarchy.hierarchy.chapter.metadata;
  console.log(`Chapter ${chapter.chapterNumber}: ${chapter.headline}`);
  console.log(`Duration: ${chapter.duration}s`);
  console.log(`Keywords: ${chapter.keywords.join(', ')}`);
}
```

### Show Podcast Information
```javascript
const hierarchy = await fetch('/api/get-hierarchy?paragraphId=' + id).then(r => r.json());
if (hierarchy.hierarchy.feed) {
  const feed = hierarchy.hierarchy.feed.metadata;
  console.log(`Podcast: ${feed.title} by ${feed.author}`);
  console.log(`Total episodes: ${feed.episodeCount}`);
}
```

