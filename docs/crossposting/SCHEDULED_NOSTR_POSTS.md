# Scheduled Nostr Posts - Frontend Integration

## Overview
When creating a scheduled Nostr post, the frontend must generate and sign the Nostr event before sending it to the backend. The backend validates the signature and only returns 200 if validation succeeds.

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

### 1. Generate Event
```javascript
const createNostrEvent = (content) => {
  const event = {
    kind: 1, // text note
    created_at: Math.floor(Date.now() / 1000),
    content: content.text,
    tags: []
  };
  
  if (content.mediaUrl) {
    event.tags.push(['r', content.mediaUrl]);
  }
  
  return event;
};
```

### 2. Sign Event
```javascript
const signNostrEvent = async (event, privateKey) => {
  // Use nostr-tools or similar library
  const signedEvent = await window.nostr.signEvent(event);
  return signedEvent;
};
```

### 3. Submit Post
```javascript
const submitNostrPost = async (formData) => {
  const event = createNostrEvent(formData.content);
  const signedEvent = await signNostrEvent(event, formData.privateKey);
  
  const postData = {
    adminEmail: formData.adminEmail,
    platform: 'nostr',
    scheduledFor: formData.scheduledFor,
    timezone: formData.timezone,
    content: formData.content,
    platformData: {
      nostrEventId: signedEvent.id,
      nostrSignature: signedEvent.sig,
      nostrPubkey: signedEvent.pubkey,
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
