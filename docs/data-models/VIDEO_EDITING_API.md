# Video Editing API Documentation

## Overview

The Video Editing API provides functionality to extract segments from uploaded video files, creating child edits with automatic parent-child relationship tracking. This system enables users to create short clips from longer video content while maintaining organizational structure through hierarchical directory layout.

## Features

- **Segment Extraction**: Extract video segments with precise start/end timestamps
- **Smart Range Extraction**: Automatic optimization for large files using HTTP range requests
- **Robust Memory Management**: Enterprise-grade memory monitoring and cleanup systems
- **Parent-Child Relationships**: Automatic tracking and organization of original files and their edits
- **Duration Validation**: Prevents invalid edit requests that exceed source file duration
- **Deduplication**: Deterministic hash system prevents duplicate processing
- **Status Tracking**: Real-time processing status with polling endpoints
- **Directory Organization**: Clean separation of parent files and child edits
- **Multi-Hour HD Support**: Optimized for large podcast files with minimal memory usage

## Architecture

### Directory Structure

```
jamie-pro/{feedId}/uploads/
├── original-video.mp4                    # Parent file (unchanged location)
└── original-video-children/              # Child edits directory
    ├── edit-{hash1}.mp4                   # 6s-8s clip
    ├── edit-{hash2}.mp4                   # 10s-15s clip
    └── edit-{hash3}.mp4                   # Other clips
```

### Database Schema

Video edits are tracked in the `WorkProductV2` collection with type `'video-edit'`:

```javascript
{
  type: 'video-edit',
  lookupHash: 'edit-{deterministic-hash}',
  status: 'completed|processing|queued|failed',
  cdnFileId: 'https://bucket.domain.com/path/to/edit.mp4',
  result: {
    originalUrl: 'https://bucket.domain.com/parent-file.mp4',
    parentFileName: 'parent-file.mp4',
    parentFileBase: 'parent-file',
    editStart: 6.0,
    editEnd: 14.0,
    editDuration: 8.0,
    sourceDuration: 120.5,        // Added during processing
    useSubtitles: false,
    processingStrategy: 'phase2-smart',  // Phase 2: smart extraction
    processingTimeMs: 15420,      // Processing time metrics
    memoryDeltaMB: 78,           // Memory usage delta
    strategy: 'range-extraction', // Actual strategy used
    feedId: '550168'
  }
}
```

## API Endpoints

### 1. Create Video Edit

**Endpoint**: `POST /api/edit-video`  
**Authentication**: Bearer token (podcast admin middleware)

Creates a new video edit by extracting a segment from an existing video file.

#### Request Body

```json
{
  "cdnUrl": "https://your-bucket.domain.com/jamie-pro/550168/uploads/video.mp4",
  "startTime": 8.0,
  "endTime": 14.0,
  "useSubtitles": true,
  "subtitles": [
    {
      "start": 8.0,
      "end": 10.5,
      "text": "Welcome back to the podcast everyone"
    },
    {
      "start": 10.5,
      "end": 14.0,
      "text": "Today we're diving deep into AI"
    }
  ]
}
```

#### Parameters

- `cdnUrl` (string, required): CDN URL of the source video file. Must be from your storage buckets.
- `startTime` (number, required): Start time in seconds (supports decimals to nearest 0.1s)
- `endTime` (number, required): End time in seconds (supports decimals to nearest 0.1s)
- `useSubtitles` (boolean, optional): Whether to include subtitles. Defaults to `false`.
- `subtitles` (array, optional): Client-provided subtitles array. If provided and `useSubtitles` is true, these will be used instead of auto-generation. Each subtitle object should have `start`, `end`, and `text` properties.

#### Response

```json
{
  "status": "processing",
  "lookupHash": "edit-894e79a94c30e332",
  "pollUrl": "/api/edit-status/edit-894e79a94c30e332"
}
```

#### Error Responses

```json
// Missing parameters
{
  "error": "cdnUrl is required"
}

// Invalid CDN URL
{
  "error": "CDN URL must be from our storage buckets"
}

// Invalid time range
{
  "error": "End time must be greater than start time"
}

// Duration too long
{
  "error": "Edit duration cannot exceed 10 minutes"
}
```

