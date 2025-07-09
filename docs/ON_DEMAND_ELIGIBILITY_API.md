# On-Demand Eligibility API

## Overview

The On-Demand Eligibility API allows clients to check their eligibility for on-demand runs before submitting jobs. This endpoint supports both IP-based and JWT-based authentication methods, providing quota information and eligibility status.

## Endpoint

```
GET /api/on-demand/checkEligibility
```

**⚠️ Important**: The correct URL is `http://localhost:4111/api/on-demand/checkEligibility`

## Authentication

The endpoint supports two authentication methods:

### 1. IP-Based Authentication (Default)
- **No authentication required**
- Uses client IP address for quota tracking
- Automatically falls back to this method if JWT is invalid or missing

### 2. JWT-Based Authentication (Optional)
- **Header**: `Authorization: Bearer <jwt_token>`
- Uses user email from JWT token for quota tracking
- Takes precedence over IP-based auth when valid

## Request

### Headers
```
Content-Type: application/json
Authorization: Bearer <jwt_token>  // Optional
```

### No Request Body Required

## Response Format

### Success Response (200)

```json
{
  "success": true,
  "userEmail": "user@example.com",     // Only for JWT auth
  "clientIp": "192.168.1.1",          // Only for IP auth
  "eligibility": {
    "eligible": true,
    "remainingRuns": 5,
    "totalLimit": 10,
    "usedThisPeriod": 2,
    "periodStart": "2024-01-01T00:00:00.000Z",
    "nextResetDate": "2024-02-01T00:00:00.000Z",
    "daysUntilReset": 15
  },
  "message": "You have 5 on-demand runs remaining this period."
}
```

### Error Response (400/500)

```json
{
  "success": false,
  "error": "Error message",
  "details": "Detailed error information"
}
```

## Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the request was successful |
| `userEmail` | string | User email (only for JWT auth) |
| `clientIp` | string | Client IP address (only for IP auth) |
| `eligibility.eligible` | boolean | Whether the client is eligible for on-demand runs |
| `eligibility.remainingRuns` | number | Number of runs remaining in current period |
| `eligibility.usedThisPeriod` | number | Number of runs used in current period |
| `eligibility.totalLimit` | number | Total limit for the period |
| `eligibility.periodStart` | string | ISO date when current period started |
| `eligibility.nextResetDate` | string | ISO date when quota will reset |
| `eligibility.daysUntilReset` | number | Days until quota resets |
| `message` | string | Human-readable message about quota status |

## Quota Configuration

### IP-Based Quota
- **Default Limit**: 5 runs per week
- **Reset Period**: Weekly (configurable via `IP_ONDEMAND_QUOTA_RESET_DAYS`)
- **Storage**: SQLite database (`requests.db`)

### JWT-Based Quota
- **Default Limit**: 10 runs per 30 days
- **Reset Period**: 30 days (configurable via `ONDEMAND_QUOTA_RESET_DAYS`)
- **Storage**: MongoDB (`User` collection)

## Examples

### Example 1: IP-Based Eligibility Check

```bash
curl -X GET http://localhost:4111/api/on-demand/checkEligibility \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "success": true,
  "clientIp": "192.168.1.100",
  "eligibility": {
    "eligible": true,
    "remainingRuns": 3,
    "totalLimit": 5,
    "usedThisPeriod": 2,
    "periodStart": "2024-01-15T00:00:00.000Z",
    "nextResetDate": "2024-01-22T00:00:00.000Z",
    "daysUntilReset": 3
  },
  "message": "You have 3 on-demand runs remaining this period."
}
```

### Example 2: JWT-Based Eligibility Check

