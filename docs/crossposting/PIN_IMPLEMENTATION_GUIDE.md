# Personal Pins Implementation Guide
## Step 3: Cross-Platform Mention Mapping

### 🎯 Overview
Personal pins allow users to create mappings between Twitter and Nostr profiles.

---

## 📋 API Reference

### Authentication
All endpoints require JWT token in header:
```
Authorization: Bearer <token>
```

### Routes

#### `GET /api/mentions/pins`
Fetch user's personal pins.

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
      "notes": "Personal note",
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z",
      "usageCount": 3
    }
  ]
}
```

#### `POST /api/mentions/pins`
Create or update personal pin (upsert behavior).

**Request:**
```json
{
  "platform": "twitter",
  "username": "username",
  "targetPlatform": "nostr",
  "targetUsername": "nostr_username",
  "notes": "Optional note"
}
```

#### `PUT /api/mentions/pins/:pinId`
Update specific pin.

**Request:**
```json
{
  "targetPlatform": "nostr",
  "targetUsername": "new_nostr_username",
  "notes": "Updated note"
}
```

#### `DELETE /api/mentions/pins/:pinId`
Delete personal pin.

#### `POST /api/mentions/search`
Search for mentions with personal pin flags.

**Request:**
```json
{
  "query": "username",
  "platforms": ["twitter", "nostr"],
  "includePersonalPins": true
}
```

**Response with Personal Pin Flags:**
```json
{
  "results": [
    {
      "platform": "twitter",
      "username": "username",
      "name": "Display Name",
      "profile_image_url": "https://...",
      "isPersonalPin": true,
      "personalPin": {
        "id": "pin_1234567890_abc123",
        "targetPlatform": "nostr",
        "targetUsername": "nostr_username",
        "notes": "Personal note",
        "usageCount": 3
      }
    },
    {
      "platform": "twitter", 
      "username": "other_user",
      "name": "Other User",
      "isPersonalPin": false,
      "personalPin": null
    }
  ]
}
```

---

## 🚀 Frontend Implementation

### Services Layer

```javascript
// services/pinService.js
const API_BASE = '/api/mentions';

export const pinService = {
  async getPins() {
    const response = await fetch(`${API_BASE}/pins`, {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });
    const data = await response.json();
    return data.pins;
  },

  async createPin(pinData) {
    const response = await fetch(`${API_BASE}/pins`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pinData)
    });
    const data = await response.json();
    return data.pin;
  },

  async updatePin(pinId, updates) {
    const response = await fetch(`${API_BASE}/pins/${pinId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    });
    const data = await response.json();
    return data.pin;
  },

  async deletePin(pinId) {
    await fetch(`${API_BASE}/pins/${pinId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });
  },

  async searchMentions(query) {
    const response = await fetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query,
        platforms: ['twitter', 'nostr'],
        includePersonalPins: true
      })
    });
    const data = await response.json();
    return data.results;
  }
};
```

### React Components

```jsx
// components/PinManagement.jsx
import { useState, useEffect } from 'react';
import { pinService } from '../services/pinService';