### 2. Check Edit Status

**Endpoint**: `GET /api/edit-status/{lookupHash}`  
**Authentication**: None required

Check the processing status of a video edit.

#### Response - Processing

```json
{
  "status": "processing",
  "lookupHash": "edit-894e79a94c30e332"
}
```

#### Response - Completed

```json
{
  "status": "completed",
  "url": "https://bucket.domain.com/jamie-pro/550168/uploads/parent-children/edit-894e79a94c30e332.mp4",
  "lookupHash": "edit-894e79a94c30e332"
}
```

#### Response - Failed

```json
{
  "status": "failed",
  "error": "End time (60s) exceeds video duration (45.2s)",
  "lookupHash": "edit-894e79a94c30e332"
}
```

### 3. Get Child Edits

**Endpoint**: `GET /api/edit-children/{parentFileName}`  
**Authentication**: Bearer token (podcast admin middleware)

Retrieve all child edits for a specific parent video file.

#### Example Request

```bash
GET /api/edit-children/1756256132270-two-plates-ai.mp4
```

#### Response

```json
{
  "parentFileName": "1756256132270-two-plates-ai.mp4",
  "parentFileBase": "1756256132270-two-plates-ai",
  "childCount": 2,
  "children": [
    {
      "lookupHash": "edit-0c45aa1394e193cd",
      "status": "completed",
      "url": "https://bucket.domain.com/jamie-pro/550168/uploads/1756256132270-two-plates-ai-children/edit-0c45aa1394e193cd.mp4",
      "editRange": "6s-8s",
      "duration": 2,
      "createdAt": "2025-01-21T10:30:00.000Z",
      "originalUrl": "https://bucket.domain.com/jamie-pro/550168/uploads/1756256132270-two-plates-ai.mp4"
    },
    {
      "lookupHash": "edit-4e2ec1e43b77228f",
      "status": "failed",
      "url": null,
      "editRange": "50s-60s",
      "duration": 10,
      "createdAt": "2025-01-21T10:35:00.000Z",
      "originalUrl": "https://bucket.domain.com/jamie-pro/550168/uploads/1756256132270-two-plates-ai.mp4"
    }
  ]
}
```

### 4. Enhanced List Uploads

**Endpoint**: `GET /api/list-uploads`  
**Authentication**: Bearer token (podcast admin middleware)

Enhanced to include parent-child relationship information.

#### Query Parameters

- `page` (number, optional): Page number for pagination. Defaults to 1.
- `includeChildren` (boolean, optional): Whether to include child edit information. Defaults to `true`.

#### Example Requests

```bash
# Include children (default)
GET /api/list-uploads?page=1

# Include children explicitly
GET /api/list-uploads?page=1&includeChildren=true

# Exclude children for faster response
GET /api/list-uploads?page=1&includeChildren=false
```

#### Response with Children

```json
{
  "uploads": [
    {
      "key": "jamie-pro/550168/uploads/video.mp4",
      "fileName": "video.mp4",
      "size": 1678143,
      "lastModified": "2025-01-21T10:00:00.000Z",
      "publicUrl": "https://bucket.domain.com/jamie-pro/550168/uploads/video.mp4",
      "children": [
        {
          "lookupHash": "edit-0c45aa1394e193cd",
          "status": "completed",
          "url": "https://bucket.domain.com/jamie-pro/550168/uploads/video-children/edit-0c45aa1394e193cd.mp4",
          "editRange": "6s-8s",
          "duration": 2,
          "createdAt": "2025-01-21T10:30:00.000Z"
        }
      ],
      "childCount": 1,
      "hasChildren": true
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "hasNextPage": false,
    "hasPreviousPage": false,
    "totalCount": 37
  },
  "feedId": "550168",
  "includeChildren": true,
  "childrenSummary": {
    "totalParents": 36,
    "parentsWithChildren": 1,
    "totalChildren": 2
  }
}
```

#### Response without Children

