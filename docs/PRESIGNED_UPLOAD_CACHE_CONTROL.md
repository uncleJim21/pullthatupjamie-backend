# Presigned Upload URLs - Cache-Control Support

## Overview

The `/api/generate-presigned-url` endpoint now supports an optional `cacheControl` parameter that enables long-term browser caching for uploaded files.

## API Changes

### Request Body

Add an optional `cacheControl` parameter to your request:

```json
{
  "fileName": "video.mp4",
  "fileType": "video/mp4",
  "acl": "public-read",
  "cacheControl": true
}
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cacheControl` | `boolean` or `string` | `false` | Enable Cache-Control header on uploaded files |

**Values:**
- `false` (default): No Cache-Control header
- `true`: Uses default: `public, max-age=31536000, immutable` (1 year, immutable)
- `string`: Custom Cache-Control value (e.g., `"public, max-age=86400"`)

### Response

The response now includes the `cacheControl` value:

```json
{
  "uploadUrl": "https://...",
  "key": "jamie-pro/12345/uploads/...",
  "feedId": "12345",
  "publicUrl": "https://...",
  "maxSizeBytes": 104857600,
  "maxSizeMB": 100,
  "cacheControl": true
}
```

## **Critical Implementation Requirement**

⚠️ **When `cacheControl` is enabled, you MUST include the `Cache-Control` header in your upload request.**

If you don't include this header, the upload will fail with a signature mismatch error.

## Client-Side Implementation

### Example: Upload with Cache-Control

```javascript
// 1. Request presigned URL with cacheControl enabled
const response = await fetch('/api/generate-presigned-url', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN'
  },
  body: JSON.stringify({
    fileName: 'video.mp4',
    fileType: 'video/mp4',
    cacheControl: true  // Enable long-term caching
  })
});

const { uploadUrl, publicUrl, cacheControl } = await response.json();

// 2. Upload file to presigned URL
// IMPORTANT: Include Cache-Control header if cacheControl is enabled
const uploadHeaders = {
  'Content-Type': 'video/mp4'
};

if (cacheControl) {
  // Use the default value or custom string if provided
  const cacheControlValue = typeof cacheControl === 'string' 
    ? cacheControl 
    : 'public, max-age=31536000, immutable';
  
  uploadHeaders['Cache-Control'] = cacheControlValue;
}

const uploadResponse = await fetch(uploadUrl, {
  method: 'PUT',
  headers: uploadHeaders,
  body: fileBlob
});

if (uploadResponse.ok) {
  console.log('File uploaded successfully!');
  console.log('Public URL:', publicUrl);
}
```

### Example: Upload without Cache-Control (default)

```javascript
// 1. Request presigned URL (cacheControl defaults to false)
const response = await fetch('/api/generate-presigned-url', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN'
  },
  body: JSON.stringify({
    fileName: 'video.mp4',
    fileType: 'video/mp4'
  })
});

const { uploadUrl, publicUrl } = await response.json();

// 2. Upload file - no Cache-Control header needed
const uploadResponse = await fetch(uploadUrl, {
  method: 'PUT',
  headers: {
    'Content-Type': 'video/mp4'
  },
  body: fileBlob
});
```

## Use Cases

### When to use `cacheControl: true`

✅ **Good for:**
- Final/published videos that won't change
- Profile images
- Thumbnail images
- Audio files for published episodes
- Any immutable content

### When to use `cacheControl: false`

✅ **Good for:**
- Files that might be updated/replaced
- Temporary uploads
- Work-in-progress content
- Files where you need immediate updates to be visible

## Benefits

When enabled with the default value (`public, max-age=31536000, immutable`):

- **Performance**: Browsers cache files for 1 year
- **Bandwidth**: Reduces repeated downloads
- **CDN Efficiency**: CloudFront/CDN can cache aggressively
- **User Experience**: Faster subsequent page loads
- **Immutable Flag**: Tells browsers the file will never change at this URL

## Testing

```bash
# After uploading with cacheControl: true, check headers:
curl -I https://your-bucket.endpoint.com/path/to/file.mp4

# Should see:
# Cache-Control: public, max-age=31536000, immutable
```

## Notes

1. The default cache duration is 1 year (31,536,000 seconds)
2. Files cached with `immutable` flag won't be revalidated during cache lifetime
3. If you need to update a file, upload it with a new filename/path
4. This is backward compatible - existing code will continue to work without changes

