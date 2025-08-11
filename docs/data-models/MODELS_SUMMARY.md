# Pull That Up Jamie - Data Models Summary

## Overview

This document provides a comprehensive overview of all data models used in the Pull That Up Jamie backend system. Each model serves a specific purpose in the application's functionality, from user management and authentication to podcast processing and content generation.

## Table of Contents

1. [User Management & Authentication](#user-management--authentication)
2. [Podcast Management](#podcast-management)
3. [Content Processing & Generation](#content-processing--generation)
4. [System Management](#system-management)
5. [Social Media Integration](#social-media-integration)

---

## User Management & Authentication

### 🔐 **Entitlement.js**
**Purpose**: Universal entitlement system managing user permissions and quota limits across different access types.

**Key Features**:
- Supports multiple identifier types (IP, JWT, email, custom)
- Flexible entitlement types (onDemandRun, premiumFeature, apiAccess, custom)
- Period-based quota management with automatic reset capabilities
- Built-in usage tracking and eligibility checking
- Virtual properties for remaining usage and eligibility status

**Usage in Project**:
- Controls access to premium features and API endpoints
- Manages free tier limitations based on IP addresses
- Tracks usage patterns and enforces rate limiting
- Supports Lightning Network and email-based subscription models

**Key Fields**:
- `identifier`: Unique identifier (IP address, user ID, etc.)
- `identifierType`: Type of identifier (ip, jwt, email, custom)
- `entitlementType`: Type of permission granted
- `usedCount`/`maxUsage`: Usage tracking and limits
- `periodStart`/`periodLengthDays`: Time-based quota periods

---

### 👤 **User.js**
**Purpose**: Core user account management for authenticated users (primarily podcast administrators).

**Key Features**:
- Email-based authentication with password hashing
- Square payment integration for subscription management
- Pinned mentions system for social media cross-posting
- User preference management for mention handling

**Usage in Project**:
- Manages podcast administrator accounts
- Handles subscription payments and customer management
- Stores user preferences for social media features
- Supports mention mapping and cross-platform posting

**Key Fields**:
- `email`/`password`: Authentication credentials
- `squareCustomerId`/`subscriptionId`: Payment integration
- `mention_preferences`: Social media preference configuration

---

### 📊 **OnDemandQuota.js**
**Purpose**: Legacy quota management system for on-demand podcast processing (being phased out in favor of Entitlement system).

**Key Features**:
- IP and JWT-based quota tracking
- Monthly quota periods with automatic reset
- Usage limitation enforcement

**Usage in Project**:
- Controls access to on-demand podcast processing features
- Prevents abuse through rate limiting
- Manages free tier access for anonymous users

**Key Fields**:
- `identifier`: IP address or JWT user ID
- `remainingRuns`/`totalLimit`: Usage quotas
- `periodStart`/`nextResetDate`: Reset scheduling

---

## Podcast Management

### 🎙️ **ProPodcastDetails.js**
**Purpose**: Comprehensive podcast metadata and configuration management for professional users.

**Key Features**:
- Complete podcast metadata (title, creator, description, etc.)
- Visual branding configuration (logo, header colors)
- Social media integration with Twitter OAuth tokens
- Lightning Network payment integration
- Subscription link management

**Usage in Project**:
- Stores podcast administrator information and preferences
- Manages visual branding for generated clips
- Handles Twitter integration for automated posting
- Provides podcast feed management and caching
- Supports Lightning Network micropayments

**Key Fields**:
- `feedId`/`feedUrl`: Podcast identification and source
- `adminEmail`: Administrator contact information
- `logoUrl`/`headerColor`: Visual branding
- `twitterTokens`: OAuth integration for posting
- `lightningAddress`: Payment integration

---

### 🔄 **ScheduledPodcastFeed.js**
**Purpose**: Automated podcast feed processing and scheduling management.

**Key Features**:
- Scheduled feed processing with enable/disable controls
- Processing history tracking
- Feed metadata caching

**Usage in Project**:
- Manages automated podcast ingestion schedules
- Tracks processing history and status
- Enables/disables feeds for processing
- Caches feed metadata for performance

**Key Fields**:
- `feedUrl`/`feedId`: Feed identification
- `isEnabled`: Processing control
- `lastProcessed`: History tracking
- `feedTitle`/`podcastImage`: Cached metadata

---

### 📈 **ProPodcastRunHistory.js**
**Purpose**: Detailed tracking of podcast processing runs and clip recommendations.

**Key Features**:
- Processing run history with timestamps
- Clip recommendation storage with detailed metadata
- Episode and feed scoping
- Relevance scoring and context tracking

**Usage in Project**:
- Tracks automated podcast processing results
- Stores AI-generated clip recommendations
- Provides processing analytics and history
- Manages clip metadata for generation

**Key Fields**:
- `feed_id`/`run_date`: Processing identification
- `filter_scope`: Episode/feed targeting
- `recommendations`: Generated clip suggestions with full metadata

---

### ⚙️ **ProPodcastUserPrefs.js**
**Purpose**: User preference management for podcast administrators.

**Key Features**:
- Per-podcast preference configuration
- Global user settings
- Topic filtering and notification preferences
- Favorite/exclusion management

**Usage in Project**:
- Customizes podcast processing behavior per user
- Manages notification frequencies and preferences
- Handles topic filtering for content discovery
- Provides personalized podcast management

**Key Fields**:
- `user_id`/`email`: User identification
- `global_preferences`: System-wide settings
- `podcast_preferences`: Per-podcast configurations

---

## Content Processing & Generation

### 🎬 **WorkProductV2.js**
**Purpose**: Core content generation tracking for clips and on-demand processing results.

**Key Features**:
- Deterministic lookup hash generation for deduplication
- Processing status tracking (queued, processing, completed, failed)
- CDN integration for file storage
- Support for multiple content types

**Usage in Project**:
- Tracks all generated content (clips, episodes)
- Prevents duplicate processing through hash-based deduplication
- Manages processing pipeline status
- Integrates with CDN for content delivery

**Key Fields**:
- `lookupHash`: Unique content identifier
- `type`: Content type (ptuj-clip, on-demand-jamie-episodes)
- `status`: Processing state
- `result`: Generated content data
- `cdnFileId`: Storage reference

---

### ⏳ **QueueJob.js**
**Purpose**: Job queue management for resource-intensive processing tasks.

**Key Features**:
- Priority-based job queuing
- Retry logic with attempt tracking
- Instance-based processing with heartbeat monitoring
- Comprehensive error tracking and history

**Usage in Project**:
- Manages video clip generation queue
- Handles concurrent processing across multiple instances
- Provides retry logic for failed jobs
- Tracks processing performance and errors

**Key Fields**:
- `lookupHash`: Job identification
- `status`/`priority`: Queue management
- `clipData`/`timestamps`/`subtitles`: Processing data
- `instanceId`/`heartbeatAt`: Distributed processing
- `errorHistory`: Failure tracking

---

## System Management

### 💬 **JamieFeedback.js**
**Purpose**: User feedback collection and management.

**Key Features**:
- Simple feedback storage with metadata
- Mode and status tracking
- Timestamp recording

**Usage in Project**:
- Collects user feedback and feature requests
- Tracks feedback status and processing mode
- Provides user insight for product development

**Key Fields**:
- `email`: User contact information
- `feedback`: User message content
- `mode`/`status`/`state`: Feedback categorization

---

## Social Media Integration

### 🔗 **SocialProfileMappings.js**
**Purpose**: Cross-platform social media profile mapping and verification.

**Key Features**:
- Twitter to Nostr profile mapping
- Community-driven verification system
- Confidence scoring and voting
- Multiple verification methods

**Usage in Project**:
- Enables cross-platform social media posting
- Provides verified profile mappings for content sharing
- Supports community verification and quality control
- Tracks mapping usage and reliability

**Key Fields**:
- `mapping_key`: Unique profile combination identifier
- `twitter_profile`/`nostr_profile`: Platform-specific data
- `confidence_score`: Mapping reliability
- `verification_method`: How mapping was verified
- `upvotes`/`downvotes`: Community validation

---

## Database Design Patterns

### **Common Patterns Across Models**:

1. **Indexing Strategy**: All models use strategic indexing for query performance
2. **Timestamps**: Most models include automatic timestamp tracking
3. **Flexible Metadata**: Many models include `metadata` or `Mixed` fields for extensibility
4. **Status Tracking**: Processing-related models use consistent status enums
5. **Identifier Patterns**: Multiple identifier types supported across authentication models
6. **Virtual Properties**: Computed fields for derived data (remaining usage, eligibility, etc.)

### **Model Relationships**:

- **User** → **ProPodcastDetails** (via adminEmail)
- **ProPodcastDetails** → **ProPodcastRunHistory** (via feedId)
- **ProPodcastDetails** → **ScheduledPodcastFeed** (via feedId)
- **WorkProductV2** → **QueueJob** (via lookupHash)
- **User** → **ProPodcastUserPrefs** (via email/user_id)
- **Entitlement** replaces **OnDemandQuota** (new unified system)

### **Migration Notes**:

- **OnDemandQuota** is being replaced by the more flexible **Entitlement** system
- **WorkProductV2** represents the latest iteration of content tracking
- Social media features are expanding with **SocialProfileMappings** integration

---

## Usage Recommendations

1. **For New Features**: Use the **Entitlement** model for any access control or quota management
2. **For Content Processing**: **WorkProductV2** and **QueueJob** provide comprehensive processing pipeline management
3. **For Podcast Management**: **ProPodcastDetails** and related models provide full podcast lifecycle management
4. **For Social Integration**: **SocialProfileMappings** enables cross-platform functionality

This model architecture supports the platform's core functionality while maintaining flexibility for future enhancements and integrations.