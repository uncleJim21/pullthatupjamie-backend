# Unsigned Nostr Note Lifecycle

## Overview

This document describes the automated workflow for creating, managing, and signing Nostr posts that require user interaction for cryptographic signing. The system allows agents to create unsigned Nostr notes that users can later sign and schedule for posting.

## Lifecycle States

### Status Flow
```
Agent Creates → unsigned → User Signs → scheduled → processing → posted
                    ↓           ↓             ↓            ↓
                [Waiting]   [Ready to    [Queued for  [Published
                           Schedule]     Posting]     to Relays]
```

### Status Definitions

| Status | Description | Who Can Modify | Next States |
|--------|-------------|----------------|-------------|
| `unsigned` | Created by agent, waiting for user signature | User | `scheduled`, `cancelled` |
| `scheduled` | Signed by user, ready for automated posting | User | `processing`, `cancelled` |
| `processing` | Currently being posted to Nostr relays | System | `posted`, `failed` |
| `posted` | Successfully published to Nostr | System | *(final state)* |
| `failed` | Publishing failed, can be retried | User/System | `scheduled` (retry) |
| `cancelled` | User cancelled the post | User | *(final state)* |

## API Endpoints

### 1. Agent Creates Unsigned Note

**Endpoint**: `POST /api/social/posts/unsigned`  
**Authentication**: Service HMAC (`svc:social:schedule` scope)  
**Purpose**: Agent creates unsigned Nostr note for later user interaction

```javascript
POST /api/social/posts/unsigned
Authorization: HMAC-SHA256 [service-auth-header]
Content-Type: application/json

{
  "adminEmail": "user@example.com",
  "text": "🎙️ New podcast episode just dropped! Check it out:",
  "mediaUrl": "https://cdn.example.com/episode-123.mp4",
  "scheduledFor": "2024-01-15T14:30:00Z",
  "scheduledPostSlotId": "slot-abc-123"
}
```

**Response**:
```javascript
{
  "success": true,
  "message": "Created unsigned Nostr note for user interaction",
  "post": {
    "_id": "65a1b2c3d4e5f6789012345",
    "platform": "nostr",
    "scheduledFor": "2024-01-15T14:30:00.000Z",
    "status": "unsigned",
    "content": {
      "text": "🎙️ New podcast episode just dropped! Check it out:",
      "mediaUrl": "https://cdn.example.com/episode-123.mp4"
    },
    "adminEmail": "user@example.com"
  }
}
```

### 2. User Retrieves Unsigned Notes

**Endpoint**: `GET /api/social/posts?status=unsigned`  
**Authentication**: User token (`validatePrivs`)  
**Purpose**: User views all their unsigned notes awaiting signature

```javascript
GET /api/social/posts?status=unsigned&limit=20&sortBy=createdAt&sortOrder=desc
Authorization: Bearer [user-jwt-token]
```

**Response**:
```javascript
{
  "success": true,
  "posts": [
    {
      "_id": "65a1b2c3d4e5f6789012345",
      "adminEmail": "user@example.com",
      "platform": "nostr",
      "scheduledFor": "2024-01-15T14:30:00.000Z",
      "timezone": "America/Chicago",
      "content": {
        "text": "🎙️ New podcast episode just dropped! Check it out:",
        "mediaUrl": "https://cdn.example.com/episode-123.mp4"
      },
      "status": "unsigned",
      "platformData": {},
      "createdAt": "2024-01-10T10:15:30.000Z",
      "updatedAt": "2024-01-10T10:15:30.000Z"
    }
  ],
  "pagination": {
    "total": 1,
    "limit": 20,
    "offset": 0,
    "hasMore": false
  }
}
```

### 3. User Signs the Note

**Endpoint**: `PUT /api/social/posts/:postId`  
**Authentication**: User token (`validatePrivs`)  
**Purpose**: User provides Nostr signature data to convert unsigned → scheduled

```javascript
PUT /api/social/posts/65a1b2c3d4e5f6789012345
Authorization: Bearer [user-jwt-token]
Content-Type: application/json

{
  "platformData": {
    "nostrEventId": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
    "nostrSignature": "def456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890abcdef",
    "nostrPubkey": "789012345678901234567890123456789012345678901234567890123456789012",
    "nostrCreatedAt": 1705419000,
    "nostrRelays": [
      "wss://relay.damus.io",
      "wss://nos.lol",
      "wss://relay.snort.social"
    ],
    "nostrPostUrl": "https://primal.net/e/note1..."
  }
}
```

**Response**:
```javascript
{
  "success": true,
  "message": "Social post updated successfully",
  "post": {
    "_id": "65a1b2c3d4e5f6789012345",
    "status": "scheduled", // ← Status automatically changed!
    "platformData": {
      "nostrEventId": "a1b2c3d4e5f6789012345...",
      "nostrSignature": "def456789012345678901...",
      "nostrPubkey": "789012345678901234567...",
      "nostrCreatedAt": 1705419000,
      "nostrRelays": ["wss://relay.damus.io", ...],
      "nostrPostUrl": "https://primal.net/e/note1..."
    },
    // ... other fields
  }
}
```

## Frontend Integration

### Nostr Signing Process

The frontend should use the user's Nostr extension (NIP-07) to sign events:

