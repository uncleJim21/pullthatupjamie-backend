# New Auth System Tests

Test scripts for the provider-agnostic authentication and entitlement system.

## Prerequisites

1. **Auth server** running on port 6111 (`cascdr-backend`)
2. **Backend server** running on port 4132 (`pullthatupjamie-backend`)
3. Both servers connected to the debug MongoDB

## Test Scripts

### 1. Signup Flow (`test-signup-flow.js`)

Tests the new `/auth/signup` endpoint with email provider.

```bash
# With auto-generated email
node test/new-auth/test-signup-flow.js

# With specific email
node test/new-auth/test-signup-flow.js mytest@example.com
```

### 2. Signin Flow (`test-signin-flow.js`)

Tests the new `/auth/signin` endpoint.

```bash
# With default user
node test/new-auth/test-signin-flow.js

# With specific credentials
node test/new-auth/test-signin-flow.js jim.carucci+wim@protonmail.com yourpassword
```

### 3. Quota Burn-down Tests (`test-quota-burndown.js`)

Tests that quota limits are enforced correctly for each tier via debug endpoints.

```bash
# Requires DEBUG_MODE=true
DEBUG_MODE=true node test/new-auth/test-quota-burndown.js
```

### 4. Real Endpoint Tests (`test-real-endpoints.js`)

Tests actual metered endpoints (not debug endpoints) to verify quota enforcement.

```bash
# Requires DEBUG_MODE=true and server running
DEBUG_MODE=true node test/new-auth/test-real-endpoints.js
```

### 5. Seed Test Database (`seed_test_db.js`)

Copies recent documents from production MongoDB to debug MongoDB for testing.

```bash
node test/new-auth/seed_test_db.js
```

## Debug Endpoints

The backend exposes these test endpoints (DEBUG_MODE only):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/debug/test-identity` | GET | Shows resolved identity (tier, user, provider) |
| `/api/debug/test-entitlement/:type` | GET | Shows entitlement status without consuming |
| `/api/debug/test-consume/:type` | POST | Consumes one entitlement unit |

### Entitlement Types

- `searchQuotes` - Basic quote search
- `search3D` - 3D visualization search
- `makeClip` - Video clip creation
- `jamieAssist` - AI analysis
- `researchAnalyze` - Research session analysis
- `onDemandRun` - Podcast processing

## Example: Full Test Flow

```bash
# 1. Start servers (in separate terminals)
# Terminal 1 - Auth server:
cd ~/cascdr-backend && PORT=6111 npm start

# Terminal 2 - Backend (debug mode):
cd ~/pullthatupjamie-backend && DEBUG_MODE=true node server.js

# 2. Run signup
node test/new-auth/test-signup-flow.js test@example.com

# 3. Copy the token from output

# 4. Run signin with existing user
node test/new-auth/test-signin-flow.js test@example.com testpass123

# 5. Run quota tests
DEBUG_MODE=true node test/new-auth/test-quota-burndown.js

# 6. Run real endpoint tests
DEBUG_MODE=true node test/new-auth/test-real-endpoints.js
```

## JWT Structure

### New Format (from `/auth/signin`)
```json
{
  "sub": "user@example.com",
  "provider": "email",
  "email": "user@example.com",
  "iat": 1234567890,
  "exp": 1266103890
}
```

### Legacy Format (still supported)
```json
{
  "email": "user@example.com",
  "iat": 1234567890,
  "exp": 1266103890
}
```

## Tiers & Quotas

### Production Limits

| Tier | searchQuotes | search3D | makeClip | jamieAssist | researchAnalyze | onDemandRun |
|------|-------------|----------|----------|-------------|-----------------|-------------|
| anonymous | 100/week | 20/week | 5/week | 10/week | 5/week | 0 |
| registered | 100/month | 20/month | 10/month | 20/month | 10/month | 1/month |
| subscriber | 500/month | 100/month | 50/month | 100/month | 50/month | 5/month |
| admin | unlimited | unlimited | unlimited | unlimited | unlimited | unlimited |

### Debug Limits (DEBUG_MODE=true)

| Tier | searchQuotes | search3D | makeClip | jamieAssist | researchAnalyze | onDemandRun |
|------|-------------|----------|----------|-------------|-----------------|-------------|
| anonymous | 3/day | 3/day | 2/day | 2/day | 2/day | 0 |
| registered | 3/day | 3/day | 2/day | 3/day | 3/day | 1/day |
| subscriber | 5/day | 5/day | 3/day | 5/day | 5/day | 2/day |
| admin | unlimited | unlimited | unlimited | unlimited | unlimited | unlimited |
