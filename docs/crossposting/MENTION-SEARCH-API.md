# Mention Search API - Frontend Integration Guide

## Overview

The mention search API provides unified social profile search across Twitter and Nostr platforms, with personal pinning and cross-platform mapping capabilities. This replaces the previous Twitter-only user lookup functionality.

**Available Endpoints:**
- `POST /api/mentions/search` - Traditional search (returns all results at once)
- `POST /api/mentions/search/stream` - **New!** Streaming search (Server-Sent Events)

## Traditional Search Endpoint

### Base Endpoint

```
POST /api/mentions/search
```

**Authentication**: Requires Bearer token via `Authorization` header

## Request Format

```json
{
  "query": "joe",
  "platforms": ["twitter", "nostr"],
  "includePersonalPins": true,
  "includeCrossPlatformMappings": true,
  "limit": 10
}
```

### Request Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | ✅ | - | Search term (1-50 characters) |
| `platforms` | array | ❌ | `["twitter"]` | Platforms to search: `"twitter"`, `"nostr"` |
| `includePersonalPins` | boolean | ❌ | `true` | Include user's saved pins |
| `includeCrossPlatformMappings` | boolean | ❌ | `true` | Show cross-platform mappings |
| `limit` | number | ❌ | `10` | Max results (1-50) |

## Response Format

```json
{
  "results": [
    {
      "platform": "twitter",
      "id": "217719095",
      "username": "joerogan",
      "name": "Joe Rogan",
      "verified": true,
      "verified_type": "blue",
      "profile_image_url": "https://pbs.twimg.com/profile_images/...",
      "description": "Comedian, UFC commentator, podcast host",
      "public_metrics": {
        "followers_count": 10500000,
        "following_count": 456,
        "tweet_count": 15234,
        "listed_count": 1205
      },
      "protected": false,
      "isPinned": false,
      "pinId": null,
      "lastUsed": null,
      "crossPlatformMapping": {
        "hasNostrMapping": true,
        "nostrNpub": "npub1abc123def456...",
        "nostrDisplayName": "Joe Rogan",
        "confidence": 0.95,
        "verificationMethod": "verified_link",
        "isAdopted": false,
        "mappingId": "6501234567890abcdef12345"
      }
    },
    {
      "platform": "nostr",
      "npub": "npub1xyz789abc123...",
      "displayName": "Joe Alternative",
      "nip05": "joe@nostr.social",
      "about": "Podcaster on Nostr",
      "picture": "https://...",
      "isPinned": true,
      "pinId": "pin_abc123",
      "lastUsed": "2024-01-15T10:30:00Z",
      "crossPlatformMapping": {
        "hasTwitterMapping": false
      }
    }
  ],
  "meta": {
    "totalResults": 2,
    "platforms": ["twitter", "nostr"],
    "searchTerm": "joe",
    "includePersonalPins": true,
    "includeCrossPlatformMappings": true
  }
}
```

### Response Fields

#### Twitter Results
| Field | Type | Description |
|-------|------|-------------|
| `platform` | string | Always `"twitter"` |
| `id` | string | Twitter user ID |
| `username` | string | Twitter handle (without @) |
| `name` | string | Display name |
| `verified` | boolean | Verification status |
| `verified_type` | string | `"blue"`, `"business"`, `"government"`, or `null` |
| `profile_image_url` | string | Profile picture URL |
| `description` | string | Bio text |
| `public_metrics` | object | Follower/following counts |
| `protected` | boolean | Account privacy status |

#### Nostr Results
| Field | Type | Description |
|-------|------|-------------|
| `platform` | string | Always `"nostr"` |
| `npub` | string | Nostr public key (bech32 format) |
| `displayName` | string | Display name |
| `nip05` | string | NIP-05 identifier (email-like) |
| `about` | string | Profile description |
| `picture` | string | Profile picture URL |

