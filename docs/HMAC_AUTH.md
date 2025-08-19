## Service HMAC Auth Guide

This backend supports lightweight, fast HMAC authentication for service-to-service calls on selected endpoints.

### Overview
- Headers to send on each request:
  - `X-Svc-KeyId`: your service key identifier (e.g., `yoloJamieAgent`)
  - `X-Svc-Timestamp`: Unix seconds (tight skew; default 60s)
  - `X-Svc-Body-Hash`: hex SHA-256 of the exact raw request body (required when body exists)
  - `X-Svc-Signature`: base64 HMAC-SHA256 over the canonical string (below)
- Canonical string (joined with newlines `\n`):
```
METHOD
PATH
SORTED_QUERY_STRING
BODY_SHA256_HEX
X-Svc-Timestamp
X-Svc-KeyId
```

Examples:
- `METHOD`: `POST`
- `PATH`: `/api/social/schedule`
- `SORTED_QUERY_STRING`: lexicographically sorted keys; empty string if none
- `BODY_SHA256_HEX`: hex digest of the raw body bytes (no whitespace)

### Server configuration
Put these in `.env` (or your secret manager):
```
DEBUG_MODE=true
SVC_HMAC_KEYS_JSON={"yoloJamieAgent":"<base64-32B-secret>"}
ALLOWED_SCOPES_JSON={"yoloJamieAgent":["svc:social:schedule","svc:jamie:assist"]}
SVC_HMAC_MAX_SKEW_SECS=60
```
Generate a 256-bit base64 secret:
```
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Minimal Node helper (inline) to compute body hash and signature
Set environment variables and run one-liners:
```
export KEY_ID=yoloJamieAgent
export SECRET_BASE64='<base64-secret>'
export TS=$(date +%s)
export METHOD=POST
export PATH_ONLY='/api/social/schedule'
export QUERY_STRING='' # keep empty if no query params
export BODY_JSON='{"adminEmail":"admin@example.com","text":"hello world","scheduledFor":"2025-01-01T15:00:00Z","platforms":["twitter"],"timezone":"America/Chicago"}'

# Compute body hash (hex)
export BODY_HASH=$(node -e 'const c=require("crypto");const b=process.env.BODY_JSON||"";console.log(c.createHash("sha256").update(b).digest("hex"))')

# Compute signature (base64)
export SIG=$(node -e '
const c=require("crypto");
const s=Buffer.from(process.env.SECRET_BASE64,"base64");
const parts=[process.env.METHOD,process.env.PATH_ONLY,process.env.QUERY_STRING,process.env.BODY_HASH,process.env.TS,process.env.KEY_ID].join("\n");
console.log(c.createHmac("sha256",s).update(parts).digest("base64"));
')
```

### cURL: schedule social post (HMAC-only endpoint)
Endpoint: `POST /api/social/schedule`
- Scopes required: `svc:social:schedule`
- Server uses `ALLOWED_SCOPES_JSON[keyId]` (header scope is not required)
```
curl -X POST "http://localhost:4131/api/social/schedule" \
  -H "Content-Type: application/json" \
  -H "X-Svc-KeyId: $KEY_ID" \
  -H "X-Svc-Timestamp: $TS" \
  -H "X-Svc-Body-Hash: $BODY_HASH" \
  -H "X-Svc-Signature: $SIG" \
  --data "$BODY_JSON"
```

Example body for `BODY_JSON`:
```
{
  "adminEmail": "admin@example.com",
  "text": "Announcing our next drop!",
  "scheduledFor": "2025-01-01T15:00:00Z",
  "platforms": ["twitter"],
  "timezone": "America/Chicago",
  "platformData": { "twitterTokens": { "accessToken": "..." } }
}
```

### cURL: Jamie Assist (HMAC-only internal endpoint)
Endpoint: `POST /api/internal/jamie-assist/:lookupHash`
- Scopes required: `svc:jamie:assist`
- Streams Server-Sent Events (SSE). Use `-N` to disable buffering.
```
export LOOKUP_HASH='your-lookup-hash'
export PATH_ONLY="/api/internal/jamie-assist/$LOOKUP_HASH"
export BODY_JSON='{"additionalPrefs":"Keep it punchy"}'
export TS=$(date +%s)
export BODY_HASH=$(node -e 'const c=require("crypto");const b=process.env.BODY_JSON||"";console.log(c.createHash("sha256").update(b).digest("hex"))')
export SIG=$(node -e '
const c=require("crypto");
const s=Buffer.from(process.env.SECRET_BASE64,"base64");
const parts=[process.env.METHOD||"POST",process.env.PATH_ONLY,process.env.QUERY_STRING||"",process.env.BODY_HASH,process.env.TS,process.env.KEY_ID].join("\n");
console.log(c.createHmac("sha256",s).update(parts).digest("base64"));
')

curl -N -X POST "http://localhost:4131$PATH_ONLY" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -H "X-Svc-KeyId: $KEY_ID" \
  -H "X-Svc-Timestamp: $TS" \
  -H "X-Svc-Body-Hash: $BODY_HASH" \
  -H "X-Svc-Signature: $SIG" \
  --data "$BODY_JSON"
```

### Troubleshooting
- 401 Unknown HMAC key: ensure `SVC_HMAC_KEYS_JSON` includes your `keyId` and restart the server.
- 401 Stale request: check NTP time sync; default skew is 60s.
- 401 Body hash mismatch: ensure the `BODY_JSON` used for signing matches the exact request body bytes.
- 403 Insufficient scope: add the required scope to `ALLOWED_SCOPES_JSON[keyId]` and restart.
- Proxies: sign the exact `PATH` that Express sees; avoid rewriting path/query/body en route.