```javascript
// 1. Get unsigned post content
const unsignedPost = await fetchUnsignedPost(postId);

// 2. Create Nostr event structure
const eventTemplate = {
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: unsignedPost.content.text + 
    (unsignedPost.content.mediaUrl ? `\n\n${unsignedPost.content.mediaUrl}` : '')
};

// 3. Sign with user's Nostr extension
const signedEvent = await window.nostr.signEvent(eventTemplate);

// 4. Submit signed event to backend
const result = await updateSocialPost(postId, {
  platformData: {
    nostrEventId: signedEvent.id,
    nostrSignature: signedEvent.sig,
    nostrPubkey: signedEvent.pubkey,
    nostrCreatedAt: signedEvent.created_at,
    nostrRelays: userSelectedRelays,
    nostrPostUrl: generatePrimalUrl(signedEvent.id)
  }
});
```

## Automated Processing

### Background Service Behavior

The `SocialPostProcessor` service automatically:

1. **Ignores unsigned posts** - Only processes `status: 'scheduled'` posts
2. **Processes signed posts** - Once unsigned → scheduled, normal posting workflow applies
3. **Handles failures** - Failed posts can be retried through existing retry mechanism

### Processing Schedule

- **Check Interval**: Every 60 seconds
- **Batch Size**: 10 posts per cycle
- **Retry Logic**: Exponential backoff (1min, 2min, 4min)
- **Max Attempts**: 3 attempts before giving up

## Error Handling

### Common Error Scenarios

#### 1. Incomplete Signing Data
```javascript
{
  "error": "Incomplete signing data",
  "message": "To sign an unsigned Nostr post, all required fields must be provided: nostrEventId, nostrSignature, nostrPubkey, nostrCreatedAt"
}
```

#### 2. Invalid Post Status
```javascript
{
  "error": "Cannot edit post",
  "message": "Posts with status 'posted' cannot be edited. Only 'scheduled' and 'unsigned' posts can be modified."
}
```

#### 3. Missing Content
```javascript
{
  "error": "Missing content",
  "message": "Either text or media URL is required"
}
```

### Error Recovery

- **Unsigned posts**: Can be edited, cancelled, or signed at any time
- **Failed posts**: Can be retried using existing retry endpoint
- **Processing posts**: Can be cancelled (sets status to 'cancelled')

## Security Considerations

### Agent Authentication
- Uses HMAC service authentication with `svc:social:schedule` scope
- Agent cannot sign posts - only create unsigned drafts
- Agent must provide explicit `adminEmail` for each request

### User Authentication
- User authentication required for all signing operations
- Users can only sign their own posts (filtered by `adminEmail`)
- Nostr signature validation happens client-side via browser extension

### Data Integrity
- All required Nostr fields must be provided atomically
- Status transitions are logged for audit purposes
- Failed signatures don't corrupt existing post data

## Monitoring & Observability

### Log Messages
```
🔄 Processing post 65a1b2c3d4e5f6789012345 for nostr
✅ Successfully posted to nostr: 65a1b2c3d4e5f6789012345
❌ Post 65a1b2c3d4e5f6789012345 exceeded max attempts (3), giving up
Converting unsigned post 65a1b2c3d4e5f6789012345 to scheduled status
```

### Metrics to Monitor
- Number of unsigned posts created per day
- Time between creation and signing
- Signature success/failure rates
- Posts stuck in unsigned status

## Best Practices

### For Agents
1. **Provide meaningful content** - Include context for users to understand the post
2. **Set appropriate schedule times** - Consider user timezone preferences
3. **Include media strategically** - Balance engagement with file size
4. **Use descriptive slot IDs** - For tracking and correlation

### For Frontend Implementation
1. **Batch unsigned posts** - Show all unsigned posts in a dedicated UI
2. **Validate signatures** - Check signature before submitting to backend
3. **Handle errors gracefully** - Provide clear feedback for signing failures
4. **Cache relay preferences** - Remember user's preferred Nostr relays

### For Operations
1. **Monitor unsigned post age** - Alert on posts unsigned for >24 hours
2. **Track signing success rates** - Identify users having trouble with extensions
3. **Monitor relay health** - Ensure selected relays are operational
4. **Backup signing data** - Log successful signatures for debugging

## Integration Examples

### Podcast Episode Automation
```javascript
// Agent creates unsigned post after episode processing
const episodePost = await createUnsignedPost({
  adminEmail: episode.adminEmail,
  text: `🎙️ New episode: "${episode.title}" is now live!`,
  mediaUrl: episode.clipUrl,
  scheduledFor: episode.releaseTime,
  scheduledPostSlotId: `episode-${episode.id}`
});

// User signs during their review workflow
const signedPost = await signUnsignedPost(episodePost._id, nostrSignature);
```

### Batch Operations
```javascript
// Get all unsigned posts for review
const unsignedPosts = await getUserPosts({ status: 'unsigned' });

// Sign multiple posts in sequence
for (const post of unsignedPosts) {
  if (userApproves(post)) {
    await signPost(post._id);
  } else {
    await cancelPost(post._id);
  }
}
```

This lifecycle enables a seamless handoff between automated content creation and user-controlled cryptographic signing, maintaining security while enabling automation.