export function PinManagement() {
  const [pins, setPins] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadPins();
  }, []);

  const loadPins = async () => {
    setLoading(true);
    try {
      const pins = await pinService.getPins();
      setPins(pins);
    } catch (error) {
      console.error('Failed to load pins:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePin = async (pinData) => {
    try {
      await pinService.createPin(pinData);
      loadPins();
    } catch (error) {
      console.error('Failed to create pin:', error);
    }
  };

  const handleUpdatePin = async (pinId, updates) => {
    try {
      await pinService.updatePin(pinId, updates);
      loadPins();
    } catch (error) {
      console.error('Failed to update pin:', error);
    }
  };

  const handleDeletePin = async (pinId) => {
    if (!confirm('Delete this pin?')) return;
    try {
      await pinService.deletePin(pinId);
      loadPins();
    } catch (error) {
      console.error('Failed to delete pin:', error);
    }
  };

  return (
    <div>
      <h1>Personal Pins</h1>
      {loading ? (
        <div>Loading...</div>
      ) : (
        <div>
          {pins.map(pin => (
            <PinCard
              key={pin.id}
              pin={pin}
              onUpdate={handleUpdatePin}
              onDelete={handleDeletePin}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

```jsx
// components/PinCard.jsx
export function PinCard({ pin, onUpdate, onDelete }) {
  return (
    <div className="pin-card">
      <div>
        <span>{pin.platform}</span>
        <span>@{pin.username}</span>
        <span>→</span>
        <span>{pin.targetPlatform}</span>
        <span>@{pin.targetUsername}</span>
      </div>
      {pin.notes && <div>{pin.notes}</div>}
      <div>
        <span>Used {pin.usageCount} times</span>
        <button onClick={() => onUpdate(pin.id, {})}>Edit</button>
        <button onClick={() => onDelete(pin.id)}>Delete</button>
      </div>
    </div>
  );
}
```

```jsx
// components/PinForm.jsx
import { useState } from 'react';

export function PinForm({ pin, onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    platform: pin?.platform || 'twitter',
    username: pin?.username || '',
    targetPlatform: pin?.targetPlatform || 'nostr',
    targetUsername: pin?.targetUsername || '',
    notes: pin?.notes || ''
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await onSubmit(formData);
    } catch (error) {
      console.error('Form submission failed:', error);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <select
        value={formData.platform}
        onChange={(e) => setFormData({...formData, platform: e.target.value})}
        required
      >
        <option value="twitter">Twitter</option>
        <option value="nostr">Nostr</option>
      </select>

      <input
        type="text"
        value={formData.username}
        onChange={(e) => setFormData({...formData, username: e.target.value})}
        placeholder="username"
        required
      />

      <select
        value={formData.targetPlatform}
        onChange={(e) => setFormData({...formData, targetPlatform: e.target.value})}
        required
      >
        <option value="twitter">Twitter</option>
        <option value="nostr">Nostr</option>
      </select>

      <input
        type="text"
        value={formData.targetUsername}
        onChange={(e) => setFormData({...formData, targetUsername: e.target.value})}
        placeholder="target username"
        required
      />

      <textarea
        value={formData.notes}
        onChange={(e) => setFormData({...formData, notes: e.target.value})}
        placeholder="Notes (optional)"
        maxLength={500}
      />

      <button type="submit">{pin ? 'Update' : 'Create'}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}
```

---

## 🔧 Search Integration

### How Personal Pins Work in Search

When you search for mentions, the API automatically includes personal pin information:

1. **Search Request**: Include `includePersonalPins: true` in your search
2. **Response**: Each result has `isPersonalPin` flag and `personalPin` object
3. **Display**: Highlight results that are personal pins

### Search Result Structure
```javascript
// Each search result includes:
{
  platform: "twitter",
  username: "username", 
  name: "Display Name",
  isPersonalPin: true,           // ← Flag indicating this is a personal pin
  personalPin: {                 // ← Personal pin data (if isPersonalPin: true)
    id: "pin_1234567890_abc123",
    targetPlatform: "nostr",
    targetUsername: "nostr_username", 
    notes: "Personal note",
    usageCount: 3
  }
}
```

### Displaying Personal Pins in Search
```jsx
// components/SearchResult.jsx
export function SearchResult({ result }) {
  return (
    <div className={`search-result ${result.isPersonalPin ? 'personal-pin' : ''}`}>
      <div className="user-info">
        <span>{result.platform}</span>
        <span>@{result.username}</span>
        {result.isPersonalPin && (
          <span className="pin-badge">📌 Personal Pin</span>
        )}
      </div>
      
      {result.isPersonalPin && result.personalPin && (
        <div className="pin-info">
          <span>→ {result.personalPin.targetPlatform}</span>
          <span>@{result.personalPin.targetUsername}</span>
          {result.personalPin.notes && (
            <span className="notes">{result.personalPin.notes}</span>
          )}
        </div>
      )}
    </div>
  );
}
```

### Search Component Example
```jsx
// components/MentionSearch.jsx
import { useState } from 'react';
import { pinService } from '../services/pinService';

export function MentionSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async (searchQuery) => {
    setLoading(true);
    try {
      const results = await pinService.searchMentions(searchQuery);
      setResults(results);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search users..."
      />
      <button onClick={() => handleSearch(query)}>Search</button>
      
      {loading ? (
        <div>Searching...</div>
      ) : (
        <div>
          {results.map(result => (
            <SearchResult key={`${result.platform}-${result.username}`} result={result} />
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## 🔧 Integration Notes

### Validation Rules
- Usernames: alphanumeric, underscore, hyphen only
- Platform names: lowercase only (twitter, nostr)
- Notes: max 500 characters
- All required fields must be provided

### Error Handling
- 401: Authentication required
- 400: Validation errors
- 404: Pin not found
- 500: Server error

---

## ✅ Quick Test

```bash
# Test endpoints
curl -X GET /api/mentions/pins -H "Authorization: Bearer YOUR_TOKEN"
curl -X POST /api/mentions/pins -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" -d '{"platform":"twitter","username":"test","targetPlatform":"nostr","targetUsername":"test_nostr"}'

# Test search with personal pins
curl -X POST /api/mentions/search -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" -d '{"query":"test","includePersonalPins":true}'
```

That's it! Implement the services and components, add routing, and you have a complete personal pins system for Twitter ↔ Nostr mappings with search integration. 