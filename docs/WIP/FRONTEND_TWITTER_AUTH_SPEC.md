# Frontend: Twitter OAuth Authentication Spec

## Overview

This document specifies the frontend changes needed to support "Sign in with Twitter" functionality.

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ FRONTEND FLOW                                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. User clicks "Sign in with Twitter" button                                │
│     → Redirect to: BACKEND/api/twitter/auth-initiate?redirect_uri=FRONTEND  │
│                                                                              │
│  2. (Backend handles Twitter OAuth, user authorizes)                         │
│                                                                              │
│  3. User lands on: FRONTEND/auth/twitter/complete?code=tc_xxx&isNewUser=true│
│     → Extract 'code' and 'isNewUser' from URL params                        │
│                                                                              │
│  4. Frontend calls: POST AUTH_SERVER/auth/twitter/exchange { code }          │
│     → Receives: { token, isNewUser, user }                                  │
│                                                                              │
│  5. Store token in localStorage/state                                        │
│     → Redirect to dashboard or onboarding (if new user)                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Environment/Config

```javascript
// URLs for different environments
const config = {
  development: {
    BACKEND_URL: 'http://localhost:4132',
    AUTH_SERVER_URL: 'http://localhost:6111',
    FRONTEND_URL: 'http://localhost:3000'
  },
  production: {
    BACKEND_URL: 'https://pullthatupjamie-explore-alpha-xns9k.ondigitalocean.app',
    AUTH_SERVER_URL: 'https://cascdr-auth-backend-cw4nk.ondigitalocean.app',
    FRONTEND_URL: 'https://your-frontend-domain.com'
  }
};
```

---

## Component 1: Sign In Button

### Location
Add to your login/signup page alongside existing auth options.

### Implementation

```jsx
// components/TwitterSignInButton.jsx (or .tsx)

function TwitterSignInButton() {
  const handleTwitterSignIn = () => {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4132';
    const frontendUrl = window.location.origin;
    
    // Redirect to backend's Twitter auth initiate endpoint
    const authUrl = `${backendUrl}/api/twitter/auth-initiate?redirect_uri=${encodeURIComponent(frontendUrl + '/auth/twitter/complete')}`;
    
    window.location.href = authUrl;
  };

  return (
    <button 
      onClick={handleTwitterSignIn}
      className="twitter-sign-in-btn"
    >
      <TwitterIcon /> {/* or X icon */}
      Sign in with Twitter
    </button>
  );
}
```

---

## Component 2: Callback Handler Page

### Route
Create a page at `/auth/twitter/complete` to handle the redirect from the backend.

### Implementation

```jsx
// pages/auth/twitter/complete.jsx (Next.js)
// OR app/auth/twitter/complete/page.tsx (Next.js App Router)
// OR equivalent for your framework

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function TwitterAuthComplete() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState('processing');
  const [error, setError] = useState(null);

  useEffect(() => {
    async function exchangeCodeForToken() {
      const code = searchParams.get('code');
      const isNewUser = searchParams.get('isNewUser') === 'true';
      const errorParam = searchParams.get('error');

      // Handle error from backend
      if (errorParam) {
        setStatus('error');
        setError(errorParam);
        return;
      }

      // Validate code exists
      if (!code) {
        setStatus('error');
        setError('No authorization code received');
        return;
      }

      try {
        setStatus('exchanging');
        
        const authServerUrl = process.env.NEXT_PUBLIC_AUTH_SERVER_URL || 'http://localhost:6111';
        
        const response = await fetch(`${authServerUrl}/auth/twitter/exchange`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ code }),
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Failed to exchange code');
        }

        // Store the token
        localStorage.setItem('authToken', data.token);
        
        // Optionally store user info
        localStorage.setItem('user', JSON.stringify({
          twitterUsername: data.user.twitterUsername,
          twitterId: data.user.twitterId,
          subscriptionValid: data.user.subscriptionValid,
          subscriptionType: data.user.subscriptionType,
          provider: 'twitter'
        }));

        setStatus('success');

        // Redirect based on new/existing user
        if (data.isNewUser) {
          // New user - redirect to onboarding or welcome page
          router.push('/welcome?newUser=true&provider=twitter');
        } else {
          // Existing user - redirect to dashboard
          router.push('/dashboard');
        }

      } catch (err) {
        console.error('Twitter auth exchange failed:', err);
        setStatus('error');
        setError(err.message);
      }
    }

    exchangeCodeForToken();
  }, [searchParams, router]);

  // Render based on status
  return (
    <div className="auth-callback-container">
      {status === 'processing' && (
        <div className="loading">
          <Spinner />
          <p>Completing Twitter sign-in...</p>
        </div>
      )}

      {status === 'exchanging' && (
        <div className="loading">
          <Spinner />
          <p>Verifying your account...</p>
        </div>
      )}

      {status === 'success' && (
        <div className="success">
          <CheckIcon />
          <p>Sign-in successful! Redirecting...</p>
        </div>
      )}

      {status === 'error' && (
        <div className="error">
          <ErrorIcon />
          <h2>Sign-in Failed</h2>
          <p>{error}</p>
          <button onClick={() => router.push('/login')}>
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
```

---

## Component 3: Error Handler Page (Optional)

### Route
`/auth/error` - handles errors from any OAuth flow

