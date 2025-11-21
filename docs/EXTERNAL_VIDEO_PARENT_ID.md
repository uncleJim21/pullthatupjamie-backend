# External Video Parent ID Algorithm

## Overview

When editing videos from external sources (e.g., Fountain, Transistor, etc.), the system needs a stable identifier to group related edits together. Since external URLs don't follow our internal naming conventions, we use a deterministic hash-based approach.

## The Algorithm

The `parentFileBase` identifier is calculated as follows:

### For Our Own CDN URLs
```
parentFileBase = last part of URL path with extension removed
```

**Example:**
```
URL: https://bucket.nyc3.digitaloceanspaces.com/jamie-pro/12345/uploads/1234567890-video.mp4
parentFileBase: "1234567890-video"
```

### For External URLs
```
1. Remove query parameters from URL
2. Calculate MD5 hash of the cleaned URL
3. Take first 16 characters of the hex digest
4. Prefix with "ext-"
parentFileBase = "ext-" + md5(urlWithoutQuery).substring(0, 16)
```

**Example:**
```javascript
// Input URL
const cdnUrl = "https://feeds.fountain.fm/VV0f6IwusQoi5kOqvNCx/items/gHzZt9swuX3zVN6Jf6Tz/files/VIDEO---DEFAULT---3732dfff-8e4a-43a7-81e7-9d46bdb0eac0.mp4/playlist.m3u8";

// Step 1: Remove query params (none in this case)
const urlWithoutQuery = cdnUrl.split('?')[0];

// Step 2: Calculate MD5 hash
const hash = md5(urlWithoutQuery); // e.g., "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"

// Step 3: Take first 16 chars
const shortHash = hash.substring(0, 16); // "a1b2c3d4e5f6g7h8"

// Step 4: Add prefix
const parentFileBase = "ext-" + shortHash; // "ext-a1b2c3d4e5f6g7h8"
```

## Frontend Implementation

The frontend can independently calculate this identifier before making API calls.

### JavaScript Example

```javascript
import CryptoJS from 'crypto-js'; // or use native crypto in Node.js

function calculateParentFileBase(cdnUrl) {
  // Parse URL to check if it's our CDN
  const isOurCdn = cdnUrl.includes(process.env.YOUR_CDN_DOMAIN); // Configure your CDN domain
  
  if (isOurCdn) {
    // Extract filename from our CDN
    const urlParts = cdnUrl.split('/');
    const filename = urlParts[urlParts.length - 1];
    return filename.replace(/\.[^/.]+$/, ''); // Remove extension
  } else {
    // Hash external URL
    const urlWithoutQuery = cdnUrl.split('?')[0];
    const hash = CryptoJS.MD5(urlWithoutQuery).toString();
    return 'ext-' + hash.substring(0, 16);
  }
}

// Usage
const cdnUrl = "https://feeds.fountain.fm/.../playlist.m3u8";
const parentFileBase = calculateParentFileBase(cdnUrl);

// Now you can query for children without waiting for backend response
fetch(`/api/edit-children/${encodeURIComponent(parentFileBase)}`, {
  headers: { Authorization: `Bearer ${token}` }
});
```

### TypeScript Example

```typescript
import CryptoJS from 'crypto-js';

interface CDNConfig {
  ownDomains: string[];
}

export function calculateParentFileBase(
  cdnUrl: string, 
  config: CDNConfig
): string {
  // Check if it's our own CDN
  const isOurCdn = config.ownDomains.some(domain => cdnUrl.includes(domain));
  
  if (isOurCdn) {
    // Extract filename from our CDN
    const urlParts = cdnUrl.split('/');
    const filename = urlParts[urlParts.length - 1];
    return filename.replace(/\.[^/.]+$/, ''); // Remove extension
  } else {
    // Hash external URL (deterministic)
    const urlWithoutQuery = cdnUrl.split('?')[0];
    const hash = CryptoJS.MD5(urlWithoutQuery).toString();
    return 'ext-' + hash.substring(0, 16);
  }
}

// Usage example
const config = {
  ownDomains: [
    'cascdr-chads-stay-winning.nyc3.digitaloceanspaces.com',
    // Add other CDN domains
  ]
};

const fountainUrl = "https://feeds.fountain.fm/VV0f6IwusQoi5kOqvNCx/items/gHzZt9swuX3zVN6Jf6Tz/files/VIDEO---DEFAULT---3732dfff-8e4a-43a7-81e7-9d46bdb0eac0.mp4/playlist.m3u8";

const parentFileBase = calculateParentFileBase(fountainUrl, config);
// Result: "ext-" + first 16 chars of MD5 hash

// Query for related edits
const response = await fetch(
  `/api/edit-children/${encodeURIComponent(parentFileBase)}`,
  {
    headers: { 
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }
);

const data = await response.json();
console.log(`Found ${data.childCount} related edits`);
```

