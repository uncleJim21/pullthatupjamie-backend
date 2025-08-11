# Nostr Integration Guide - Robust Implementation

## Overview

This guide shows how to integrate the robust Nostr posting functionality extracted from your React component into the backend API. The implementation provides production-ready Nostr relay publishing with proper error handling, timeout management, and bech32 encoding.

## Architecture

### ✅ **Backend Implementation** 

1. **`/api/nostr/post`** - Robust relay publishing endpoint
2. **WebSocket Management** - Proper connection handling with timeouts
3. **Bech32 Encoding** - Creates shareable Primal.net URLs
4. **Parallel Publishing** - Publishes to multiple relays simultaneously
5. **Error Handling** - Comprehensive relay failure management

### 🔗 **Frontend Integration Flow**

```
User Signs Event → Frontend Posts to /api/nostr/post → Backend Publishes to Relays → Returns Results
     (Browser)              (Your React Code)                (New Implementation)        (Success URLs)
```

## Frontend Integration Examples

### **1. Direct Nostr Posting (Standalone)**

```javascript
// From your React component - publishToNostr function
const publishToNostr = async () => {
  if (!window.nostr) {
    throw new Error("No Nostr extension available");
  }

  try {
    // Create the event (same as your implementation)
    const event = {
      kind: 1,
      content: finalContent, // Your content + media URLs
      tags: mediaUrl ? [['r', mediaUrl]] : [],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: await window.nostr.getPublicKey()
    };

    // Sign the event with user's extension
    const signedEvent = await window.nostr.signEvent(event);
    
    // Send to backend for relay publishing
    const response = await fetch('/api/nostr/post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({
        signedEvent,
        relays: customRelays // optional
      })
    });

    const result = await response.json();
    
    if (result.success) {
      console.log(`Published to ${result.stats.successful}/${result.stats.total} relays`);
      console.log('Primal URL:', result.primalUrl);
      return result;
    } else {
      throw new Error(result.message);
    }
    
  } catch (error) {
    console.error('Nostr publishing failed:', error);
    throw error;
  }
};
```

### **2. Scheduled Nostr Posts Integration**

```javascript
// Create scheduled Nostr post with pre-signed event
const scheduleNostrPost = async (content, mediaUrl, scheduledFor) => {
  if (!window.nostr) {
    throw new Error("Nostr extension required");
  }

  try {
    // Create and sign the event
    const event = {
      kind: 1,
      content: content + (mediaUrl ? `\n\n${mediaUrl}` : ''),
      tags: mediaUrl ? [['r', mediaUrl]] : [],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: await window.nostr.getPublicKey()
    };

    const signedEvent = await window.nostr.signEvent(event);
    
    // Create scheduled post with signed event data
    const response = await fetch('/api/social/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({
        text: content,
        mediaUrl,
        scheduledFor,
        platforms: ['nostr'],
        // Include the Nostr-specific data
        platformData: {
          nostrEventId: signedEvent.id,
          nostrPubkey: signedEvent.pubkey,
          nostrSignature: signedEvent.sig,
          nostrRelays: customRelays
        }
      })
    });

    return await response.json();
    
  } catch (error) {
    console.error('Failed to schedule Nostr post:', error);
    throw error;
  }
};
```

### **3. Cross-Platform Posting (Twitter + Nostr)**

```javascript
// Your existing SocialShareModal logic adapted for backend integration
const handlePublish = async () => {
  const promises = [];
  
  // Twitter posting (existing logic)
  if (twitterState.enabled) {
    promises.push(publishToTwitter());
  }
  
  // Nostr posting (new backend integration)
  if (nostrState.enabled && nostrState.authenticated) {
    promises.push(publishToNostr());
  }
  
  try {
    const results = await Promise.allSettled(promises);
    
    // Process results and show success URLs
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const platform = index === 0 ? 'twitter' : 'nostr';
        if (platform === 'nostr' && result.value.primalUrl) {
          setSuccessUrls(prev => ({ ...prev, nostr: result.value.primalUrl }));
        }
      }
    });
    
  } catch (error) {
    console.error('Publishing error:', error);
  }
};
```

