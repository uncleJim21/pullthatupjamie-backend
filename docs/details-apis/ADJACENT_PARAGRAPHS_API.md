# Adjacent Paragraphs API

## Overview
The Adjacent Paragraphs API fetches a range of paragraphs surrounding a given paragraph ID from Pinecone. This is useful for providing context around a specific paragraph by retrieving the paragraphs that come before and after it in sequence.

## Endpoint
```
GET /api/fetch-adjacent-paragraphs
```

## Authentication
No authentication required.

## Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `paragraphId` | string | Yes | - | The paragraph ID in format `{guid}_p{number}` (e.g., `0012a7a4-bc1c-11ef-a566-bf3ecfcd8d34_p24`) |
| `adjacentSteps` | integer | No | 3 | Number of paragraphs to fetch before and after the target paragraph |

## How It Works

1. **Parse Paragraph ID**: Extracts the base GUID and paragraph number from the provided ID
   - Example: `0012a7a4-bc1c-11ef-a566-bf3ecfcd8d34_p24` → base: `0012a7a4-bc1c-11ef-a566-bf3ecfcd8d34`, number: `24`

2. **Calculate Range**: Determines the range of paragraph numbers to fetch
   - With `adjacentSteps=3` and paragraph `p24`, fetches `p21` through `p27`
   - Formula: `[paragraphNum - adjacentSteps, paragraphNum + adjacentSteps]`
   - Note: Negative paragraph numbers are prevented (minimum is 0)

3. **Batch Fetch**: Retrieves all paragraphs in the range from Pinecone in a single batch operation

4. **Order & Return**: Returns paragraphs in sequential order with metadata about which IDs were found or missing

## Request Example

```bash
curl -X GET "http://localhost:4132/api/fetch-adjacent-paragraphs?paragraphId=0012a7a4-bc1c-11ef-a566-bf3ecfcd8d34_p24&adjacentSteps=3"
```

## Response Format

```json
{
  "requestedId": "0012a7a4-bc1c-11ef-a566-bf3ecfcd8d34_p24",
  "adjacentSteps": 3,
  "range": {
    "start": 21,
    "end": 27
  },
  "paragraphs": [
    {
      "id": "0012a7a4-bc1c-11ef-a566-bf3ecfcd8d34_p21",
      "metadata": {
        "audioUrl": "https://...",
        "creator": "Modern Wisdom",
        "end_time": 738.2,
        "episode": "#974 - Joe Folley - Existential Philosophy...",
        "episodeImage": "https://...",
        "feedId": 229239,
        "guid": "0012a7a4-bc1c-11ef-a566-bf3ecfcd8d34",
        "listenLink": "",
        "num_words": 79,
        "sequence": 21,
        "start_time": 708.7,
        "text": "Good to keep everybody alive...",
        "type": "paragraph"
      },
      "text": "Good to keep everybody alive...",
      "start_time": 708.7,
      "end_time": 738.2,
      "episode": "#974 - Joe Folley - Existential Philosophy...",
      "creator": "Modern Wisdom"
    }
    // ... more paragraphs
  ],
  "found": 7,
  "missing": [],
  "totalRequested": 7
}
```

## Response Fields

### Top-Level Fields
- `requestedId` (string): The original paragraph ID that was requested
- `adjacentSteps` (integer): The number of steps used in the query
- `range` (object): The paragraph number range that was searched
  - `start` (integer): Starting paragraph number
  - `end` (integer): Ending paragraph number
- `paragraphs` (array): Array of paragraph objects in sequential order
- `found` (integer): Number of paragraphs successfully retrieved
- `missing` (array): Array of paragraph IDs that were not found in Pinecone
- `totalRequested` (integer): Total number of paragraph IDs that were requested

### Paragraph Object Fields
Each paragraph in the `paragraphs` array contains:
- `id` (string): Full paragraph ID
- `metadata` (object): Complete metadata from Pinecone including:
  - `audioUrl`: CDN URL for the audio file
  - `creator`: Podcast creator/host name
  - `start_time`: Start timestamp in seconds
  - `end_time`: End timestamp in seconds
  - `episode`: Episode title
  - `episodeImage`: URL to episode artwork
  - `feedId`: Numeric feed identifier
  - `guid`: Episode GUID
  - `listenLink`: Original podcast link
  - `num_words`: Word count in paragraph
  - `sequence`: Paragraph sequence number
  - `text`: Full text content
  - `type`: Always "paragraph"
- `text`: Text content (duplicated for convenience)
- `start_time`: Start timestamp (duplicated for convenience)
- `end_time`: End timestamp (duplicated for convenience)
- `episode`: Episode title (duplicated for convenience)
- `creator`: Creator name (duplicated for convenience)

## Error Responses

### 400 Bad Request - Missing Parameter
```json
{
  "error": "Missing required parameter: paragraphId",
  "example": "/api/fetch-adjacent-paragraphs?paragraphId=0012a7a4-bc1c-11ef-a566-bf3ecfcd8d34_p24&adjacentSteps=3"
}
```

### 400 Bad Request - Invalid Adjacent Steps
```json
{
  "error": "adjacentSteps must be a non-negative number",
  "provided": "-5"
}
```

### 400 Bad Request - Invalid Format
```json
{
  "error": "Invalid paragraph ID format. Expected format: {guid}_p{number}",
  "example": "0012a7a4-bc1c-11ef-a566-bf3ecfcd8d34_p24",
  "provided": "invalid-id"
}
```

### 400 Bad Request - Invalid Paragraph Number
```json
{
  "error": "Invalid paragraph number. Must be a number after _p",
  "provided": "abc"
}
```

### 500 Internal Server Error
```json
{
  "error": "Failed to fetch adjacent paragraphs",
  "details": "Error message details"
}
```

## Use Cases

1. **Contextual Reading**: Display surrounding context when a user clicks on a specific paragraph from search results

2. **Continuous Playback**: Fetch adjacent paragraphs to enable seamless audio playback across multiple segments

3. **Quote Verification**: Retrieve surrounding text to verify quotes in their full context

4. **Transcript Navigation**: Allow users to navigate forward/backward through a transcript

## Performance Notes

- Uses Pinecone's batch fetch API for efficient retrieval of multiple paragraphs
- Single API call retrieves all requested paragraphs simultaneously
- Typical response time: 1-2 seconds depending on network and Pinecone latency

## Edge Cases

1. **Paragraph at Beginning**: If `paragraphId` is `p2` with `adjacentSteps=3`, the range starts at `p0` (not negative)

2. **Missing Paragraphs**: Some paragraph numbers in the range may not exist (e.g., gaps in ingestion). These are listed in the `missing` array.

3. **End of Episode**: If requesting paragraphs beyond the last paragraph, those IDs will be in the `missing` array.

## Examples

### Fetch with Default Steps (3)
```bash
curl "http://localhost:4132/api/fetch-adjacent-paragraphs?paragraphId=guid123_p50"
# Returns paragraphs p47 through p53
```

### Fetch with Custom Steps (5)
```bash
curl "http://localhost:4132/api/fetch-adjacent-paragraphs?paragraphId=guid123_p50&adjacentSteps=5"
# Returns paragraphs p45 through p55
```

### Fetch Only the Requested Paragraph (0 steps)
```bash
curl "http://localhost:4132/api/fetch-adjacent-paragraphs?paragraphId=guid123_p50&adjacentSteps=0"
# Returns only p50
```