```json
{
  "uploads": [
    {
      "key": "jamie-pro/550168/uploads/video.mp4",
      "fileName": "video.mp4",
      "size": 1678143,
      "lastModified": "2025-01-21T10:00:00.000Z",
      "publicUrl": "https://bucket.domain.com/jamie-pro/550168/uploads/video.mp4"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "hasNextPage": false,
    "hasPreviousPage": false,
    "totalCount": 37
  },
  "feedId": "550168",
  "includeChildren": false,
  "childrenSummary": null
}
```

## Implementation Details

### Hash Generation

Video edits use deterministic hashing to prevent duplicate processing:

```javascript
const hashInput = `edit:${normalizedUrl}:${startTime}:${endTime}:${useSubtitles}`;
const lookupHash = `edit-${crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16)}`;
```

### Duration Validation

The system validates edit ranges against actual video duration:

1. **Client Validation**: Basic range validation (end > start, duration < 10 minutes)
2. **Server Validation**: After downloading, FFprobe determines actual duration
3. **Error Handling**: Clear error messages for invalid ranges

### Processing Pipeline - Phase 2

1. **Immediate Response**: Return lookup hash and polling URL
2. **Smart Strategy Selection**: Analyze file size and extract parameters to choose optimal approach
3. **Background Processing**:
   - **Range Extraction** (large files): Direct FFmpeg streaming from CDN using HTTP range requests
   - **Full Download** (fallback): Memory-managed streaming download with monitoring
   - **Memory Management**: Continuous monitoring with pressure detection and cleanup
   - **Duration Validation**: Real-time validation against actual file duration
   - Upload to `{parentBase}-children/` directory
   - Update database with completion status and performance metrics

### Performance Optimizations - Phase 2

- **Smart Range Extraction**: 90%+ memory reduction for large files using HTTP range requests
- **Memory Management**: 1GB hard limit with continuous monitoring and pressure detection
- **Streaming Downloads**: Memory-managed downloads with progress monitoring
- **Automatic Fallback**: Graceful degradation to full download if range extraction fails
- **Batch Database Queries**: Single query to fetch all child relationships
- **CDN Organization**: Child files separated from parent list
- **Deduplication**: Prevents reprocessing identical requests
- **Process Tracking**: Real-time monitoring of active processes and memory usage
- **Automatic Cleanup**: Orphaned file removal and garbage collection

## Usage Examples

### Basic Video Edit

```bash
# Create a 6-second clip from 8s to 14s
curl -X POST http://localhost:4132/api/edit-video \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "cdnUrl": "https://bucket.domain.com/jamie-pro/550168/uploads/video.mp4",
    "startTime": 8.0,
    "endTime": 14.0
  }'

# Response
{
  "status": "processing",
  "lookupHash": "edit-894e79a94c30e332",
  "pollUrl": "/api/edit-status/edit-894e79a94c30e332"
}
```

### Check Processing Status

```bash
# Poll for completion
curl http://localhost:4132/api/edit-status/edit-894e79a94c30e332

# When complete
{
  "status": "completed",
  "url": "https://bucket.domain.com/jamie-pro/550168/uploads/video-children/edit-894e79a94c30e332.mp4",
  "lookupHash": "edit-894e79a94c30e332"
}
```

### View All Children

```bash
# Get all edits of a parent file
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:4132/api/edit-children/video.mp4
```

### List with Parent-Child Relationships

```bash
# Include children in upload list
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:4132/api/list-uploads?includeChildren=true"

# Exclude children for faster response
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:4132/api/list-uploads?includeChildren=false"
```

## Monitoring & Debugging

### Processing Statistics Endpoint

**Endpoint**: `GET /api/debug/clip-processing-stats`  
**Authentication**: None required

Monitor real-time processing statistics and memory usage:

```bash
curl http://localhost:4132/api/debug/clip-processing-stats
```

#### Response

```json
{
  "success": true,
  "timestamp": "2025-01-21T17:52:22.705Z",
  "stats": {
    "memoryUsage": {
      "rss": 157,        // Total memory (MB)
      "heapUsed": 74,    // Heap used (MB)
      "heapTotal": 76,   // Heap total (MB)
      "external": 22     // External memory (MB)
    },
    "activeProcesses": 0,
    "trackedTempFiles": 0,
    "config": {
      "maxMemoryMB": 1024,          // Memory limit
      "largeFileThresholdMB": 100,  // Range extraction threshold
      "maxConcurrent": 2            // Max concurrent processes
    },
    "activeProcessDetails": [
      {
        "lookupHash": "edit-abc123",
        "editRange": "30s-60s",
        "runningTimeMs": 15420,
        "startMemoryMB": 145
      }
    ]
  }
}
```