## Backend API Reference

### **POST /api/nostr/post**

Publishes a signed Nostr event to multiple relays with robust error handling.

**Request Body:**
```json
{
  "signedEvent": {
    "id": "hex_event_id",
    "pubkey": "hex_pubkey", 
    "created_at": 1673123456,
    "kind": 1,
    "tags": [["r", "https://cdn.example.com/media.mp4"]],
    "content": "Post content with media URL",
    "sig": "hex_signature"
  },
  "relays": [
    "wss://relay.primal.net",
    "wss://relay.damus.io",
    "wss://nos.lol"
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Nostr event published to 6/7 relays",
  "eventId": "hex_event_id",
  "publishedRelays": [
    "wss://relay.primal.net",
    "wss://relay.damus.io",
    "wss://nos.lol"
  ],
  "failedRelays": [
    {
      "relay": "wss://relay.mostr.pub",
      "error": "Connection timeout"
    }
  ],
  "primalUrl": "https://primal.net/e/nevent1abc123...",
  "stats": {
    "total": 7,
    "successful": 6,
    "failed": 1
  },
  "timestamp": "2025-01-08T00:30:00.000Z"
}
```

### **GET /api/nostr/relays**

Returns the default relay list.

**Response:**
```json
{
  "success": true,
  "relays": [
    "wss://relay.primal.net",
    "wss://relay.damus.io", 
    "wss://nos.lol",
    "wss://relay.mostr.pub",
    "wss://nostr.land",
    "wss://purplerelay.com",
    "wss://relay.snort.social"
  ],
  "message": "Default Nostr relays"
}
```

## Key Features Implemented

### **🔗 Relay Management**
- **Parallel Publishing**: All relays contacted simultaneously
- **Timeout Handling**: 10-second timeout per relay
- **Connection Management**: Proper WebSocket lifecycle
- **Error Isolation**: Failed relays don't affect successful ones

### **📱 Bech32 Encoding**
- **NEvent Creation**: Generates shareable Primal.net URLs
- **Proper Encoding**: Full bech32 implementation with checksums
- **Error Handling**: Graceful fallback if encoding fails

### **⚡ Performance Optimized**
- **Non-blocking**: Failed relays don't block successful ones
- **Resource Cleanup**: WebSocket connections properly closed
- **Memory Efficient**: No persistent connections maintained

### **🛡️ Error Handling**
- **Comprehensive Logging**: Detailed relay-specific error messages
- **Graceful Degradation**: Success if any relay accepts the event
- **Timeout Protection**: Prevents hanging connections

## Migration Path

### **Phase 1: Replace Mock Implementation** ✅
- Robust Nostr routes implemented
- WebSocket relay publishing working
- Bech32 encoding for shareable URLs

### **Phase 2: Frontend Integration** 📋
- Update your React component to use `/api/nostr/post`
- Remove client-side relay logic
- Keep event signing in browser (security best practice)

### **Phase 3: Scheduled Posts** 🔮  
- Frontend provides signed events to scheduled post creation
- Backend publishes when scheduled time arrives
- Full integration with existing social post system

## Security Considerations

### **✅ Secure by Design**
- **Private keys never leave browser** - Only signed events sent to backend
- **No key storage** - Backend never sees or stores private keys  
- **User control** - All signing done through user's Nostr extension

### **🔐 Authentication**
- All endpoints require JWT authentication
- Rate limiting applies to prevent spam
- User permissions validated before publishing

## Testing the Implementation

### **Direct API Test:**
```bash
curl -X POST http://localhost:4132/api/nostr/post \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "signedEvent": {
      "id": "test123",
      "pubkey": "deadbeef",
      "created_at": 1673123456,
      "kind": 1,
      "tags": [],
      "content": "Test post from backend",
      "sig": "fakesig123"
    }
  }'
```

This implementation provides production-ready Nostr integration that maintains the security model of client-side signing while providing robust server-side relay publishing capabilities.