#### Universal Fields
| Field | Type | Description |
|-------|------|-------------|
| `isPinned` | boolean | User has pinned this profile |
| `pinId` | string\|null | Pin identifier for management |
| `lastUsed` | string\|null | ISO timestamp of last use |
| `crossPlatformMapping` | object | Cross-platform relationship data |

#### Cross-Platform Mapping Object
| Field | Type | Description |
|-------|------|-------------|
| `hasNostrMapping` | boolean | Twitter profile has Nostr mapping |
| `hasTwitterMapping` | boolean | Nostr profile has Twitter mapping |
| `nostrNpub` | string | Linked Nostr public key |
| `nostrDisplayName` | string | Nostr display name |
| `twitterUsername` | string | Linked Twitter handle |
| `twitterDisplayName` | string | Twitter display name |
| `confidence` | number | Mapping confidence (0.0-1.0) |
| `verificationMethod` | string | How mapping was verified |
| `isAdopted` | boolean | User has adopted this mapping |
| `mappingId` | string | Global mapping identifier |

## Frontend Implementation Examples

### React Hook

```javascript
import { useState, useCallback } from 'react';

export const useMentionSearch = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const searchMentions = useCallback(async (query, options = {}) => {
    if (!query?.trim()) {
      return [];
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/mentions/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getAuthToken()}`
        },
        body: JSON.stringify({
          query: query.trim(),
          platforms: options.platforms || ['twitter', 'nostr'],
          includePersonalPins: options.includePersonalPins ?? true,
          includeCrossPlatformMappings: options.includeCrossPlatformMappings ?? true,
          limit: options.limit || 10
        })
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = await response.json();
      return data.results || [];
    } catch (err) {
      setError(err.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  return { searchMentions, loading, error };
};
```

### Vue 3 Composition API

```javascript
import { ref } from 'vue';
import { useAuthStore } from '@/stores/auth';

export function useMentionSearch() {
  const loading = ref(false);
  const error = ref(null);
  const authStore = useAuthStore();

  const searchMentions = async (query, options = {}) => {
    if (!query?.trim()) {
      return [];
    }

    loading.value = true;
    error.value = null;

    try {
      const response = await fetch('/api/mentions/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authStore.token}`
        },
        body: JSON.stringify({
          query: query.trim(),
          platforms: options.platforms || ['twitter', 'nostr'],
          includePersonalPins: options.includePersonalPins ?? true,
          includeCrossPlatformMappings: options.includeCrossPlatformMappings ?? true,
          limit: options.limit || 10
        })
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = await response.json();
      return data.results || [];
    } catch (err) {
      error.value = err.message;
      return [];
    } finally {
      loading.value = false;
    }
  };

  return { searchMentions, loading, error };
}
```

### TypeScript Types

```typescript
interface MentionSearchRequest {
  query: string;
  platforms?: ('twitter' | 'nostr')[];
  includePersonalPins?: boolean;
  includeCrossPlatformMappings?: boolean;
  limit?: number;
}

interface TwitterResult {
  platform: 'twitter';
  id: string;
  username: string;
  name: string;
  verified: boolean;
  verified_type?: 'blue' | 'business' | 'government' | null;
  profile_image_url?: string;
  description?: string;
  public_metrics: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
    listed_count: number;
  };
  protected: boolean;
  isPinned: boolean;
  pinId?: string;
  lastUsed?: string;
  crossPlatformMapping?: {
    hasNostrMapping: boolean;
    nostrNpub?: string;
    nostrDisplayName?: string;
    confidence?: number;
    verificationMethod?: string;
    isAdopted?: boolean;
    mappingId?: string;
  };
}

interface NostrResult {
  platform: 'nostr';
  npub: string;
  displayName?: string;
  nip05?: string;
  about?: string;
  picture?: string;
  isPinned: boolean;
  pinId?: string;
  lastUsed?: string;
  crossPlatformMapping?: {
    hasTwitterMapping: boolean;
    twitterUsername?: string;
    twitterDisplayName?: string;
    confidence?: number;
    verificationMethod?: string;
    isAdopted?: boolean;
    mappingId?: string;
  };
}

