# Nostr Profile Integration Guide

## 🎯 Overview

This document describes the Nostr profile lookup and integration functionality for the cross-platform mention mapping system. Users can now link their existing Twitter pins to Nostr profiles by looking up profiles via npub (Nostr public keys).

## 🚀 Key Features

### ✅ **Implemented Features**
- **npub Validation & Decoding**: Validate and decode Nostr public keys
- **Multi-Relay Profile Lookup**: Query multiple Nostr relays for profile metadata
- **Pin Linking**: Associate existing Twitter pins with Nostr profiles
- **Mapping Suggestions**: Discover existing cross-platform mappings
- **Profile Management**: Link/unlink Nostr profiles from pins

### 🔧 **Technical Components**
1. **NostrService** - Core Nostr functionality with profile lookup
2. **API Endpoints** - RESTful endpoints for profile operations
3. **Data Integration** - Seamless integration with existing pin structure

---

## 📡 API Endpoints

### Nostr Profile Lookup

#### `GET /api/nostr/user/:npub`
Lookup a Nostr profile by npub.

**Example:**
```bash
curl "http://localhost:4111/api/nostr/user/npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m"
```

**Response:**
```json
{
  "success": true,
  "profile": {
    "npub": "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m",
    "nprofile": "nprofile1qyxhwumn8ghj7mn0wvhxcmmvqywhwumn8ghj7mn0wd68yttsw43zuam9d3kx7unyv4ezumn9wsqzq7q8pqp9qg6mz0y0keaw4u6q7fxr8pzmy3cw0hw8asx5psqxsfj9w2rsvz",
    "pubkey": "a0f67...",
    "name": "Alice",
    "displayName": "Alice Smith",
    "about": "Nostr enthusiast...",
    "picture": "https://...",
    "website": "https://alice.com",
    "nip05": "alice@nostr.com"
  },
  "message": "Profile found from wss://relay.damus.io",
  "stats": {
    "total": 7,
    "successful": 3,
    "failed": 4
  }
}
```

#### `POST /api/nostr/lookup-profile`
Lookup profile with custom relay specification.

**Request:**
```json
{
  "npub": "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m",
  "relays": ["wss://relay.damus.io", "wss://nos.lol"]
}
```

### Pin Integration

#### `POST /api/mentions/pins/:pinId/link-nostr`
Link a Nostr profile to an existing Twitter pin.

**Request:**
```json
{
  "npub": "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Nostr profile linked successfully",
  "pin": {
    "id": "pin_1234567890_abc123",
    "twitter_profile": { "username": "alice", ... },
    "nostr_profile": { "npub": "npub1...", "name": "Alice", ... },
    "is_cross_platform": true,
    "updated_at": "2024-01-15T11:00:00Z"
  }
}
```

#### `POST /api/mentions/pins/:pinId/unlink-nostr`
Remove Nostr profile from a pin.

**Response:**
```json
{
  "success": true,
  "message": "Nostr profile unlinked successfully",
  "pin": {
    "id": "pin_1234567890_abc123",
    "twitter_profile": { "username": "alice", ... },
    "nostr_profile": null,
    "is_cross_platform": false
  }
}
```

#### `GET /api/mentions/pins/:pinId/suggest-nostr`
Get Nostr profile suggestions based on existing cross-platform mappings.

**Response:**
```json
{
  "success": true,
  "pin": { ... },
  "suggestions": [
    {
      "npub": "npub1...",
      "nostrProfile": { ... },
      "confidence": 0.95,
      "usageCount": 45,
      "verificationMethod": "verified_link",
      "mappingId": "60f7b3b9e1b2c3d4e5f6a7b8"
    }
  ],
  "message": "Found 1 potential Nostr mapping(s)"
}
```

---

## 🔧 Implementation Details

### nprofile Generation for Post Creation

**🎯 Key Feature**: All profile lookups now automatically generate `nprofile` strings for seamless post creation.

