# API Reference
## Cross-Platform Mention Mapping System

### Base URL
```
/api/mentions
```

### Authentication
All endpoints require authentication via JWT token in the Authorization header:
```
Authorization: Bearer <your_jwt_token>
```

---

## 🔍 Search Endpoints

### POST `/search`
Search for mentions across platforms including personal pins and cross-platform mappings.

**Request Body:**
```json
{
  "query": "username or @username"
}
```

**Response:**
```json
{
  "results": [
    {
      "type": "twitter_user",
      "platform": "twitter",
      "username": "username",
      "displayName": "Display Name",
      "avatar": "https://...",
      "confidence": null,
      "isPersonalPin": false
    },
    {
      "type": "cross_mapping",
      "platform": "twitter",
      "username": "username",
      "targetPlatform": "nostr",
      "targetUsername": "nostr_username",
      "confidence": 85,
      "isPersonalPin": false
    },
    {
      "type": "personal_pin",
      "platform": "twitter",
      "username": "username",
      "targetPlatform": "nostr",
      "targetUsername": "my_nostr_username",
      "notes": "Personal note",
      "usageCount": 5,
      "isPersonalPin": true
    }
  ]
}
```

### POST `/search/stream` 🚀 **New!**
Streaming search using Server-Sent Events for real-time results as they become available.

**Request Body:**
```json
{
  "query": "username or @username",
  "platforms": ["twitter", "nostr"],
  "includePersonalPins": true,
  "includeCrossPlatformMappings": true,
  "limit": 10
}
```

**Response Type:** `text/event-stream`

**Stream Events:**
```
event: data
data: {"type":"partial","source":"pins","results":[...],"meta":{...}}

event: data
data: {"type":"partial","source":"twitter","results":[...],"meta":{...}}

event: complete
data: {"type":"complete","totalResults":3,"completedSources":[...]}
```

**Performance Benefits:**
- Personal pins appear immediately (~50-100ms)
- Twitter results stream as API responds (~300-500ms)  
- Individual source failures don't break entire search
- 200-500ms faster perceived response time

---

## 📌 Personal Pin Management

### GET `/pins`
Fetch all personal pins for the authenticated user.

**Response:**
```json
{
  "pins": [
    {
      "id": "pin_1234567890_abc123",
      "platform": "twitter",
      "username": "username",
      "targetPlatform": "nostr",
      "targetUsername": "nostr_username",
      "notes": "Personal note about this mapping",
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z",
      "usageCount": 3
    }
  ]
}
```

### POST `/pins`
Create a new personal pin or update existing one (upsert behavior).

**Request Body:**
```json
{
  "platform": "twitter",
  "username": "username",
  "targetPlatform": "nostr",
  "targetUsername": "nostr_username",
  "notes": "Optional personal note"
}
```

**Response:**
```json
{
  "pin": {
    "id": "pin_1234567890_abc123",
    "platform": "twitter",
    "username": "username",
    "targetPlatform": "nostr",
    "targetUsername": "nostr_username",
    "notes": "Optional personal note",
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z",
    "usageCount": 0
  },
  "message": "Pin created"
}
```

### PUT `/pins/:pinId`
Update an existing personal pin.

**Request Body:**
```json
{
  "targetPlatform": "mastodon",
  "targetUsername": "mastodon_username",
  "notes": "Updated note"
}
```

**Response:**
```json
{
  "pin": {
    "id": "pin_1234567890_abc123",
    "platform": "twitter",
    "username": "username",
    "targetPlatform": "mastodon",
    "targetUsername": "mastodon_username",
    "notes": "Updated note",
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T11:00:00Z",
    "usageCount": 3
  },
  "message": "Pin updated successfully"
}
```

### DELETE `/pins/:pinId`
Delete a personal pin.

**Response:**
```json
{
  "message": "Personal pin deleted successfully"
}
```

---

## 📊 Data Types

### PersonalPin
```typescript
interface PersonalPin {
  id: string;                    // Unique identifier
  platform: string;              // Source platform (twitter, nostr, etc.)
  username: string;              // Source username
  targetPlatform: string;        // Target platform
  targetUsername: string;        // Target username
  notes?: string;                // Optional user notes
  createdAt: string;             // ISO date string
  updatedAt: string;             // ISO date string
  usageCount: number;            // Number of times used
}
```

### SearchResult
```typescript
interface SearchResult {
  type: 'twitter_user' | 'nostr_user' | 'cross_mapping' | 'personal_pin';
  platform: string;              // Source platform
  username: string;              // Source username
  displayName?: string;          // Display name (if available)
  avatar?: string;               // Avatar URL (if available)
  confidence?: number;           // Confidence score (0-100, for mappings)
  targetPlatform?: string;       // Target platform (for mappings)
  targetUsername?: string;       // Target username (for mappings)
  isPersonalPin?: boolean;       // Whether this is a personal pin
  usageCount?: number;           // Usage count (for personal pins)
  notes?: string;                // Notes (for personal pins)
}
```

---

## 🔧 Error Handling

### Error Response Format
```json
{
  "error": "Error type",
  "details": "Detailed error message"
}
```

### Common HTTP Status Codes
- `200` - Success
- `201` - Created
- `400` - Bad Request (validation errors)
- `401` - Unauthorized (authentication required)
- `404` - Not Found
- `500` - Internal Server Error

### Validation Errors
```json
{
  "error": "Validation failed",
  "details": "Missing required fields: platform, username, targetPlatform, targetUsername"
}
```

---

## 🚀 Usage Examples

### JavaScript/TypeScript

#### Fetch Personal Pins
```javascript
const fetchPins = async () => {
  const response = await fetch('/api/mentions/pins', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error('Failed to fetch pins');
  }
  
  const data = await response.json();
  return data.pins;
};
```

#### Create Personal Pin
```javascript
const createPin = async (pinData) => {
  const response = await fetch('/api/mentions/pins', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(pinData)
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.details);
  }
  
  return await response.json();
};
```

#### Search Mentions
```javascript
const searchMentions = async (query) => {
  const response = await fetch('/api/mentions/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query })
  });
  
  if (!response.ok) {
    throw new Error('Search failed');
  }
  
  const data = await response.json();
  return data.results;
};
```

### React Hook Example
```javascript
const usePersonalPins = () => {
  const [pins, setPins] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchPins = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/mentions/pins', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      setPins(data.pins);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const createPin = async (pinData) => {
    try {
      const response = await fetch('/api/mentions/pins', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(pinData)
      });
      const data = await response.json();
      setPins(prev => [...prev, data.pin]);
      return data.pin;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  };

  return { pins, loading, error, fetchPins, createPin };
};
```

---

## 🔍 Platform Support

### Supported Platforms
- `twitter` - Twitter/X
- `nostr` - Nostr protocol
- `mastodon` - Mastodon
- `bluesky` - Bluesky Social

### Platform-Specific Notes
- **Twitter**: Usernames are case-insensitive
- **Nostr**: Uses public keys or npub identifiers
- **Mastodon**: Includes instance domain in username
- **Bluesky**: Uses handle format (username.bsky.social)

---

## 📝 Development Notes

### Development Mode
Set environment variable for development bypass:
```bash
BYPASS_PODCAST_ADMIN_AUTH=bypass
```

### Rate Limiting
- Search: 100 requests per minute per user
- Pin operations: 60 requests per minute per user

### Caching Recommendations
- Personal pins: Cache for 10 minutes
- Search results: Cache for 5 minutes
- User profile: Cache for 30 minutes

---

*For detailed implementation guidelines, see `FRONTEND_GUIDELINES.md`* 