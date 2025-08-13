# App Preferences API

This document outlines the API endpoints for managing user application preferences in Pull That Up Jamie.

## Overview

The App Preferences API provides a simple interface for storing and retrieving user-specific preferences. These preferences are stored separately from podcast-specific preferences and can include UI settings, notification preferences, language settings, or any other client-side configurations.

## Schema Version

All preferences are tracked with a schema version to handle future updates and migrations. The current schema version is in YYYYMMDDXXX format (e.g., 20250812001).

## Endpoints

### Get User Preferences

```http
GET /api/preferences
Authorization: Bearer <jwt_token>
```

#### Response

```json
{
  "preferences": {
    "theme": "dark",
    "notifications": true,
    "language": "en"
    // ... any other preferences
  },
  "schemaVersion": 20250812001
}
```

- If no preferences exist, returns empty preferences object:
```json
{
  "preferences": {},
  "schemaVersion": 20250812001
}
```

### Update User Preferences

```http
PUT /api/preferences
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "preferences": {
    "theme": "dark",
    "notifications": true,
    "language": "en"
  },
  "schemaVersion": 20250812001
}
```

#### Response

```json
{
  "preferences": {
    "theme": "dark",
    "notifications": true,
    "language": "en"
  },
  "schemaVersion": 20250812001
}
```

## Implementation Guide

### Frontend Setup

1. **Initial Load**
```typescript
// Example using fetch
const getPreferences = async () => {
  const response = await fetch('http://localhost:4132/api/preferences', {
    headers: {
      'Authorization': `Bearer ${userToken}`
    }
  });
  const data = await response.json();
  return data;
};
```

2. **Update Preferences**
```typescript
// Example using fetch
const updatePreferences = async (preferences: object) => {
  const response = await fetch('http://localhost:4132/api/preferences', {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${userToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      preferences,
      schemaVersion: 20250812001
    })
  });
  const data = await response.json();
  return data;
};
```

### React Hook Example

```typescript
import { useState, useEffect } from 'react';

const useAppPreferences = () => {
  const [preferences, setPreferences] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load preferences
  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const data = await getPreferences();
        setPreferences(data.preferences);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    };
    loadPreferences();
  }, []);

  // Update preferences
  const updatePrefs = async (newPrefs: object) => {
    try {
      const data = await updatePreferences(newPrefs);
      setPreferences(data.preferences);
      return data;
    } catch (err) {
      setError(err);
      throw err;
    }
  };

  return { preferences, loading, error, updatePrefs };
};
```

### Usage Example

```typescript
function App() {
  const { preferences, loading, error, updatePrefs } = useAppPreferences();

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error loading preferences</div>;

  const toggleTheme = async () => {
    const newTheme = preferences.theme === 'dark' ? 'light' : 'dark';
    await updatePrefs({
      ...preferences,
      theme: newTheme
    });
  };

  return (
    <div>
      <button onClick={toggleTheme}>
        Toggle Theme (Current: {preferences.theme})
      </button>
    </div>
  );
}
```

## Error Handling

The API returns standard HTTP status codes:

- `200`: Success
- `400`: Invalid request (e.g., malformed preferences object)
- `401`: Unauthorized (invalid or missing token)
- `500`: Server error

Error responses include a message:
```json
{
  "error": "Error message here"
}
```

## Best Practices

1. **Initialization**
   - Always load preferences when your app starts
   - Provide sensible defaults while preferences are loading

2. **Updates**
   - Batch preference updates when possible
   - Handle errors gracefully and provide feedback to users
   - Consider implementing optimistic updates for better UX

3. **Schema Version**
   - Always include the current schema version when updating preferences
   - Handle version mismatches appropriately in your UI

4. **Performance**
   - Cache preferences locally
   - Implement debouncing for rapid preference changes

## Migration Notes

When implementing new preferences:

1. Update the schema version (YYYYMMDDXXX format)
2. Provide migration logic if needed
3. Document new preference fields
4. Update TypeScript types if using TypeScript

## Security Considerations

1. Always use HTTPS in production
2. Never store sensitive information in preferences
3. Validate preference values on both client and server
4. Use appropriate CORS settings
5. Include CSRF protection if needed