#### What is nprofile?
- **NIP-19 encoded format** that includes pubkey + relay information
- **Used in Nostr posts** to create rich profile references (like mentions)
- **Example format**: `nprofile1qyxhwumn8ghj7mn0wvhxcmmvqywhwumn8ghj7mn0wd68yttsw43zuam9d3kx7unyv4ezumn9wsqzq7q8pqp9qg6mz0y0keaw4u6q7fxr8pzmy3cw0hw8asx5psqxsfj9w2rsvz`

#### Usage in Posts
When users create posts, they can now include nprofile references:

```
Great discussion with nostr:nprofile1qyxhwumn8ghj7... about Bitcoin!
```

This creates a clickable profile reference that Nostr clients can resolve to show user information and connect to their relays.

#### Automatic Generation
- **Relay Selection**: Uses up to 5 successful relays from the profile lookup
- **Fallback Handling**: If nprofile generation fails, lookup still succeeds (nprofile will be null)
- **Optimized Length**: Includes only essential relays to keep nprofile manageable

### NostrService Methods

#### `isValidNpub(npub)`
Validates npub format and structure.

```javascript
const nostrService = new NostrService();
console.log(nostrService.isValidNpub('npub1...')); // true/false
```

#### `npubToHex(npub)`
Converts npub to hexadecimal pubkey format.

```javascript
const hexPubkey = nostrService.npubToHex('npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m');
// Returns: "a0f67ac8f3a0c12d5e3b8f9a2c7d1e4f..."
```

#### `npubToNprofile(npub, relays?)`
Generates nprofile from npub and relay list.

```javascript
const relays = ['wss://relay.damus.io', 'wss://nos.lol'];
const nprofile = nostrService.npubToNprofile('npub1...', relays);
console.log('nprofile:', nprofile);
// Output: nprofile1qyxhwumn8ghj7mn0wvhxcmmvqywhwumn8ghj7mn0wd68yttsw43zuam9d3kx7unyv4ezumn9wsqzq7q8pqp9qg6mz0y0keaw4u6q7fxr8pzmy3cw0hw8asx5psqxsfj9w2rsvz
```

#### `encodeNprofile(hexPubkey, relays?)`
Lower-level method to encode nprofile from hex pubkey.

```javascript
const hexPubkey = 'a0f67ac8f3a0c12d5e3b8f9a2c7d1e4f...';
const relays = ['wss://relay.damus.io'];
const nprofile = nostrService.encodeNprofile(hexPubkey, relays);
```

#### `lookupProfile(npub, relays?)`
Queries Nostr relays for profile metadata (kind 0 events). **Now includes automatic nprofile generation**.

```javascript
const result = await nostrService.lookupProfile('npub1...');
if (result.success) {
  console.log('Profile found:', result.profile);
  console.log('Ready for posts:', result.profile.nprofile); // 🆕 nprofile included
} else {
  console.log('Profile not found:', result.message);
}
```

### Profile Data Structure

The returned Nostr profile follows this structure:

```typescript
interface NostrProfile {
  npub: string;                    // Original npub
  nprofile: string;                // 🆕 nprofile for post creation (includes relays)
  pubkey: string;                  // Hex pubkey
  name?: string;                   // Short name
  displayName?: string;            // Display name
  about?: string;                  // Bio/description
  picture?: string;                // Avatar URL
  banner?: string;                 // Banner image URL
  website?: string;                // Website URL
  lud16?: string;                  // Lightning address
  nip05?: string;                  // NIP-05 identifier
  created_at: number;              // Profile creation timestamp
  raw_content: string;             // Raw JSON content
}
```

### Updated Pin Structure

When a Nostr profile is linked to a pin, the pin structure is enhanced:

```typescript
interface EnhancedPin {
  id: string;
  twitter_profile?: TwitterProfile;
  nostr_profile?: NostrProfile;    // 🆕 Nostr profile data
  is_cross_platform: boolean;     // 🆕 True when both platforms linked
  updated_at: Date;                // 🆕 Last modification time
  // ... existing fields
}
```

---

## 🎯 User Workflows

### Workflow 1: Manual Profile Linking

1. **User has existing Twitter pin** (e.g., @alice)
2. **User obtains npub** (from Nostr client or direct communication)
3. **User calls link endpoint** with npub
4. **System validates npub** and looks up profile across relays
5. **Profile found** → Pin enhanced with Nostr data
6. **Pin becomes cross-platform** → Enables cross-posting