type MentionResult = TwitterResult | NostrResult;

interface MentionSearchResponse {
  results: MentionResult[];
  meta: {
    totalResults: number;
    platforms: string[];
    searchTerm: string;
    includePersonalPins: boolean;
    includeCrossPlatformMappings: boolean;
  };
}
```

## Common Usage Patterns

### 1. Twitter-Only Search (Legacy Compatibility)

```javascript
const twitterUsers = await searchMentions('joe', {
  platforms: ['twitter'],
  includePersonalPins: false,
  includeCrossPlatformMappings: false
});
```

### 2. Cross-Platform Mention Picker

```javascript
const allMentions = await searchMentions('joe', {
  platforms: ['twitter', 'nostr'],
  includePersonalPins: true,
  includeCrossPlatformMappings: true
});

// Group by platform
const twitterResults = allMentions.filter(r => r.platform === 'twitter');
const nostrResults = allMentions.filter(r => r.platform === 'nostr');
```

### 3. Show Cross-Platform Mapping Indicators

```javascript
// Check if a Twitter user has Nostr mapping
const showNostrIcon = (twitterUser) => {
  return twitterUser.crossPlatformMapping?.hasNostrMapping;
};

// Get mapping confidence for UI display
const getMappingConfidence = (result) => {
  return result.crossPlatformMapping?.confidence || 0;
};
```

## Error Handling

### Common Error Responses

```json
{
  "error": "Invalid search query",
  "message": "Query must be between 1 and 50 characters",
  "code": "INVALID_QUERY_LENGTH"
}
```

```json
{
  "error": "Rate limit exceeded", 
  "message": "Please wait before searching again",
  "code": "RATE_LIMITED",
  "retryAfter": 60
}
```

```json
{
  "error": "Authentication required",
  "message": "Valid Bearer token required",
  "code": "UNAUTHORIZED"
}
```

### Error Handling Example

```javascript
try {
  const results = await searchMentions(query);
  // Handle success
} catch (error) {
  switch (error.code) {
    case 'INVALID_QUERY_LENGTH':
      showError('Search term must be 1-50 characters');
      break;
    case 'RATE_LIMITED':
      showError(`Rate limited. Try again in ${error.retryAfter} seconds`);
      break;
    case 'UNAUTHORIZED':
      redirectToLogin();
      break;
    default:
      showError('Search failed. Please try again.');
  }
}
```

---

## 🚀 Streaming Search Endpoint (New)

### Base Endpoint

```
POST /api/mentions/search/stream
```

**Authentication**: Requires Bearer token via `Authorization` header  
**Response Type**: Server-Sent Events (text/event-stream)

### Request Format

Same as traditional search endpoint:

```json
{
  "query": "joe",
  "platforms": ["twitter", "nostr"],
  "includePersonalPins": true,
  "includeCrossPlatformMappings": true,
  "limit": 10
}
```

### Server-Sent Events Response

The streaming endpoint sends multiple events as search results become available:

#### Event Types

1. **`partial`** - Results from a specific source
2. **`complete`** - All searches finished
3. **`error`** - Error from a specific source

#### Example Stream Response

```
event: data
data: {"type":"partial","source":"pins","results":[...],"meta":{"totalResults":2,"searchTerm":"joe","completedSources":["pins"]}}

event: data  
data: {"type":"partial","source":"twitter","results":[...],"meta":{"totalResults":1,"searchTerm":"joe","completedSources":["pins","twitter"]}}

event: data
data: {"type":"partial","source":"mappings","results":[],"meta":{"totalResults":0,"searchTerm":"joe","completedSources":["pins","twitter","mappings"]}}

