# IP-Based On-Demand Runs Test Scripts

This directory contains test scripts for the IP-based on-demand runs functionality.

## Test Scripts

### 1. `test-quick.js` - Quick Basic Test
A simple test to verify the basic IP-based functionality works.

```bash
node test/test-quick.js
```

**What it tests:**
- Basic IP-based on-demand run submission
- Job status retrieval
- Authentication type tracking

### 2. `test-ip-ondemand.js` - Comprehensive Test Suite
A full test suite that covers all aspects of the IP-based functionality.

```bash
# Run without JWT token
node test/test-ip-ondemand.js

# Run with JWT token (for testing both auth types)
JWT_TOKEN=your_jwt_token_here node test/test-ip-ondemand.js
```

**What it tests:**
- IP-based on-demand runs (no authentication required)
- JWT-based on-demand runs (when token provided)
- Job status checking
- Quota limit testing
- Error case handling
- Authentication type tracking

### 3. `test-quota-limits.js` - Quota Testing
Specifically tests quota limits and tracking functionality.

```bash
node test/test-quota-limits.js
```

**What it tests:**
- Multiple consecutive requests to test quota tracking
- Quota enforcement (should fail after limit reached)
- Quota reset functionality (informational)
- Detailed quota statistics

## Expected Results

### IP-Based Authentication
- ✅ Should work without any JWT token or email
- ✅ Should track usage by IP address
- ✅ Should enforce quota limits per IP
- ✅ Should reset quota after period expiration (default: 30 days)

### JWT-Based Authentication
- ✅ Should work with valid JWT token
- ✅ Should track usage by user email
- ✅ Should have separate quota from IP-based tracking
- ✅ Should enforce quota limits per user

### Quota Tracking
- ✅ Should track `remainingRuns`, `usedThisPeriod`, `totalLimit`
- ✅ Should return 403 error when quota exceeded
- ✅ Should include quota info in response

### Job Tracking
- ✅ Should store `authType` ('ip' or 'user')
- ✅ Should store `clientIp` for IP-based requests
- ✅ Should store `userEmail` for JWT-based requests
- ✅ Should track job status and progress

## Environment Variables

- `JWT_TOKEN`: Set to test JWT-based authentication
- `ON_DEMAND_USAGE_LIMIT`: Default quota limit (default: 2)
- `ON_DEMAND_PERIOD_DAYS`: Quota period in days (default: 30)

## Database Tables

The system creates these SQLite tables:
- `ip_requests`: For free tier tracking (weekly)
- `ip_ondemand_requests`: For IP-based on-demand tracking (period-based)

## Running Tests

1. **Start the server:**
   ```bash
   npm start
   ```

2. **Run quick test:**
   ```bash
   node test/test-quick.js
   ```

3. **Run comprehensive test:**
   ```bash
   node test/test-ip-ondemand.js
   ```

4. **Run quota test:**
   ```bash
   node test/test-quota-limits.js
   ```

5. **Run with JWT token:**
   ```bash
   JWT_TOKEN=your_token_here node test/test-ip-ondemand.js
   ```

## Troubleshooting

### Common Issues

1. **Server not running:**
   - Make sure the server is running on `http://localhost:4131`
   - Check server logs for any errors

2. **Database errors:**
   - Check that SQLite database is being created properly
   - Verify database permissions

3. **Quota not working:**
   - Check environment variables for quota settings
   - Verify database tables are created correctly

4. **JWT tests failing:**
   - Ensure JWT token is valid and not expired
   - Check that the token contains the required email claim

### Debug Information

The test scripts provide detailed output including:
- Request/response status codes
- Quota information (remaining, used, total)
- Authentication type tracking
- Job IDs and status
- Error messages and details

## API Endpoints Tested

- `POST /api/on-demand/submitOnDemandRun` - Submit on-demand run
- `GET /api/on-demand/getOnDemandJobStatus/:jobId` - Get job status

## Authentication Methods

1. **IP-Based (No Auth Required):**
   - No headers required
   - Tracks by client IP address
   - Separate quota from user-based

2. **JWT-Based (Auth Required):**
   - Requires `Authorization: Bearer <token>` header
   - Tracks by user email from JWT
   - Separate quota from IP-based 