### Workflow 2: Suggested Mapping Discovery

1. **User views existing Twitter pin**
2. **User requests suggestions** via suggest endpoint
3. **System searches public mappings** for matching Twitter username
4. **Displays community-verified mappings** with confidence scores
5. **User selects mapping** → Profile automatically linked

### Workflow 3: Profile Management

1. **User views cross-platform pin**
2. **User wants to unlink** Nostr profile
3. **System removes Nostr data** while preserving Twitter data
4. **Pin reverts to Twitter-only** → Disables cross-posting

---

## 🧪 Testing

### Manual Testing Script

Run the test script to verify functionality:

```bash
cd /home/code-monster/Documents/GitHub/ptuj-backend
node test/test-nostr-profile-lookup.js
```

The script tests:
- ✅ npub validation
- ✅ npub to hex conversion  
- ✅ Live relay profile lookup
- ✅ Error handling

### Example Test Cases

#### Valid npubs for testing:
```
npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m
npub1sn0wdenkukak0d9dfczzeacvhkrgz92ak56egt7vdgzn8pv2wfqqhrjdv9
```

#### API Testing with curl:

```bash
# Test profile lookup
curl "http://localhost:4111/api/nostr/user/npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m"

# Test pin linking (requires authentication)
curl -X POST "http://localhost:4111/api/mentions/pins/pin_123/link-nostr" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"npub":"npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m"}'
```

---

## 🔍 Default Relay Configuration

The system queries these Nostr relays by default:

```javascript
const DEFAULT_RELAYS = [
  "wss://relay.primal.net",
  "wss://relay.damus.io", 
  "wss://nos.lol",
  "wss://relay.mostr.pub",
  "wss://nostr.land",
  "wss://purplerelay.com",
  "wss://relay.snort.social"
];
```

### Relay Performance Characteristics:
- **Query timeout**: 5 seconds per relay
- **Parallel querying**: All relays queried simultaneously
- **First success wins**: Returns first successful profile found
- **Graceful failures**: Individual relay failures don't break lookup

---

## 🚨 Error Handling

### Common Error Scenarios

#### Invalid npub Format
```json
{
  "error": "Invalid npub format",
  "message": "Please provide a valid npub (e.g., npub1...)"
}
```

#### Profile Not Found
```json
{
  "success": false,
  "error": "Nostr profile not found", 
  "message": "Profile not found on any relay",
  "stats": { "total": 7, "successful": 0, "failed": 7 },
  "failedRelays": [...]
}
```

#### Pin Not Found
```json
{
  "error": "Pin not found",
  "message": "Pin with id pin_123 not found"
}
```

### Handling Strategies

1. **Profile Not Found**: Normal - many npubs don't have metadata
2. **Relay Timeouts**: Expected - some relays may be slow/offline
3. **Invalid npub**: Validate format before API calls
4. **Authentication**: Ensure valid JWT token for pin operations

---

## 📈 Future Enhancements

### Planned Features
1. **Hex Pubkey Support**: Accept hex pubkeys in addition to npub
2. **Profile Caching**: Cache successful lookups to reduce relay queries
3. **Custom Relay Sets**: Allow users to specify preferred relays
4. **Bulk Operations**: Link multiple pins to Nostr profiles at once
5. **Profile Verification**: Enhanced verification methods for mappings

### Integration Opportunities
1. **Frontend UI**: Pin management interface with Nostr linking
2. **Cross-posting**: Use linked profiles for automated cross-posting
3. **Analytics**: Track cross-platform engagement and usage
4. **Discovery**: Help users find Nostr profiles for their Twitter follows

---

## 🔗 Related Documentation

- **[API Reference](./API_REFERENCE.md)** - Complete API documentation
- **[Frontend Guidelines](./FRONTEND_GUIDELINES.md)** - UI implementation guide
- **[Mention Mapping Lifecycle](./MENTION_MAPPING_LIFECYCLE.md)** - Overall system flow

---

*This Nostr integration enables powerful cross-platform functionality while maintaining the simplicity and user control of the personal pin system.*
