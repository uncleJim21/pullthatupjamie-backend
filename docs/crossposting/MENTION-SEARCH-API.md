# Mention Search API - Frontend Integration Guide

## Overview

The new mention search API provides unified social profile search across Twitter and Nostr platforms, with personal pinning and cross-platform mapping capabilities. This replaces the previous Twitter-only user lookup functionality.

## Base Endpoint

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

## Best Practices

### 1. Debounced Search

```javascript
import { useDebouncedCallback } from 'use-debounce';

const debouncedSearch = useDebouncedCallback(
  (query) => searchMentions(query),
  300 // 300ms delay
);
```

### 2. Caching Results

```javascript
const searchCache = new Map();

const searchWithCache = async (query, options) => {
  const cacheKey = JSON.stringify({ query, options });
  
  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey);
  }
  
  const results = await searchMentions(query, options);
  searchCache.set(cacheKey, results);
  
  return results;
};
```

### 3. Progressive Enhancement

```javascript
// Start with Twitter-only, then enable cross-platform
const [platforms, setPlatforms] = useState(['twitter']);

useEffect(() => {
  // Enable Nostr after initial load
  setPlatforms(['twitter', 'nostr']);
}, []);
```

### 4. UI Indicators

```javascript
const MentionResult = ({ result }) => (
  <div className="mention-result">
    <img src={result.profile_image_url || result.picture} />
    <div>
      <span>{result.name || result.displayName}</span>
      <span>@{result.username || result.npub.slice(0, 16)}...</span>
      
      {/* Show pin indicator */}
      {result.isPinned && <PinIcon />}
      
      {/* Show cross-platform mapping */}
      {result.crossPlatformMapping?.hasNostrMapping && <NostrIcon />}
      {result.crossPlatformMapping?.hasTwitterMapping && <TwitterIcon />}
    </div>
  </div>
);
```

## Migration Checklist

- [ ] Update API endpoint from `/api/twitter/users/lookup` to `/api/mentions/search`
- [ ] Update request format from `{ usernames: [] }` to `{ query: "", platforms: [] }`
- [ ] Update response handling to use `results` array instead of `data`
- [ ] Add TypeScript types for new response format
- [ ] Implement cross-platform mapping indicators in UI
- [ ] Add support for pinned mentions display
- [ ] Update error handling for new error codes
- [ ] Test with both Twitter and Nostr platforms
- [ ] Implement debounced search for better UX
- [ ] Add loading states for search operations 