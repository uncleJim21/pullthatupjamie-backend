# Create Module — Audio Clip Generation

Generate shareable MP4 clips with burned-in subtitles from podcast search results.

## Quick Start

```javascript
const BASE_URL = 'https://pullthatupjamie.ai';

// 1. Search for content
const searchRes = await fetch(`${BASE_URL}/api/search-quotes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'Bitcoin as legal tender', limit: 5 })
});
const { results } = await searchRes.json();
const clipId = results[0].shareLink;

// 2. Create clip
const createRes = await fetch(`${BASE_URL}/api/make-clip`, {
  method: 'POST',
  headers: {
    'Authorization': 'YOUR_PREIMAGE:YOUR_PAYMENT_HASH',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ clipId })
});
const { status, lookupHash, url } = await createRes.json();

// 3. If cached, URL is immediate
if (status === 'completed') {
  console.log('Clip ready:', url);
} else {
  // 4. Poll for completion
  const clipUrl = await pollClipStatus(lookupHash);
  console.log('Clip ready:', clipUrl);
}
```

---

## Authentication

### Option 1: Lightning Credits (Agent Access)

**Cost:** $0.05 per clip (50,000 microUSD)

Lightning auth uses a 3-step flow. The resulting `preimage:paymentHash` credential is stateless and long-lived.

#### Step 1 — Purchase credits

```bash
curl -X POST https://pullthatupjamie.ai/api/agent/purchase-credits \
  -H "Content-Type: application/json" \
  -d '{"amountSats": 5000}'
```

Response:

```json
{
  "invoice": "lnbc50u1p...",
  "paymentHash": "def456...",
  "amountSats": 5000,
  "amountUsd": 5.00,
  "btcUsdRate": 100000,
  "expiresAt": "2026-03-09T12:00:00.000Z"
}
```

#### Step 2 — Pay the Lightning invoice, then activate

Pay `invoice` with any Lightning wallet. Then submit the preimage:

```bash
curl -X POST https://pullthatupjamie.ai/api/agent/activate-credits \
  -H "Content-Type: application/json" \
  -d '{"preimage": "abc123...", "paymentHash": "def456..."}'
```

Response:

```json
{
  "paymentHash": "def456...",
  "balanceUsd": 5.00,
  "balanceUsdMicro": 5000000
}
```

#### Step 3 — Use credential on API calls

Pass the `preimage:paymentHash` pair as the Authorization header:

```bash
curl -X POST https://pullthatupjamie.ai/api/make-clip \
  -H "Authorization: abc123...:def456..." \
  -H "Content-Type: application/json" \
  -d '{"clipId": "1015378_guid_p123"}'
```

#### Checking balance

```bash
curl https://pullthatupjamie.ai/api/agent/balance \
  -H "Authorization: abc123...:def456..."
```

Returns `balanceUsd`, `usedUsd`, `totalDepositedUsd`, and current `btcUsdRate`.

### Option 2: Free Tier

No auth required. Quotas tracked by IP (anonymous) or JWT (registered):

| Tier | Clips | Period |
|------|-------|--------|
| Anonymous | 5 | Per week |
| Registered | 10 | Per month |
| Subscriber | 50 | Per month |

Simply call `/api/make-clip` without credentials.

---

## API Reference

### `POST /api/make-clip`

Create an audio clip from a search result.

**Request:**

```json
{
  "clipId": "1015378_38c8e3a2b0e94b2b80feb2e426fbf0b3_p1234",
  "timestamps": [1234.5, 1289.0]
}
```

- `clipId` (required): The `shareLink` value from a search result.
- `timestamps` (optional): `[startSeconds, endSeconds]` to override the natural paragraph bounds.

**Responses:**

| Status | Meaning | Body |
|--------|---------|------|
| 200 | Cached (instant, no charge) | `{ status: 'completed', lookupHash, url }` |
| 202 | Queued for processing | `{ status: 'processing', lookupHash, pollUrl }` |
| 400 | Missing clipId | `{ error: 'clipId is required' }` |
| 404 | clipId not in corpus | `{ error: 'Clip not found', clipId }` |
| 429 | Quota exceeded | `{ error, code: 'QUOTA_EXCEEDED', used, max, resetDate, daysUntilReset, tier }` |
| 429 | Insufficient funds | `{ error, code: 'INSUFFICIENT_FUNDS', costUsd, balanceUsd, costUsdMicro, balanceUsdMicro }` |
| 500 | Server error | `{ error: 'Internal server error' }` |

### `GET /api/clip-status/:lookupHash`

Poll for clip processing completion. No authentication required.

**Responses:**

| Status | Meaning | Body |
|--------|---------|------|
| 200 | Completed | `{ status: 'completed', url }` |
| 200 | Still processing | `{ status: 'processing', queuePosition: { estimatedWaitSeconds }, lookupHash }` |
| 200 | Failed | `{ status: 'failed', error: '...', lookupHash }` |
| 404 | Not found | `{ status: 'not_found' }` |
| 500 | Server error | `{ error: 'Internal server error' }` |

---

## Polling Strategy

### Recommended approach

```javascript
async function pollClipStatus(lookupHash, maxAttempts = 30, intervalMs = 5000) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(
      `https://pullthatupjamie.ai/api/clip-status/${lookupHash}`
    );
    const data = await res.json();

    if (data.status === 'completed') return data.url;
    if (data.status === 'failed') throw new Error(`Clip failed: ${data.error}`);
    if (res.status === 404) throw new Error('Clip not found — retry creation');

    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Clip processing timeout after 2.5 minutes');
}
```

### Timing

- **Interval:** 5 seconds
- **Max attempts:** 30 (~2.5 minute timeout)
- **Typical completion:** <1 minute (10-12 polls)
- **Worst case:** ~2 minutes for complex clips

### Status progression

```
queued → processing → completed
                   ↘ failed (rare)
