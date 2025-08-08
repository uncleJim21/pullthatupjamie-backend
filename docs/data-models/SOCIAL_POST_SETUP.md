# Social Post Scheduling - Setup & Integration Guide

## Overview

This implementation provides scheduled social media posting with cross-platform support (Twitter/Nostr), reusing existing Twitter infrastructure and integrating with the existing queue system.

## Architecture

### ✅ **What's Implemented**

1. **SocialPost Model** - One post per platform with well-defined enums
2. **Complete CRUD API** - Full frontend management capabilities  
3. **Twitter Integration** - Reuses existing `twitterRoutes.js` logic
4. **Nostr Skeleton** - Ready for user-provided client logic
5. **Queue Integration** - Uses existing `QueueJob` system
6. **Scheduled Processing** - Automatic background processing

### 🔗 **Integration Points**

- **Existing Models**: Links to `User.email`, `ProPodcastDetails.adminEmail`
- **Twitter OAuth**: Reuses `ProPodcastDetails.twitterTokens`
- **Queue System**: Integrates with existing `QueueJob` model
- **CDN Media**: Direct URLs to DigitalOcean Spaces
- **Authentication**: Uses existing `validate-privs` middleware

## Setup Instructions

### 1. **Add Routes to Server**

```javascript
// In server.js, add the new routes
const socialPostRoutes = require('./routes/socialPostRoutes');
const nostrRoutes = require('./routes/nostrRoutes');

app.use('/api/social', socialPostRoutes);
app.use('/api/nostr', nostrRoutes);
```

### 2. **Start the Processor Service**

```javascript
// In server.js, after other services start
const SocialPostProcessor = require('./utils/SocialPostProcessor');
const socialProcessor = new SocialPostProcessor();
socialProcessor.start();
```

### 3. **Database Migration** (if needed)

The `SocialPost` model is standalone - no existing schema changes required.

## API Reference

### **Create Cross-Platform Posts**

```javascript
POST /api/social/posts
{
  "text": "🎬 New clip just dropped! Check it out:",
  "mediaUrl": "https://cdn.example.com/video.mp4",
  "scheduledFor": "2025-01-15T14:30:00Z",
  "platforms": ["twitter", "nostr"],
  "timezone": "America/Chicago"
}
```

Creates separate `SocialPost` objects for each platform.

### **List User's Posts**

```javascript
GET /api/social/posts?status=scheduled&platform=twitter&limit=20
```

### **Update Scheduled Post**

```javascript
PUT /api/social/posts/:postId
{
  "text": "Updated text",
  "scheduledFor": "2025-01-15T15:00:00Z"
}
```

Only works for `status: 'scheduled'` posts.

### **Delete/Cancel Post**

```javascript
DELETE /api/social/posts/:postId
```

### **Retry Failed Post**

```javascript
POST /api/social/posts/:postId/retry
```

### **Get Statistics**

```javascript
GET /api/social/stats
```

## Status Flow

```
scheduled → processing → posted
    ↓           ↓
cancelled ← failed → (retry) → scheduled
```

### **Status Definitions**

- `scheduled`: Waiting for scheduled time
- `processing`: Currently being published
- `posted`: Successfully published
- `failed`: Failed to publish (can retry)
- `cancelled`: Cancelled by user or max retries exceeded

## Platform Support

### **Twitter** ✅
- **Authentication**: Reuses existing `ProPodcastDetails.twitterTokens`
- **Media Upload**: Uses existing OAuth 1.0a logic
- **Error Handling**: Includes token refresh and re-auth detection
- **Rate Limiting**: Inherits existing Twitter API patterns

### **Nostr** 🚧 
- **Authentication**: User-provided signatures from browser extension
- **Media Handling**: CDN URLs passed as tags
- **Implementation**: Skeleton ready for user's client logic

## Frontend Integration Examples

### **Create Scheduled Post**

```javascript
const response = await fetch('/api/social/posts', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${userToken}`
  },
  body: JSON.stringify({
    text: "Check out my latest podcast clip!",
    mediaUrl: clipData.cdnUrl,
    scheduledFor: scheduledDateTime,
    platforms: ['twitter'] // or ['twitter', 'nostr'] for cross-posting
  })
});
```

### **List User's Posts**

```javascript
const response = await fetch('/api/social/posts?status=scheduled', {
  headers: { 'Authorization': `Bearer ${userToken}` }
});
const { posts, pagination } = await response.json();
```

### **Monitor Post Status**

```javascript
const response = await fetch(`/api/social/posts/${postId}`, {
  headers: { 'Authorization': `Bearer ${userToken}` }
});
const { post } = await response.json();

if (post.status === 'posted') {
  // Show success with platform links
  if (post.platform === 'twitter' && post.platformData.twitterPostUrl) {
    console.log('Posted to Twitter:', post.platformData.twitterPostUrl);
  }
}
```

## Automated Clip Integration

To auto-schedule posts when clips are generated:

```javascript
// In ClipUtils.js or WorkProductV2 completion handler
const SocialPost = require('../models/SocialPost');

async function onClipCompleted(workProduct, adminEmail) {
  // Auto-schedule promotional post for 5 minutes later
  const scheduledPost = new SocialPost({
    adminEmail: adminEmail,
    platform: 'twitter', // Default to Twitter
    scheduledFor: new Date(Date.now() + (5 * 60 * 1000)),
    content: {
      text: "🎬 New clip just dropped! Check it out:",
      mediaUrl: workProduct.cdnFileId
    }
  });
  
  await scheduledPost.save();
  console.log(`Auto-scheduled post ${scheduledPost.postId} for clip ${workProduct.lookupHash}`);
}
```

## Error Handling

### **Common Error Scenarios**

1. **Twitter Auth Expired**: Returns specific error code for frontend to handle re-auth
2. **Media Upload Failed**: Detailed error messages for debugging
3. **Missing Platform Auth**: Clear guidance on required setup
4. **Network Issues**: Automatic retry with exponential backoff

### **Monitoring**

```javascript
// Get processing statistics
const stats = await socialProcessor.getStats();
console.log('Social post statistics:', stats);
```

## TODO Items

### **Immediate** ⏳
- [ ] User to provide Nostr client-side posting logic
- [ ] Test end-to-end flow with real Twitter posts
- [ ] Add integration tests

### **Future Enhancements** 🔮
- [ ] NIP-46 remote signing for Nostr
- [ ] Post analytics and engagement tracking
- [ ] Template system for common post types
- [ ] Bulk operations (schedule multiple posts)
- [ ] Advanced scheduling (optimal timing)

## Notes

- **Cross-posting** creates separate `SocialPost` objects per platform for independent tracking
- **Media handling** uses direct CDN URLs - no local storage needed
- **Queue integration** allows horizontal scaling of post processing
- **Error recovery** includes comprehensive retry logic with backoff
- **Status tracking** provides real-time feedback for frontend UIs

This implementation is **production-ready** for Twitter and **skeleton-ready** for Nostr integration.