### React Hook Example

```typescript
import { useState, useEffect } from 'react';
import CryptoJS from 'crypto-js';

function useVideoChildren(cdnUrl: string, token: string) {
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    async function fetchChildren() {
      setLoading(true);
      
      // Calculate parentFileBase deterministically
      const parentFileBase = calculateParentFileBase(cdnUrl, config);
      
      try {
        const response = await fetch(
          `/api/edit-children/${encodeURIComponent(parentFileBase)}`,
          {
            headers: { 
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          }
        );
        
        const data = await response.json();
        setChildren(data.children || []);
      } catch (error) {
        console.error('Failed to fetch children:', error);
      } finally {
        setLoading(false);
      }
    }
    
    fetchChildren();
  }, [cdnUrl, token]);
  
  return { children, loading };
}
```

## Why This Approach?

1. **Deterministic**: Same input URL always produces same identifier
2. **Frontend Independence**: No need to wait for backend response
3. **Stable**: URL hash doesn't change, so all edits group correctly
4. **Collision-Resistant**: MD5 provides good distribution (16 chars = 64 bits)
5. **Clean**: Prefix makes it clear it's an external source

## API Workflow

### Creating an Edit

```javascript
// 1. Calculate parentFileBase upfront
const parentFileBase = calculateParentFileBase(cdnUrl, config);

// 2. Create the edit
const editResponse = await fetch('/api/edit-video', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    cdnUrl,
    startTime: 3094,
    endTime: 3173,
    useSubtitles: true
  })
});

const { lookupHash, pollUrl } = await editResponse.json();

// 3. Poll for status
const statusResponse = await fetch(pollUrl, {
  headers: { 'Authorization': `Bearer ${token}` }
});

// 4. Fetch all related children (can do this anytime)
const childrenResponse = await fetch(
  `/api/edit-children/${encodeURIComponent(parentFileBase)}`,
  { headers: { 'Authorization': `Bearer ${token}` } }
);

const { children, childCount } = await childrenResponse.json();
```

## Important Notes

1. **URL Normalization**: Query parameters are removed before hashing, so:
   - `https://example.com/video.mp4?token=123` and 
   - `https://example.com/video.mp4?token=456`
   
   Both produce the same `parentFileBase`

2. **Case Sensitivity**: The algorithm is case-sensitive, so ensure consistent URL casing

3. **Backend Compatibility**: The backend uses the exact same algorithm, so frontend calculations will always match

## Testing

```javascript
// Test cases
const testCases = [
  {
    input: "https://feeds.fountain.fm/path/to/video.m3u8",
    expected: "ext-" + md5("https://feeds.fountain.fm/path/to/video.m3u8").substring(0, 16)
  },
  {
    input: "https://your-bucket.nyc3.digitaloceanspaces.com/jamie-pro/123/uploads/file.mp4",
    expected: "file" // Our CDN - just filename without extension
  }
];

testCases.forEach(test => {
  const result = calculateParentFileBase(test.input, config);
  console.assert(result === test.expected, `Failed for ${test.input}`);
});
```

## Summary

**For client-side developers:**
1. Implement the `calculateParentFileBase()` function
2. Use it to query `/api/edit-children/:parentFileBase` at any time
3. No need to wait for edit creation response
4. All edits from the same source URL will be grouped together