```bash
curl -X GET http://localhost:4111/api/on-demand/checkEligibility \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Response:**
```json
{
  "success": true,
  "userEmail": "user@example.com",
  "eligibility": {
    "eligible": true,
    "remainingRuns": 7,
    "totalLimit": 10,
    "usedThisPeriod": 3,
    "periodStart": "2024-01-01T00:00:00.000Z",
    "nextResetDate": "2024-02-01T00:00:00.000Z",
    "daysUntilReset": 15
  },
  "message": "You have 7 on-demand runs remaining this period."
}
```

### Example 3: Quota Exceeded

```json
{
  "success": true,
  "clientIp": "192.168.1.100",
  "eligibility": {
    "eligible": false,
    "remainingRuns": 0,
    "totalLimit": 5,
    "usedThisPeriod": 5,
    "periodStart": "2024-01-15T00:00:00.000Z",
    "nextResetDate": "2024-01-22T00:00:00.000Z",
    "daysUntilReset": 3
  },
  "message": "You have reached your limit of 5 on-demand runs. Next reset: 1/22/2024"
}
```

## Error Cases

### 1. Invalid JWT Token
- Falls back to IP-based authentication
- Returns IP-based quota information

### 2. Missing IP Address
```json
{
  "success": false,
  "error": "Could not determine client IP address",
  "details": "IP address is required for eligibility check"
}
```

### 3. Server Error
```json
{
  "success": false,
  "error": "Internal server error",
  "details": "Database connection failed"
}
```

## Frontend Integration

### JavaScript Example

```javascript
async function checkEligibility(jwtToken = null) {
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (jwtToken) {
    headers['Authorization'] = `Bearer ${jwtToken}`;
  }
  
  try {
    const response = await fetch('http://localhost:4111/api/on-demand/checkEligibility', {
      method: 'GET',
      headers: headers
    });
    
    const data = await response.json();
    
    if (data.success) {
      console.log('Eligible:', data.eligibility.eligible);
      console.log('Remaining runs:', data.eligibility.remainingRuns);
      console.log('Message:', data.message);
      
      return data;
    } else {
      console.error('Eligibility check failed:', data.error);
      return null;
    }
  } catch (error) {
    console.error('Network error:', error);
    return null;
  }
}

// Usage examples
checkEligibility(); // IP-based
checkEligibility('your-jwt-token'); // JWT-based
```

### React Hook Example

```javascript
import { useState, useEffect } from 'react';

function useEligibility(jwtToken = null) {
  const [eligibility, setEligibility] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function checkEligibility() {
      try {
        setLoading(true);
        const headers = { 'Content-Type': 'application/json' };
        
        if (jwtToken) {
          headers['Authorization'] = `Bearer ${jwtToken}`;
        }
        
        const response = await fetch('http://localhost:4111/api/on-demand/checkEligibility', {
          method: 'GET',
          headers: headers
        });
        
        const data = await response.json();
        
        if (data.success) {
          setEligibility(data);
          setError(null);
        } else {
          setError(data.error);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    checkEligibility();
  }, [jwtToken]);

  return { eligibility, loading, error };
}
```

## Testing

### Test Scripts

1. **Basic Eligibility Test:**
   ```bash
   node test/test-eligibility.js
   ```

2. **Comprehensive Test Suite:**
   ```bash
   node test/test-ip-ondemand.js
   ```

### Environment Variables

```bash
# For JWT testing
export JWT_TOKEN="your-jwt-token-here"

# Run tests
node test/test-eligibility.js
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IP_ONDEMAND_QUOTA_LIMIT` | 5 | IP-based quota limit |
| `IP_ONDEMAND_QUOTA_RESET_DAYS` | 7 | IP-based reset period (days) |
| `ONDEMAND_QUOTA_LIMIT` | 10 | JWT-based quota limit |
| `ONDEMAND_QUOTA_RESET_DAYS` | 30 | JWT-based reset period (days) |

## Security Considerations

1. **IP Address Extraction**: The system tries multiple headers to extract the real client IP
2. **JWT Validation**: Invalid JWT tokens are ignored and fall back to IP-based auth
3. **Separate Quotas**: IP and JWT quotas are tracked independently
4. **Rate Limiting**: Consider implementing additional rate limiting for this endpoint

## Next Steps

1. **Frontend Integration**: Implement eligibility checking in your frontend
2. **Quota Display**: Show remaining quota to users before submission
3. **Error Handling**: Handle quota exceeded cases gracefully
4. **Monitoring**: Track eligibility check usage and patterns 