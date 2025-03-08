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

### JamieFeedback

This model captures user feedback: