# Nostr Integration Guide - Complete Implementation

## Overview

This guide covers the complete Nostr integration including profile management, search functionality, and robust posting capabilities. The implementation provides production-ready Nostr features with proper error handling, timeout management, and bech32 encoding.

## Architecture

### ✅ **Backend Implementation** 

1. **`/api/nostr/post`** - Robust relay publishing endpoint
2. **`/api/nostr/user/:npub`** - Profile lookup by npub with nprofile generation
3. **`/api/nostr/lookup-profile`** - Advanced profile lookup with custom relays
4. **Profile Search Integration** - Search pinned Nostr profiles by name
5. **Pin Management** - Link/unlink Nostr profiles to existing pins
6. **WebSocket Management** - Proper connection handling with timeouts
7. **Bech32 Encoding** - Creates shareable Primal.net URLs and nprofiles
8. **Parallel Publishing** - Publishes to multiple relays simultaneously
9. **Error Handling** - Comprehensive relay failure management

### 🔗 **Integration Flow**

```
Profile Discovery:
User Searches "HODL" → Search API → Returns Nostr Profile → Frontend Gets nprofile for Posts
      (Frontend)         (Backend)       (With Profile Data)      (Ready for Posting)

Event Publishing:
User Signs Event → Frontend Posts to /api/nostr/post → Backend Publishes to Relays → Returns Results
     (Browser)              (Your React Code)                (Robust Implementation)        (Success URLs)
```

## Frontend Integration Examples

### **1. Nostr Profile Search and Discovery**

```javascript
// Search for Nostr profiles by name
const searchNostrProfiles = async (query) => {
  const response = await fetch('/api/mentions/search/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`
    },
    body: JSON.stringify({
      query: query, // e.g., "HODL", "jack", "walker"
      platforms: ['nostr'],
      includePersonalPins: true,
      includeCrossPlatformMappings: true,
      limit: 10
    })
  });

  // Handle Server-Sent Events
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        
        if (data.type === 'partial' && data.source === 'pins') {
          // Found Nostr profiles
          data.results.forEach(profile => {
            if (profile.platform === 'nostr') {
              console.log('Nostr Profile:', {
                name: profile.name,
                npub: profile.username,
                nprofile: profile.nostr_data?.nprofile,
                description: profile.description,
                isPinned: profile.isPinned
              });
            }
          });
        }
      }
    }
  }
};

// Example: Search for HODL
searchNostrProfiles('HODL');
```

### **2. Direct npub Profile Lookup**

```javascript
// Look up a specific Nostr profile by npub
const lookupNostrProfile = async (npub) => {
  const response = await fetch(`/api/nostr/user/${npub}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${userToken}`
    }
  });

  const result = await response.json();
  
  if (result.success) {
    console.log('Profile found:', {
      name: result.profile.name,
      displayName: result.profile.displayName,
      about: result.profile.about,
      picture: result.profile.picture,
      nip05: result.profile.nip05,
      npub: result.profile.npub,
      nprofile: result.profile.nprofile, // Ready for posts!
      pubkey: result.profile.pubkey
    });
    
    return result.profile;
  } else {
    console.error('Profile not found:', result.message);
    return null;
  }
};

// Example: Lookup HODL's profile
const hodlProfile = await lookupNostrProfile('npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs');
```

### **3. Advanced Profile Lookup with Custom Relays**

```javascript
// Lookup with specific search and nprofile relays
const advancedProfileLookup = async (npub, searchRelays, nprofileRelays) => {
  const response = await fetch('/api/nostr/lookup-profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`
    },
    body: JSON.stringify({
      npub: npub,
      searchRelays: searchRelays || [
        'wss://relay.primal.net',
        'wss://relay.damus.io',
        'wss://nos.lol'
      ],
      nprofileRelays: nprofileRelays || [
        'wss://eden.nostr.land',
        'wss://filter.nostr.wine/npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs?broadcast=true'
      ]
    })
  });

  return await response.json();
};
```

### **4. Pin Management - Link Nostr Profile to Existing Pin**

```javascript
// Link a Nostr profile to an existing Twitter pin
const linkNostrToPin = async (pinId, npub) => {
  const response = await fetch(`/api/mentions/pins/${pinId}/link-nostr`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`
    },
    body: JSON.stringify({
      npub: npub
    })
  });

  const result = await response.json();
  
  if (result.success) {
    console.log('Nostr profile linked to pin:', {
      pinId: pinId,
      nostrProfile: result.pin.nostr_profile
    });
  }
  
  return result;
};

// Create a standalone Nostr pin
const createNostrPin = async (npub, notes = '') => {
  const response = await fetch('/api/mentions/pins', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`
    },
    body: JSON.stringify({
      platform: 'nostr',
      username: npub,
      notes: notes
    })
  });

  return await response.json();
};
```

### **5. Using nprofile in Nostr Posts**

```javascript
// Create post content with Nostr profile mentions
const createPostWithNostrMentions = async (profiles, baseContent) => {
  let content = baseContent;
  
  // Add nprofile mentions to the content
  profiles.forEach(profile => {
    if (profile.nostr_data?.nprofile) {
      content += ` nostr:${profile.nostr_data.nprofile}`;
    }
  });
  
  return content;
};

// Example: Create post mentioning HODL
const hodlProfile = await lookupNostrProfile('npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs');
const postContent = await createPostWithNostrMentions(
  [hodlProfile], 
  'Great Bitcoin content from'
);
// Result: "Great Bitcoin content from nostr:nprofile1qy2hwumn8ghj7etyv4hzumn0wd68ytnvv9hxgqtxwaehxw309anxjmr5v4ezumn0wd68ytnhd9hx2tmwwp6kyvtjw3k8zcmp8pervct409shwdtwx45rxmp4xseryerdx3ehy7f4v3axvet9xsmrjdnxw9jnsuekw9nh2ertwvmkg6n5veen7cnjdaskgcmpwd6r6arjw4jsqgq6lcx8fc7h0p8t4ya9u0a92jnwavqe9rgjwwdw3wjgxfuxsz8rd5mths8c"
```

### **6. Direct Nostr Posting (Standalone)**

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

### **Nostr Profile Management**

#### **GET /api/nostr/user/:npub**

Looks up a Nostr profile by npub and generates nprofile for posting.

**Request:**
```bash
GET /api/nostr/user/npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs
Authorization: Bearer jwt_token
```

**Response:**
```json
{
  "success": true,
  "profile": {
    "npub": "npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs",
    "nprofile": "nprofile1qy2hwumn8ghj7etyv4hzumn0wd68ytnvv9hxgqtxwaehxw309anxjmr5v4ezumn0wd68ytnhd9hx2tmwwp6kyvtjw3k8zcmp8pervct409shwdtwx45rxmp4xseryerdx3ehy7f4v3axvet9xsmrjdnxw9jnsuekw9nh2ertwvmkg6n5veen7cnjdaskgcmpwd6r6arjw4jsqgq6lcx8fc7h0p8t4ya9u0a92jnwavqe9rgjwwdw3wjgxfuxsz8rd5mths8c",
    "pubkey": "1afe0c74e3d7784eba93a5e3fa554a6eeb01928d12739ae8ba4832786808e36d",
    "name": "HODL",
    "displayName": "HODL", 
    "about": "A new world is struggling to be born.",
    "picture": "https://i.postimg.cc/yd4j6Znb/0-AE2325-A-C9-A0-475-C-8-ED3-F012-E5-E3-C426.gif",
    "nip05": "hodl@primal.net",
    "lud16": "hodl@primal.net",
    "website": null
  },
  "searchStats": {
    "relaysSearched": 7,
    "successfulRelays": 3,
    "profileFound": true
  }
}
```

#### **POST /api/nostr/lookup-profile**

Advanced profile lookup with custom search and nprofile relays.

**Request Body:**
```json
{
  "npub": "npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs",
  "searchRelays": [
    "wss://relay.primal.net",
    "wss://relay.damus.io",
    "wss://nos.lol"
  ],
  "nprofileRelays": [
    "wss://eden.nostr.land",
    "wss://filter.nostr.wine/npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs?broadcast=true"
  ]
}
```

**Response:** Same as GET endpoint above.

### **Profile Search Integration**

#### **POST /api/mentions/search/stream**

Search for pinned Nostr profiles by name (Server-Sent Events).

**Request Body:**
```json
{
  "query": "HODL",
  "platforms": ["nostr"],
  "includePersonalPins": true,
  "includeCrossPlatformMappings": true,
  "limit": 10
}
```

**Response (SSE Events):**
```
event: data
data: {"type":"partial","source":"pins","results":[{
  "platform":"nostr",
  "username":"npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs",
  "name":"HODL",
  "isPinned":true,
  "pinId":"pin_1756407925489_r29iknge4",
  "nostr_data":{
    "npub":"npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs",
    "nprofile":"nprofile1qy2hwumn8ghj7etyv4hzumn0wd68ytnvv9hxgqtxwaehxw309anxjmr5v4ezumn0wd68ytnhd9hx2tmwwp6kyvtjw3k8zcmp8pervct409shwdtwx45rxmp4xseryerdx3ehy7f4v3axvet9xsmrjdnxw9jnsuekw9nh2ertwvmkg6n5veen7cnjdaskgcmpwd6r6arjw4jsqgq6lcx8fc7h0p8t4ya9u0a92jnwavqe9rgjwwdw3wjgxfuxsz8rd5mths8c",
    "pubkey":"1afe0c74e3d7784eba93a5e3fa554a6eeb01928d12739ae8ba4832786808e36d",
    "nip05":"hodl@primal.net",
    "lud16":"hodl@primal.net"
  }
}]}

event: complete
data: {"type":"complete","totalResults":1,"platforms":["nostr"],"searchTerm":"HODL"}
```

### **Pin Management**

#### **POST /api/mentions/pins/:pinId/link-nostr**

Link a Nostr profile to an existing pin.

**Request Body:**
```json
{
  "npub": "npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs"
}
```

#### **POST /api/mentions/pins/:pinId/unlink-nostr**

Unlink a Nostr profile from a pin.

#### **POST /api/mentions/pins**

Create a standalone Nostr pin.

**Request Body:**
```json
{
  "platform": "nostr",
  "username": "npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs",
  "notes": "HODL Nostr profile"
}
```

### **Event Publishing**

#### **POST /api/nostr/post**

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
    "wss://nos.lol"
  ],
  "message": "Default Nostr relays"
}
```

## Key Features Implemented

### **👤 Profile Management**
- **npub Validation**: Robust bech32 npub decoding and validation
- **Profile Discovery**: Multi-relay parallel profile lookup
- **nprofile Generation**: Creates posting-ready nprofile strings
- **Custom Relay Support**: Separate search and nprofile relay configurations
- **Profile Caching**: Efficient storage and retrieval of profile data

### **🔍 Search Integration**
- **Name-based Search**: Find Nostr profiles by display name or username
- **Cross-platform Results**: Unified search across Twitter and Nostr
- **Pin Integration**: Search through user's saved Nostr profiles
- **Streaming Results**: Real-time search with Server-Sent Events
- **Admin Mode Support**: Proper handling of admin user context

### **📌 Pin Management**
- **Nostr Pin Creation**: Save standalone Nostr profiles
- **Cross-platform Linking**: Link Nostr profiles to existing Twitter pins
- **Rich Profile Data**: Store complete profile metadata
- **Pin Search**: Find saved profiles by name or description
- **Usage Tracking**: Monitor pin usage and adoption

### **🔗 Relay Management**
- **Parallel Publishing**: All relays contacted simultaneously
- **Timeout Handling**: 10-second timeout per relay
- **Connection Management**: Proper WebSocket lifecycle
- **Error Isolation**: Failed relays don't affect successful ones
- **Custom Relay Lists**: Support for user-specific relay preferences

### **📱 Bech32 Encoding**
- **NEvent Creation**: Generates shareable Primal.net URLs
- **nprofile Encoding**: Standards-compliant nprofile generation
- **Proper Validation**: Full bech32 implementation with checksums
- **Error Handling**: Graceful fallback if encoding fails
- **Multiple Formats**: Support for npub, nprofile, and nevent formats

### **⚡ Performance Optimized**
- **Non-blocking**: Failed relays don't block successful ones
- **Resource Cleanup**: WebSocket connections properly closed
- **Memory Efficient**: No persistent connections maintained
- **Parallel Operations**: Profile lookup and search run concurrently
- **Efficient Storage**: Optimized database queries and indexing

### **🛡️ Error Handling**
- **Comprehensive Logging**: Detailed relay-specific error messages
- **Graceful Degradation**: Success if any relay accepts the event
- **Timeout Protection**: Prevents hanging connections
- **Validation Layers**: Multi-level input validation and sanitization
- **Fallback Mechanisms**: Robust error recovery strategies

## Migration Path

### **Phase 1: Core Infrastructure** ✅
- ✅ Robust Nostr routes implemented
- ✅ WebSocket relay publishing working
- ✅ Bech32 encoding for shareable URLs
- ✅ Profile lookup and nprofile generation
- ✅ Search integration for pinned profiles
- ✅ Pin management with cross-platform linking

### **Phase 2: Frontend Integration** 📋
- ✅ Update search components to use unified Nostr/Twitter search
- ✅ Integrate profile lookup for nprofile generation
- 🔄 Update your React component to use `/api/nostr/post`
- 🔄 Remove client-side relay logic
- ✅ Keep event signing in browser (security best practice)
- 🔄 Add pin management UI for Nostr profiles

### **Phase 3: Advanced Features** 🔮  
- Frontend provides signed events to scheduled post creation
- Backend publishes when scheduled time arrives
- Full integration with existing social post system
- Cross-platform mapping suggestions
- Relay preference management
- Profile verification workflows

### **Current Status: Profile Management Complete** ✅

The Nostr integration now supports:
- **Complete profile discovery workflow** from npub to nprofile
- **Name-based search** for pinned Nostr profiles  
- **Cross-platform compatibility** with existing Twitter functionality
- **Production-ready API endpoints** with comprehensive error handling
- **Standards-compliant encoding** using nostr-tools library

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

### **Profile Lookup Tests:**

```bash
# Test direct npub lookup
curl "http://localhost:4132/api/nostr/user/npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Test advanced profile lookup
curl -X POST "http://localhost:4132/api/nostr/lookup-profile" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "npub": "npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs",
    "searchRelays": ["wss://relay.primal.net", "wss://relay.damus.io", "wss://nos.lol"],
    "nprofileRelays": ["wss://eden.nostr.land"]
  }'
```

### **Profile Search Tests:**

```bash
# Test profile search by name
curl 'http://localhost:4132/api/mentions/search/stream' \
  -X POST \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "query":"HODL",
    "platforms":["nostr"],
    "includePersonalPins":true,
    "includeCrossPlatformMappings":true,
    "limit":10
  }'

# Test cross-platform search
curl 'http://localhost:4132/api/mentions/search/stream' \
  -X POST \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "query":"jack",
    "platforms":["twitter","nostr"],
    "includePersonalPins":true,
    "includeCrossPlatformMappings":true,
    "limit":10
  }'
```

### **Pin Management Tests:**

```bash
# Create a Nostr pin
curl -X POST "http://localhost:4132/api/mentions/pins" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "platform": "nostr",
    "username": "npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs",
    "notes": "HODL profile for testing"
  }'

# Link Nostr profile to existing pin
curl -X POST "http://localhost:4132/api/mentions/pins/PIN_ID/link-nostr" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "npub": "npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs"
  }'

# List all pins to verify
curl "http://localhost:4132/api/mentions/pins" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### **Event Publishing Test:**
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
      "content": "Test post with nprofile mention nostr:nprofile1qy2hwumn8ghj7etyv4hzumn0wd68ytnvv9hxgqtxwaehxw309anxjmr5v4ezumn0wd68ytnhd9hx2tmwwp6kyvtjw3k8zcmp8pervct409shwdtwx45rxmp4xseryerdx3ehy7f4v3axvet9xsmrjdnxw9jnsuekw9nh2ertwvmkg6n5veen7cnjdaskgcmpwd6r6arjw4jsqgq6lcx8fc7h0p8t4ya9u0a92jnwavqe9rgjwwdw3wjgxfuxsz8rd5mths8c",
      "sig": "fakesig123"
    }
  }'
```

### **Integration Workflow Test:**

```bash
# Complete workflow: Search → Pin → Use nprofile
# 1. Search for a profile
SEARCH_RESULT=$(curl -s 'http://localhost:4132/api/mentions/search' \
  -X POST \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json' \
  --data-raw '{"query":"HODL","platforms":["nostr"],"includePersonalPins":true,"limit":1}')

# 2. Extract nprofile from result
NPROFILE=$(echo $SEARCH_RESULT | jq -r '.results[0].nostr_data.nprofile')

# 3. Use nprofile in a post
echo "Ready to use nprofile in post: $NPROFILE"
```

This implementation provides production-ready Nostr integration that maintains the security model of client-side signing while providing robust server-side relay publishing capabilities.
