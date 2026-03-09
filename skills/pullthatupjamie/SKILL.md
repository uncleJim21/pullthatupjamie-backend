# PullThatUpJamie ClawHub Skill

**Version:** 1.6.0
**Name:** pullthatupjamie
**Description:** Podcast Intelligence — Semantically search 109+ podcasts (7K episodes, 1.9M paragraphs), curate research sessions, and create shareable audio clips.

## Features

- **Semantic search** — Vector search across 1.9M podcast paragraphs
- **Research sessions** — Curated collections with audio + transcript + timestamps
- **Audio clip creation** — Generate MP4 clips with burned-in subtitles
- **Lightning-based agent access** — Pay-per-use with Bitcoin (no subscriptions)
- **Free tier** — Generous quotas for experimentation

## Modules

1. **Search** — Find what experts said about any topic (`references/search.md`)
2. **Research** — Curate multi-source research sessions (`references/research.md`)
3. **Create** — Generate shareable audio clips (`references/create.md`)

## Quick Start

### Searching

```bash
curl -X POST https://pullthatupjamie.ai/api/search-quotes \
  -H "Content-Type: application/json" \
  -d '{"query": "Bitcoin as legal tender", "limit": 5}'
```

### Creating Audio Clips

```bash
# 1. Get a clipId from search
CLIP_ID=$(curl -s -X POST https://pullthatupjamie.ai/api/search-quotes \
  -H "Content-Type: application/json" \
  -d '{"query":"Bitcoin legal tender","limit":1}' | jq -r '.results[0].shareLink')

# 2. Create clip (with Lightning credentials)
curl -X POST https://pullthatupjamie.ai/api/make-clip \
  -H "Authorization: PREIMAGE:PAYMENT_HASH" \
  -H "Content-Type: application/json" \
  -d "{\"clipId\":\"$CLIP_ID\"}"

# 3. Poll for completion (use lookupHash from step 2 response)
curl https://pullthatupjamie.ai/api/clip-status/LOOKUP_HASH
```

## Authentication

### Lightning Credits (Agent Access)

Pre-pay in sats, get a `preimage:paymentHash` credential. See `references/create.md` for the full flow.

### Free Tier

No auth required. Quotas tracked by IP (anonymous) or JWT (registered):

| Tier | Search | Clips | Period |
|------|--------|-------|--------|
| Anonymous | 50/week | 5/week | Weekly |
| Registered | 50/month | 10/month | Monthly |
| Subscriber | 500/month | 50/month | Monthly |

## API Base URL

```
https://pullthatupjamie.ai
```

## OpenAPI Docs

Interactive Swagger UI: `https://pullthatupjamie.ai/api/docs`