```jsx
// pages/auth/error.jsx

import { useSearchParams } from 'next/navigation';

export default function AuthError() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');
  const details = searchParams.get('details');

  return (
    <div className="auth-error-container">
      <h1>Authentication Failed</h1>
      <p className="error-message">{error || 'An unknown error occurred'}</p>
      {details && <p className="error-details">{details}</p>}
      <button onClick={() => window.location.href = '/login'}>
        Return to Login
      </button>
    </div>
  );
}
```

---

## Auth Context Updates (Optional)

If you're using an auth context/provider, update it to handle Twitter users:

```jsx
// context/AuthContext.jsx

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);

  useEffect(() => {
    // Load from localStorage on mount
    const storedToken = localStorage.getItem('authToken');
    const storedUser = localStorage.getItem('user');
    
    if (storedToken) {
      setToken(storedToken);
    }
    if (storedUser) {
      setUser(JSON.parse(storedUser));
    }
  }, []);

  const logout = () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
  };

  // Helper to check auth type
  const isTwitterUser = user?.provider === 'twitter';
  const isEmailUser = user?.provider === 'email' || !user?.provider;
  const isNostrUser = user?.provider === 'nostr';

  return (
    <AuthContext.Provider value={{
      user,
      token,
      isAuthenticated: !!token,
      isTwitterUser,
      isEmailUser,
      isNostrUser,
      logout
    }}>
      {children}
    </AuthContext.Provider>
  );
}
```

---

## API Utility Updates

Update your API utility to include the token:

```javascript
// utils/api.js

export async function apiRequest(endpoint, options = {}) {
  const token = localStorage.getItem('authToken');
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4132';
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${backendUrl}${endpoint}`, {
    ...options,
    headers,
  });

  return response;
}
```

---

## Environment Variables

Add to your `.env.local` (Next.js) or equivalent:

```bash
# Development
NEXT_PUBLIC_BACKEND_URL=http://localhost:4132
NEXT_PUBLIC_AUTH_SERVER_URL=http://localhost:6111

# Production (set in deployment platform)
NEXT_PUBLIC_BACKEND_URL=https://pullthatupjamie-explore-alpha-xns9k.ondigitalocean.app
NEXT_PUBLIC_AUTH_SERVER_URL=https://cascdr-auth-backend-cw4nk.ondigitalocean.app
```

---

## Testing Checklist

### Manual Test Flow

1. **Start all servers:**
   - Frontend on :3000
   - Backend on :4132
   - Auth server on :6111

2. **Click "Sign in with Twitter"**
   - Should redirect to Twitter/X OAuth page

3. **Authorize the app on Twitter**
   - Should redirect back to your frontend

4. **Observe the callback page**
   - Should show "Completing Twitter sign-in..."
   - Then "Verifying your account..."
   - Then redirect to dashboard/welcome

5. **Verify token storage:**
   - Open browser dev tools → Application → Local Storage
   - Should see `authToken` and `user` entries

6. **Test authenticated request:**
   - Make a request that requires auth
   - Should work with the Twitter-issued JWT

### Edge Cases to Test

- [ ] User denies Twitter authorization → should show error
- [ ] User closes Twitter popup → should handle gracefully  
- [ ] Temp code expires (wait >60 seconds) → should show error
- [ ] User already exists → should log in, not create new account
- [ ] Network error during exchange → should show error with retry option

---

## UI/UX Considerations

### Button Styling

```css
.twitter-sign-in-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background-color: #1DA1F2; /* Twitter blue, or #000 for X */
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s;
}

.twitter-sign-in-btn:hover {
  background-color: #1a91da;
}

/* X branding alternative */
.x-sign-in-btn {
  background-color: #000;
}

.x-sign-in-btn:hover {
  background-color: #333;
}
```

### Icon Options

```jsx
// Twitter bird
<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
  <path d="M23.643 4.937c-.835.37-1.732.62-2.675.733.962-.576 1.7-1.49 2.048-2.578-.9.534-1.897.922-2.958 1.13-.85-.904-2.06-1.47-3.4-1.47-2.572 0-4.658 2.086-4.658 4.66 0 .364.042.718.12 1.06-3.873-.195-7.304-2.05-9.602-4.868-.4.69-.63 1.49-.63 2.342 0 1.616.823 3.043 2.072 3.878-.764-.025-1.482-.234-2.11-.583v.06c0 2.257 1.605 4.14 3.737 4.568-.392.106-.803.162-1.227.162-.3 0-.593-.028-.877-.082.593 1.85 2.313 3.198 4.352 3.234-1.595 1.25-3.604 1.995-5.786 1.995-.376 0-.747-.022-1.112-.065 2.062 1.323 4.51 2.093 7.14 2.093 8.57 0 13.255-7.098 13.255-13.254 0-.2-.005-.402-.014-.602.91-.658 1.7-1.477 2.323-2.41z"/>
</svg>

// X logo
<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
</svg>
```

---

## Summary

| File | Purpose |
|------|---------|
| `TwitterSignInButton.jsx` | Button to initiate Twitter sign-in |
| `pages/auth/twitter/complete.jsx` | Handle OAuth callback, exchange code for JWT |
| `pages/auth/error.jsx` | Display auth errors |
| `.env.local` | Add `NEXT_PUBLIC_AUTH_SERVER_URL` |

| Action | Endpoint |
|--------|----------|
| Initiate sign-in | `GET BACKEND/api/twitter/auth-initiate?redirect_uri=...` |
| Exchange code | `POST AUTH_SERVER/auth/twitter/exchange` |
| Use token | `Authorization: Bearer <token>` on all backend requests |
