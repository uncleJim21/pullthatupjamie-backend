# Frontend Client ID Guidelines

This document describes how the frontend should handle the `clientId` identifier for research sessions and related endpoints.

## Overview

The backend uses a **hybrid ownership model** for research sessions:

| User State | Identifier | Storage |
|------------|------------|---------|
| Anonymous | `clientId` (frontend-generated UUID) | Session stored under `clientId` |
| Authenticated | `userId` (MongoDB ObjectId from JWT) | Session stored under `userId` |
| Authenticated + has `clientId` | Both | Old sessions found by `clientId` are **automatically migrated** to `userId` |

## Key Behavior: Seamless Session Migration

When a user:
1. Uses the app anonymously (sessions created under their `clientId`)
2. Signs up / logs in (gets a JWT with `userId`)
3. Continues sending their `clientId` alongside their JWT

**The backend will:**
- Query for sessions matching EITHER `userId` OR `clientId`
- Automatically migrate any `clientId`-owned sessions to `userId`
- User sees all their sessions without any manual action

## Implementation

### 1. Generate and Persist a Stable `clientId`

On app initialization, generate a UUIDv4 and store it persistently:

```javascript
// utils/clientId.js
export function getClientId() {
  let clientId = localStorage.getItem('jamie_clientId');
  if (!clientId) {
    clientId = crypto.randomUUID();
    localStorage.setItem('jamie_clientId', clientId);
  }
  return clientId;
}
```

### 2. Include `clientId` in ALL Research-Related Requests

**Always send `clientId`, even when authenticated.** This enables the migration flow.

Choose ONE method (header is recommended):

#### Option A: X-Client-Id Header (Recommended)

```javascript
// api/client.js
import { getClientId } from './utils/clientId';

const apiClient = axios.create({
  baseURL: process.env.API_BASE_URL
});

apiClient.interceptors.request.use((config) => {
  // Always include clientId
  config.headers['X-Client-Id'] = getClientId();
  
  // Include JWT if authenticated
  const token = getAuthToken();
  if (token) {
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  
  return config;
});
```

#### Option B: Query Parameter

```javascript
const clientId = getClientId();
fetch(`/api/research/analyze?clientId=${clientId}`, { ... });
```

#### Option C: Request Body

```javascript
fetch('/api/research/analyze', {
  method: 'POST',
  body: JSON.stringify({
    clientId: getClientId(),
    instructions: '...',
    pineconeIds: [...]
  })
});
```

## Endpoints Requiring `clientId` for Anonymous Users

These endpoints require EITHER a valid JWT OR a `clientId`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/research/analyze` | POST | Ad-hoc AI analysis of quotes |
| `/api/research-sessions` | GET | List user's research sessions |
| `/api/research-sessions` | POST | Create a new research session |
| `/api/research-sessions/:id` | GET | Get a specific session |
| `/api/research-sessions/:id` | PATCH | Update a session |
| `/api/research-sessions/:id/share` | POST | Create shareable snapshot |
| `/api/research-sessions/:id/analyze` | POST | AI analysis of a session |

## Error Response

If neither JWT nor `clientId` is provided:

```json
{
  "error": "Missing owner identifier",
  "details": "Provide a valid JWT token (Authorization: Bearer ...) or a clientId (query param ?clientId=..., X-Client-Id header, or body.clientId)"
}
```

## Migration Behavior Details

### What Gets Migrated

When an authenticated user with a `clientId` accesses their sessions:

1. Backend queries: `{ $or: [{ userId }, { clientId }] }`
2. Any sessions found with `clientId` (but no `userId`) are updated:
   - `userId` is set to the authenticated user's ID
   - `clientId` is removed
3. This happens lazily (on access), not proactively

### New Sessions

When creating new sessions while authenticated:
- Session is stored under `userId` only
- `clientId` is NOT stored (even if provided)

This ensures clean data going forward while preserving access to historical anonymous sessions.

## Best Practices

1. **Generate `clientId` once and persist it** - Don't regenerate on each page load
2. **Always send `clientId`** - Even when authenticated, for migration to work
3. **Use the same `clientId` across sessions** - Store in localStorage, not sessionStorage
4. **Don't expose `clientId` to users** - It's an internal tracking mechanism

## Example: Complete Implementation

```javascript
// hooks/useResearchSessions.js
import { useAuth } from './useAuth';
import { getClientId } from '../utils/clientId';

export function useResearchSessions() {
  const { token } = useAuth();
  
  const headers = {
    'Content-Type': 'application/json',
    'X-Client-Id': getClientId()  // Always include
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const listSessions = async () => {
    const res = await fetch('/api/research-sessions', { headers });
    return res.json();
  };
  
  const analyzeQuotes = async (pineconeIds, instructions) => {
    const res = await fetch('/api/research/analyze', {
      method: 'POST',
      headers,
      body: JSON.stringify({ pineconeIds, instructions })
    });
    return res.json();
  };
  
  return { listSessions, analyzeQuotes };
}
```

## Summary

| Scenario | What to Send |
|----------|--------------|
| Anonymous user | `clientId` (required) |
| Authenticated user | JWT (required) + `clientId` (recommended for migration) |
| Authenticated user, no prior anonymous usage | JWT only (ok, but `clientId` doesn't hurt) |