event: complete
data: {"type":"complete","totalResults":3,"platforms":["twitter","nostr"],"searchTerm":"joe","includePersonalPins":true,"includeCrossPlatformMappings":true,"completedSources":["pins","twitter","mappings"]}
```

### Streaming Response Schema

#### Partial Event
```typescript
interface PartialEvent {
  type: 'partial';
  source: 'pins' | 'twitter' | 'mappings';
  results: MentionResult[];
  meta: {
    totalResults: number;
    searchTerm: string;
    completedSources: string[];
  };
}
```

#### Complete Event
```typescript
interface CompleteEvent {
  type: 'complete';
  totalResults: number;
  platforms: string[];
  searchTerm: string;
  includePersonalPins: boolean;
  includeCrossPlatformMappings: boolean;
  completedSources: string[];
}
```

#### Error Event
```typescript
interface ErrorEvent {
  type: 'error';
  source?: string;
  error: string;
  completedSources: string[];
}
```

### Frontend Implementation

#### Fetch API with ReadableStream
```javascript
async function streamSearch(query, options = {}) {
  const response = await fetch('/api/mentions/search/stream', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    },
    body: JSON.stringify({
      query,
      platforms: options.platforms || ['twitter', 'nostr'],
      includePersonalPins: options.includePersonalPins ?? true,
      includeCrossPlatformMappings: options.includeCrossPlatformMappings ?? true,
      limit: options.limit || 10
    })
  });

  if (!response.ok) {
    throw new Error(`Stream failed: ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          handleStreamEvent(data);
        } catch (e) {
          console.warn('Failed to parse SSE data:', line);
        }
      }
    }
  }
}

function handleStreamEvent(data) {
  switch (data.type) {
    case 'partial':
      onPartialResults(data.source, data.results);
      break;
    case 'complete':
      onSearchComplete(data);
      break;
    case 'error':
      onSourceError(data.source, data.error);
      break;
  }
}
```

#### React Hook Example
```javascript
const useStreamingSearch = () => {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [completedSources, setCompletedSources] = useState([]);

  const streamSearch = useCallback(async (query, options) => {
    setLoading(true);
    setResults([]);
    setCompletedSources([]);

    try {
      await streamSearch(query, {
        ...options,
        onPartialResults: (source, newResults) => {
          setResults(prev => {
            if (source === 'pins') {
              return [...prev, ...newResults];
            }
            if (source === 'twitter') {
              // Merge with existing pins data
              const merged = [...prev];
              newResults.forEach(twitterResult => {
                const existingIndex = merged.findIndex(r => 
                  r.platform === 'twitter' && 
                  r.username.toLowerCase() === twitterResult.username.toLowerCase()
                );
                if (existingIndex >= 0) {
                  merged[existingIndex] = twitterResult;
                } else {
                  merged.push(twitterResult);
                }
              });
              return merged;
            }
            return [...prev, ...newResults];
          });
        },
        onSearchComplete: (data) => {
          setLoading(false);
          setCompletedSources(data.completedSources);
        },
        onSourceError: (source, error) => {
          console.warn(`Search source ${source} failed:`, error);
        }
      });
    } catch (error) {
      setLoading(false);
      console.error('Stream search failed:', error);
    }
  }, []);

  return { results, loading, completedSources, streamSearch };
};
```

### Performance Benefits

- **200-500ms faster perceived response time**
- **Personal pins appear immediately** (~50-100ms)
- **Twitter results stream as API responds** (~300-500ms)
- **Resilient to individual source failures**
- **Better user experience** with progressive loading

### When to Use Streaming vs Traditional

#### Use Streaming Search For:
- Interactive search interfaces (search-as-you-type)
- User-facing search pages where speed matters
- When personal pins are important (show immediately)
- Large result sets where partial loading helps

#### Use Traditional Search For:
- Background/automated searches
- Simple one-off lookups  
- When you need all results at once
- Integration with non-streaming systems

```