### Performance Metrics

Each completed edit includes performance metrics:

- **Processing Time**: Total time from start to completion
- **Memory Delta**: Memory usage change during processing
- **Strategy Used**: Whether range extraction or full download was used
- **File Metrics**: Source duration, file size, extract duration

## Limitations & Constraints

### Current Limits

- **Edit Duration**: Maximum 10 minutes per edit
- **File Size**: Maximum 2GB source files (configurable)
- **Memory Limit**: 1GB hard limit with automatic pressure detection
- **Concurrent Processing**: Maximum 2 simultaneous edit operations
- **Supported Formats**: Video and audio files only
- **CDN Restriction**: Source files must be from configured storage buckets

### Phase Roadmap

- **Phase 1** ✅: Basic functionality with full download
- **Phase 2** ✅: Smart range extraction optimization with robust memory management
- **Phase 3** ✅: Subtitle integration support with SRT + FFmpeg rendering

### Subtitle Implementation

The video editing API uses a **flexible subtitle approach** with two options:

#### **Option 1: Client-Provided Subtitles (Recommended)**
- **Client Control**: Clients provide their own subtitle array with precise timing
- **Format**: Array of objects with `{start, end, text}` properties
- **Performance**: Fastest processing since no transcript lookup is needed
- **Flexibility**: Clients can customize subtitle content and timing

#### **Option 2: Auto-Generated Subtitles (Fallback)**
- **Automatic Generation**: Subtitles generated from transcript JSON data
- **Same Logic**: Uses the same generation logic as make-clip
- **Requires GUID**: Needs podcast GUID to access transcript data
- **Performance**: Slightly slower due to transcript processing

#### **Processing Flow**
1. **Priority Check**: If `subtitles` array is provided and `useSubtitles` is true, use client subtitles
2. **Fallback**: If no client subtitles but `useSubtitles` is true, attempt auto-generation
3. **SRT Conversion**: Convert subtitle array to SRT format for FFmpeg processing
4. **Burned Subtitles**: Subtitles permanently embedded using FFmpeg's subtitle filter

**Note**: The implementation includes comments for easy switching to Canvas rendering if needed.

### Large File Handling

The Phase 2 system is optimized for multi-hour HD podcasts:

- **3-hour 1080p podcast (~3.5GB)**:
  - **Range extraction**: ~80MB memory usage, 3-5x faster processing
  - **Full download fallback**: Streaming with memory monitoring
- **Strategy Selection**: Automatic based on file size (>100MB), extract duration (<5min), and start position (>30s)
- **Memory Protection**: Aborts operations before system overload

## Error Handling

### Common Error Scenarios

1. **Invalid CDN URL**: Source file not in configured buckets
2. **File Not Found**: CDN file doesn't exist or isn't accessible
3. **Duration Validation**: Edit range exceeds actual video duration
4. **Memory Pressure**: System aborts operations when memory usage exceeds 1GB limit
5. **Processing Failures**: FFmpeg errors, upload failures, network timeouts
6. **Range Extraction Failures**: Automatic fallback to full download method

### Error Response Format

All errors follow consistent format:

```json
{
  "error": "Human-readable error message",
  "details": "Technical details (optional)"
}
```

## Security Considerations

- **Authentication Required**: All endpoints require valid podcast admin tokens
- **CDN Validation**: Only files from configured buckets can be edited
- **Rate Limiting**: TODO - Consider implementing edit quotas
- **File Type Validation**: Only video/audio files accepted
- **Duration Limits**: Prevent abuse with 10-minute edit limit

## Related Documentation

- [Architecture Overview](../architecture/ARCHITECTURE.md)
- [Models Summary](./MODELS_SUMMARY.md)
- [HMAC Authentication](../HMAC_AUTH.md)
