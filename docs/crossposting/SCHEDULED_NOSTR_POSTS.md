# Scheduled Nostr Posts - Frontend Integration

## Overview
When creating a scheduled Nostr post, the frontend must generate and sign the Nostr event before sending it to the backend. The backend will reconstruct the exact same event structure to ensure signature validity.

## Required Form Fields

### Basic Post
- **Text Content**: Post text (max 2000 chars)
- **Media URL** (optional): CDN URL for media
- **Scheduled Date/Time**: When to post
- **Platform**: Set to "nostr"

### Nostr Fields
- **Public Key**: User's npub1...
- **Private Key**: User's nsec1... (for signing)
- **Relays** (optional): Preferred relay URLs

## Implementation

### 1. Content Assembly
```javascript
const buildFinalContent = (baseContent, mediaUrl, platform) => {
  const signature = getUserSignature(); // from localStorage
  const signaturePart = signature ? `\n\n${signature}` : '';
  const mediaUrlPart = platform === 'nostr' ? `\n\n${mediaUrl}` : '';
  const callToActionPart = platform === 'nostr' ? `\n\nShared via https://pullthatupjamie.ai` : '';
  
  return `${baseContent}${signaturePart}${mediaUrlPart}${callToActionPart}`;
};
```

### 2. Generate Event
```javascript
const createNostrEvent = (content) => {
  const event = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content: buildFinalContent(content.text, content.mediaUrl, 'nostr'),
    tags: [] // Must be empty array for signature to match
  };
  
  return event;
};
```

### 3. Sign Event
```javascript
const signNostrEvent = async (event, privateKey) => {
  // Use nostr-tools or similar library
  const signedEvent = await window.nostr.signEvent(event);
  return signedEvent;
};
```

### 4. Submit Post
```javascript
const submitNostrPost = async (formData) => {
  // Build final content with media URL embedded in text
  const finalContent = buildFinalContent(
    formData.content.text,
    formData.content.mediaUrl,
    'nostr'
  );
  
  // Create and sign event
  const event = createNostrEvent({ text: finalContent });
  const signedEvent = await signNostrEvent(event, formData.privateKey);
  
  const postData = {
    adminEmail: formData.adminEmail,
    platform: 'nostr',
    scheduledFor: formData.scheduledFor,
    timezone: formData.timezone,
    content: {
      text: finalContent, // Contains media URL and signature in text
      mediaUrl: formData.content.mediaUrl // For reference only
    },
    platformData: {
      nostrEventId: signedEvent.id,
      nostrSignature: signedEvent.sig,
      nostrPubkey: signedEvent.pubkey,
      nostrCreatedAt: signedEvent.created_at, // Store original timestamp
      nostrRelays: formData.relays || []
    }
  };
  
  const response = await fetch('/api/social-posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(postData)
  });
  
  if (response.status === 200) {
    return await response.json(); // Success
  } else {
    throw new Error('Signature validation failed');
  }
};
```

## Backend Event Structure
The backend must use the exact event structure to maintain signature validity:

```javascript
const eventToPublish = {
  id: post.platformData.nostrEventId,
  pubkey: post.platformData.nostrPubkey,
  created_at: post.platformData.nostrCreatedAt, // Must use original timestamp
  kind: 1,
  tags: [], // Must be empty array
  content: post.content.text, // Use exact content from frontend
  sig: post.platformData.nostrSignature
};
```

## Content Format
The content field follows this exact structure:
```
{userText}

{optionalSignature}

{mediaUrl}

Shared via https://pullthatupjamie.ai
```

## Backend Response

### Success (200)
```json
{
  "success": true,
  "message": "Nostr post scheduled successfully",
  "post": { "_id": "post_id", "status": "scheduled" }
}
```

### Validation Error (400)
```json
{
  "success": false,
  "error": "Invalid Nostr signature"
}
```

## Security Notes
- Never store private keys in localStorage
- Clear private key from memory after signing
- Consider using browser extensions for key management
- Validate npub1/nsec1 format before submission
- Ensure exact event reconstruction to maintain signature validity