```

---

## Custom Timestamps

By default, clips use the natural paragraph boundaries from the search result. Override with `timestamps`:

```javascript
// Natural bounds (uses timeContext from search result)
await makeClip({ clipId: 'abc_p123' });

// Custom bounds (exactly 60 seconds for social media)
await makeClip({
  clipId: 'abc_p123',
  timestamps: [1234.5, 1294.5]
});
```

Different timestamps produce a different `lookupHash`, which means new processing and a new charge. Even a 0.1-second difference creates a new clip.

---

## Error Handling

### Quota exhausted (free tier)

```json
{
  "error": "Quota exceeded",
  "code": "QUOTA_EXCEEDED",
  "used": 10,
  "max": 10,
  "resetDate": "2026-04-01T00:00:00Z",
  "daysUntilReset": 5,
  "tier": "registered"
}
```

**Action:** Wait for reset or switch to Lightning credits.

### Insufficient funds (Lightning)

```json
{
  "error": "Insufficient funds",
  "code": "INSUFFICIENT_FUNDS",
  "costUsd": 0.05,
  "balanceUsd": 0.02,
  "costUsdMicro": 50000,
  "balanceUsdMicro": 20000
}
```

**Action:** Top up at `POST /api/agent/purchase-credits`, then activate.

### Processing failure

When polling returns `status: 'failed'`, the `error` field describes the cause. Possible causes:
- Audio URL inaccessible (source podcast CDN issue)
- Transcript data missing for episode
- FFmpeg processing error

**Action:** Log the error. Optionally retry clip creation once. If persistent, the source episode may have an issue.

---

## Cost Optimization

1. **Cache lookupHash client-side.** The same `clipId` + `timestamps` always produces the same `lookupHash`. Re-requesting a completed clip returns instantly at no charge.
2. **Avoid timestamp micro-adjustments.** Even a 0.1-second difference creates a new clip with a new charge.
3. **Use natural bounds when possible.** Omit the `timestamps` parameter to use the pre-indexed paragraph boundaries.
4. **Batch in parallel.** Multiple clip requests can be made concurrently — each gets its own `lookupHash` for independent polling.

---

## Complete Agent Example

```javascript
async function createClipFromSearch(query) {
  const BASE_URL = 'https://pullthatupjamie.ai';
  const AUTH = 'YOUR_PREIMAGE:YOUR_PAYMENT_HASH';

  // 1. Search
  const searchRes = await fetch(`${BASE_URL}/api/search-quotes`, {
    method: 'POST',
    headers: {
      'Authorization': AUTH,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, limit: 1 })
  });
  const { results } = await searchRes.json();
  if (!results.length) throw new Error('No results found');

  const clipId = results[0].shareLink;

  // 2. Create clip
  const createRes = await fetch(`${BASE_URL}/api/make-clip`, {
    method: 'POST',
    headers: {
      'Authorization': AUTH,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ clipId })
  });

  const createData = await createRes.json();

  if (createRes.status === 429) {
    if (createData.code === 'QUOTA_EXCEEDED') {
      throw new Error(`Quota exceeded. Resets in ${createData.daysUntilReset} days.`);
    }
    if (createData.code === 'INSUFFICIENT_FUNDS') {
      throw new Error(`Insufficient funds. Need $${createData.costUsd}, have $${createData.balanceUsd}.`);
    }
  }

  if (createData.status === 'completed') {
    return createData.url;
  }

  // 3. Poll
  const lookupHash = createData.lookupHash;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(`${BASE_URL}/api/clip-status/${lookupHash}`);
    const statusData = await statusRes.json();

    if (statusData.status === 'completed') return statusData.url;
    if (statusData.status === 'failed') {
      throw new Error(`Clip processing failed: ${statusData.error}`);
    }
  }

  throw new Error('Clip processing timeout after 2.5 minutes');
}

// Usage
const clipUrl = await createClipFromSearch('Bitcoin fixes this');
console.log('Share this:', clipUrl);
```

---

## Clip Specifications

| Property | Value |
|----------|-------|
| Format | MP4 (H.264 video, AAC audio) |
| Resolution | 1920x1080 (1080p) |
| Subtitles | Burned-in, white text with black outline |
| Audio | Original podcast audio |
| CDN | DigitalOcean Spaces |
| Cache lifetime | Indefinite (clips never expire) |

---

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| 400 "clipId is required" | Missing body parameter | Include `{ "clipId": "..." }` in request body |
| 404 "Clip not found" | Invalid clipId | Verify `shareLink` from a search result |
| 429 "Quota exceeded" | Free tier limit reached | Wait for reset or buy Lightning credits |
| 429 "Insufficient funds" | Lightning balance too low | Top up via `/api/agent/purchase-credits` + `/activate-credits` |
| `status: 'failed'` during poll | Processing error | Check `error` field, retry once, contact support if persistent |
| Timeout after 30 polls | Rare processing hang | Contact support with the `lookupHash` |
