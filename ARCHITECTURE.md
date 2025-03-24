# Pull That Up Jamie - System Architecture Documentation

## Table of Contents
1. [Overview](#overview)
2. [File Structure](#file-structure)
3. [API Endpoints](#api-endpoints)
4. [System Architecture](#system-architecture)
5. [Data Models](#data-models)
6. [Component Flow Charts](#component-flow-charts)
7. [Authentication & Payment Flow](#authentication--payment-flow)
8. [AI Agent Tools](#ai-agent-tools)
9. [Utility Services](#utility-services)

## Overview

Pull That Up Jamie is a privacy-focused search and podcast clip generation application. The system provides users with the ability to search for information using a privacy-respecting search engine (SEARXNG) and generate clips from podcasts. The application supports both free tier access and premium features through Lightning Network micropayments, with email-based authentication reserved for podcast owners and administrators.

## File Structure

```
├── server.js                 # Main application entry point
├── models/                   # Database models and schemas
│   ├── JamieFeedback.js     # User feedback schema
│   ├── ProPodcastDetails.js # Podcast information schema
│   └── WorkProductV2.js     # Clip generation output schema
├── utils/                    # Utility functions and services
│   ├── ClipUtils.js         # Podcast clip processing utilities
│   ├── VideoGenerator.js    # Video generation service
│   ├── LightningUtils.js    # Lightning Network payment integration
│   ├── DatabaseBackupManager.js # Database backup service
│   ├── DigitalOceanSpacesManager.js # Cloud storage management
│   ├── FeedCacheManager.js  # Podcast feed caching
│   ├── rate-limited-invoice.js # Rate limiting for invoice generation
│   ├── requests-db.js       # Request tracking and eligibility
│   ├── invoice-db.js        # Invoice management
│   └── jamie-user-db.js     # User management
├── agent-tools/             # AI integration tools
│   ├── pineconeTools.js    # Vector database integration
│   └── searxngTool.js      # Search engine integration
├── assets/                  # Static assets
└── sessions/               # Session management
```

## API Endpoints

### Authentication and Authorization
- `GET /api/check-free-eligibility`
  - Checks if the client's IP is eligible for free tier access
  - No authentication required

- `POST /api/validate-privs`
  - Validates user privileges and authentication
  - Requires authentication header

### Clip Management
- `POST /api/make-clip`
  - Creates a new podcast clip
  - Requires authentication
  - Body: `{ feedId, guid, timeContext, additionalFields }`

- `GET /api/clip-queue-status/:lookupHash`
  - Retrieves the status of a clip in the processing queue
  - Parameters: `lookupHash`

- `GET /api/clip-status/:lookupHash`
  - Gets the current status of a clip
  - Parameters: `lookupHash`

- `GET /api/clip/:id`
  - Retrieves a specific clip by ID
  - Parameters: `id`

- `GET /api/render-clip/:lookupHash`
  - Renders and returns a clip
  - Parameters: `lookupHash`

### Podcast Management
- `GET /api/get-available-feeds`
  - Lists all available podcast feeds
  - No authentication required

- `GET /api/podcast-feed/:feedId`
  - Retrieves details for a specific podcast feed
  - Parameters: `feedId`

- `GET /api/list-uploads`
  - Lists all uploaded files for the authenticated podcast admin
  - **Only available for Jamie Pro podcast admins**
  - Requires admin JWT authentication
  - Query Parameters:
    - `page` (optional): Page number for paginated results (default: 1)
  - Response: 
    ```json
    { 
      "uploads": [
        { 
          "key": "file/path/key", 
          "fileName": "filename.mp4", 
          "size": 1048576, 
          "lastModified": "2023-07-15T10:30:00Z", 
          "publicUrl": "https://bucket.endpoint.com/file/path/key" 
        }
      ],
      "pagination": {
        "page": 1,
        "pageSize": 50,
        "hasNextPage": true,
        "hasPreviousPage": false,
        "totalCount": 120
      },
      "feedId": "podcast-feed-id"
    }
    ```
  - Example usage with curl:
    ```bash
    # Fetch first page (default)
    curl -X GET "http://localhost:4132/api/list-uploads" \
      -H "Authorization: Bearer YOUR_JWT_TOKEN" \
      -H "Content-Type: application/json"

    # Fetch specific page
    curl -X GET "http://localhost:4132/api/list-uploads?page=2" \
      -H "Authorization: Bearer YOUR_JWT_TOKEN" \
      -H "Content-Type: application/json"
    ```

- `POST /api/generate-presigned-url`
  - Generates a pre-signed URL for direct client-to-CDN uploads
  - **Only available for Jamie Pro podcast admins**
  - Requires admin JWT authentication
  - Body: `{ fileName, fileType, acl }`
  - Response: `{ uploadUrl, key, feedId, publicUrl, maxSizeBytes, maxSizeMB }`
  - The `acl` parameter defaults to `public-read` to ensure files are publicly accessible after upload.
  - Example usage from a React frontend:
    ```javascript
    const generatePresignedUrl = async (fileName, fileType) => {
      const response = await fetch('/api/generate-presigned-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${yourJwtToken}`
        },
        body: JSON.stringify({ fileName, fileType, acl: 'public-read' })
      });
      const data = await response.json();
      return data.uploadUrl;
    };
    ```

### Search and Discovery
- `POST /api/search-quotes`
  - Searches for quotes within podcasts
  - Body: `{ query, filters }`

- `POST /api/stream-search`
  - Performs a streaming search with real-time results
  - Requires authentication
  - Body: `{ query, options }`

### Payment and Subscription
- `GET /invoice-pool`
  - Retrieves available Lightning Network invoices
  - No authentication required

- `POST /register-sub`
  - Registers a new subscription
  - Body: `{ email, subData }`

### Feedback and Health
- `POST /api/feedback`
  - Submits user feedback
  - Body: `{ email, feedback, mode }`

- `GET /health`
  - Health check endpoint
  - No authentication required

### Podcast Run History
- `GET /api/podcast-runs/:feedId/recent`
  - Gets the last N runs for a podcast feed
  - Requires admin JWT authentication
  - Query Parameters: 
    - `limit` (optional): Number of runs to return (default: 10)
  - Response: `{ success: true, data: [RunHistory] }`

- `GET /api/podcast-runs/:feedId/run/:runId`
  - Gets a specific run by ID
  - Requires admin JWT authentication
  - Parameters: 
    - `feedId`: Podcast feed ID
    - `runId`: MongoDB ObjectId of the run
  - Response: `{ success: true, data: RunHistory }`

- `GET /api/podcast-runs/:feedId/latest`
  - Gets the most recent run for a podcast feed
  - Requires admin JWT authentication
  - Parameters: `feedId`
  - Response: `{ success: true, data: RunHistory }`

### User Preferences
- `GET /api/user-prefs`
  - Retrieves all preferences for the authenticated user
  - Requires JWT authentication or bypass mode
  - Response: `{ success: true, data: UserPreferences }`
  - In bypass mode, accepts optional `email` query parameter

- `GET /api/user-prefs/:feedId`
  - Retrieves preferences for a specific podcast feed
  - Requires JWT authentication or bypass mode
  - Parameters: `feedId`
  - Response: `{ success: true, data: PodcastPreference }`
  - In bypass mode, accepts optional `email` query parameter

### Authentication Methods

The API supports four authentication methods:

1. **Lightning Network Payments**
   - Header: `Authorization: <preimage>:<paymentHash>`
   - Validates BOLT11 invoice payment

2. **Square Subscription**
   - Header: `Authorization: Basic <base64-encoded-credentials>`
   - Validates subscription status

3. **Free Tier**
   - No authentication required
   - IP-based eligibility check

4. **Admin JWT Authentication**
   - Header: `Authorization: Bearer <jwt_token>`
   - Used for podcast owner/admin access
   - Token contains admin email claim
   - Validates against ProPodcastDetails collection
   - Required for podcast run history endpoints

#### Development Bypass Mode

For development and testing purposes, token authentication can be bypassed by setting the environment variable:
```
BYPASS_PODCAST_ADMIN_AUTH=bypass
```

When bypass mode is enabled:
- No JWT token is required
- An optional `email` query parameter can be used to simulate different users
- If no email is provided, a default email (`dev@bypass.local`) is used
- Example: `GET /api/user-prefs?email=test@example.com`

⚠️ **Warning**: This bypass should only be used in development environments.

## System Architecture

The application follows a modular architecture with the following key components:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Express.js Server                          │
├─────────────┬─────────────┬────────────────┬──────────────────┬─┘
│ API Routes  │ Middleware  │ Authentication │ Payment System   │
└─────┬───────┴──────┬──────┴────────┬───────┴────────┬─────────┘
      │              │               │                │
┌─────▼──────┐ ┌─────▼──────┐ ┌──────▼───────┐ ┌─────▼─────────┐
│ Agent Tools│ │ Clip Utils │ │ User Manager │ │ Invoice System│
└─────┬──────┘ └─────┬──────┘ └──────┬───────┘ └─────┬─────────┘
      │              │               │                │
┌─────▼──────┐ ┌─────▼──────┐ ┌──────▼───────┐ ┌─────▼─────────┐
│ SEARXNG    │ │ Video Gen  │ │ Database     │ │ Lightning     │
│ Integration│ │ Processing │ │ Management   │ │ Network       │
└────────────┘ └────────────┘ └──────────────┘ └───────────────┘
```

### Key Components:

1. **Express.js Server**: The main application server handling HTTP requests and responses.
2. **API Routes**: Endpoints for search, clip generation, user management, and payment processing.
3. **Middleware**: Authentication, rate limiting, and request validation.
4. **Agent Tools**: Integration with AI services and external search engines.
5. **Clip Utils**: Processing and generation of podcast clips.
6. **User Management**: User authentication and profile management.
7. **Payment System**: Lightning Network micropayments for premium features.
8. **Database Management**: MongoDB for data persistence.

## Data Models

The application uses MongoDB with Mongoose for data modeling. Here are the key data models:

### WorkProductV2

This model represents the output of clip generation processes:

```javascript
const WorkProductV2Schema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['ptuj-clip'],
    required: true,
  },
  result: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
  },
  lookupHash: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  cdnFileId: {
    type: String,
    required: false,
  },
});
```

The `lookupHash` is a deterministic hash generated from clip metadata to ensure deduplication.

### ProPodcastDetails

This model stores information about professional podcasts:

```javascript
const ProPodcastDetailsSchema = new mongoose.Schema({
  feedId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  adminEmail: {
    type: String,
    required: true,
    unique: true,
  },
  headerColor: {
    type: String,
    required: false,
  },
  logoUrl: {
    type: String,
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  creator: {
    type: String,
    required: true,
  },
  lightningAddress: {
    type: String,
    required: false,
  },
  description: {
    type: String,
    required: true,
  },
  feedUrl: {
    type: String,
    required: true,
  },
  listenLink: {
    type: String,
    required: false,
  },
  subscribeLinks: {
    appleLink: { type: String, required: false },
    spotifyLink: { type: String, required: false },
    youtubeLink: { type: String, required: false },
  },
});
```

### Obtaining a Pre-signed URL
- **For Jamie Pro Podcast Admins**
  - To obtain a pre-signed URL for uploading files directly to the CDN, use the `POST /api/generate-presigned-url` endpoint.
  - This endpoint requires admin JWT authentication and is only available for Jamie Pro podcast admins.
  - The request body should include:
    - `fileName`: The name of the file to be uploaded.
    - `fileType`: The MIME type of the file.
    - `acl`: Optional, defaults to `public-read` to ensure the file is publicly accessible.
  - The response will include:
    - `uploadUrl`: The pre-signed URL for uploading the file.
    - `key`: The storage key for the file.
    - `feedId`: The ID of the podcast feed.
    - `publicUrl`: The public URL where the file can be accessed after upload.
    - `maxSizeBytes`: The maximum allowed file size in bytes.
    - `maxSizeMB`: The maximum allowed file size in megabytes.

```javascript
const generatePresignedUrl = async (fileName, fileType) => {
  const response = await fetch('/api/generate-presigned-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${yourJwtToken}`
    },
    body: JSON.stringify({ fileName, fileType, acl: 'public-read' })
  });
  const data = await response.json();
  return data.uploadUrl;
};
```

### Uploading Files
- **Direct Client-to-CDN Upload**
  - Use the pre-signed URL to upload files directly from the client to the CDN.
  - Ensure the `x-amz-acl` header is set to `public-read` in the upload request to make the file publicly accessible.
  - Example bash script for uploading:
    ```bash
    #!/bin/bash
    # Usage: ./test-upload.sh <file_path> "<upload_url>"
    curl -X PUT "$UPLOAD_URL" \
         -H "Content-Type: video/mp4" \
         -H "x-amz-acl: public-read" \
         --data-binary "@$FILE_PATH"
    ```

- `POST /api/jamie-assist/:lookupHash`
  - Generates promotional social media content for a clip
  - Requires authentication (any valid method)
  - Parameters: `lookupHash` - The unique identifier for the clip
  - Body: 
    ```json
    {
      "additionalPrefs": "Write an engaging tweet that focuses on the clip content. Keep it professional but conversational."
    }
    ```
  - Response: Server-sent events stream with generated content that prioritizes compelling copy about the clip text while taking surrounding episode/podcast context into account
  - Example usage:
    ```javascript
    // Client-side example
    const generatePromoContent = async (lookupHash, prefsString = "") => {
      const response = await fetch(`/api/jamie-assist/${lookupHash}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'YOUR_AUTH_HEADER' // Lightning payment or subscription
        },
        body: JSON.stringify({ additionalPrefs: prefsString })
      });
      
      // Handle the streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let result = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              return result;
            }
            
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                result += parsed.content;
                // Update UI with the latest content
              }
            } catch (e) {
              // Handle parsing errors
            }
          }
        }
      }
      
      return result;
    };
    ```

### Jamie Assist Feature

Jamie Assist is an AI-powered social media content generation system that helps users create promotional material for podcast clips. This feature leverages GPT-4 Turbo to generate engaging social media posts that prioritize compelling content about the clip text while taking into account the surrounding podcast context.

#### How It Works:

1. **Input**: The system takes a clip's unique lookupHash identifier and a single string containing any style preferences or instructions.
2. **Processing**: The system:
   - Retrieves the clip's information from the database
   - Fetches associated podcast and episode details for context
   - Constructs a prompt combining the clip text, podcast/episode information, and user's instruction string
   - Sends this to GPT-4 Turbo as a streaming request
3. **Output**: Returns a streaming response containing social media copy tailored for the content.

#### Key Benefits:

- **Content-Focused**: The system prioritizes creating compelling copy about the clip content itself
- **Contextually Aware**: Takes into account podcast and episode metadata to provide relevant framing
- **Simple Customization**: Users can provide a single instruction string for custom requirements
- **Real-time Generation**: Content is streamed back in real-time for immediate use
- **Seamless Integration**: Works with the existing authentication system, including Lightning payments

#### Usage Scenarios:

- Podcast creators sharing highlights on social media
- Listeners sharing interesting clips with personalized commentary
- Content marketers repurposing podcast content for social channels

This feature complements the clip generation system by not only allowing users to create podcast clips but also helping them effectively promote those clips across social media platforms.
