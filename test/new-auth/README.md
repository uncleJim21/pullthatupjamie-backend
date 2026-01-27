# New Auth System Tests

Test scripts for the provider-agnostic authentication and entitlement system.

## Prerequisites

1. **Auth server** running on port 6161 (`cascdr-backend`)
2. **Backend server** running on port 4132 (`pullthatupjamie-backend`)
3. Both servers connected to the debug MongoDB

## Test Scripts

### 1. Signup Flow (`test-signup-flow.sh`)

Tests the new `/auth/signup` endpoint with email provider.

```bash
# With auto-generated email
./test-signup-flow.sh

# With specific email
./test-signup-flow.sh mytest@example.com
```

### 2. Signin Flow (`test-signin-flow.sh`)

Tests the new `/auth/signin` endpoint.

```bash
# With existing user
./test-signin-flow.sh jim.carucci+wim@protonmail.com yourpassword

# After running signup flow
./test-signin-flow.sh test+1234567890@example.com testpass123
```

### 3. Entitlement Tests (`test-entitlements.sh`)

Tests identity resolution and entitlement middleware.

```bash
# First, get a token from signin
./test-signin-flow.sh user@example.com password

# Copy the token and run entitlement tests
./test-entitlements.sh <token>

# Or set as environment variable
export TEST_TOKEN="eyJhbG..."
./test-entitlements.sh
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
- `onDemandRun` - Podcast processing

## Example: Full Test Flow

```bash
# 1. Start servers (in separate terminals)
# Terminal 1 - Auth server:
cd ~/cascdr-backend && npm start

# Terminal 2 - Backend:
cd ~/pullthatupjamie-backend && npm start

# 2. Run signup
./test-signup-flow.sh test@example.com

# 3. Copy the token from output

# 4. Test entitlements
./test-entitlements.sh <token>

# 5. Or use curl directly
curl http://localhost:4132/api/debug/test-identity \
  -H "Authorization: Bearer <token>"
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

| Tier | searchQuotes | search3D | makeClip | jamieAssist |
|------|-------------|----------|----------|-------------|
| anonymous | 100/week | 20/week | 5/week | 10/week |
| registered | 100/month | 20/month | 10/month | 20/month |
| subscriber | 500/month | 100/month | 50/month | 100/month |
| admin | unlimited | unlimited | unlimited | unlimited |
