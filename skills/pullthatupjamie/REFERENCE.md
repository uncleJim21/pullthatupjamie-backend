# PullThatUpJamie API Reference

**Base URL:** `https://pullthatupjamie.ai`
**Interactive Docs:** `https://pullthatupjamie.ai/api/docs`

## Search

- `POST /api/search-quotes` — Semantic search across podcast corpus
  - Body: `{ query, feedIds?, limit?, minDate?, maxDate?, episodeName?, guid? }`
  - Returns: `{ query, results: [SearchResult], total, model }`

- `POST /api/corpus/feeds` — List all indexed podcasts (paginated)
- `GET /api/corpus/feeds/:feedId/episodes` — List episodes for a feed

## Research

- `POST /api/research/sessions` — Create curated research session
- `GET /api/research/sessions/:hash` — Retrieve session data
- `POST /api/research/analyze` — AI analysis of research session

## Create

- `POST /api/make-clip` — Generate audio clip from search result
  - **Auth:** Lightning `preimage:paymentHash` OR free tier quota
  - **Cost:** $0.05/clip (50,000 microUSD via Lightning)
  - **Free tier:** 5/week (anon), 10/month (registered), 50/month (subscriber)
  - **Body:** `{ clipId, timestamps? }`
  - **Returns:** `{ status, lookupHash, url? }` (200 cached, 202 processing)
  - **Caching:** Same `clipId` + `timestamps` = instant return (no duplicate charge)

- `GET /api/clip-status/:lookupHash` — Check clip processing status
  - **No auth required** — lookupHash is the credential
  - **Returns:** `{ status: 'completed', url }` or `{ status: 'processing', queuePosition }`
  - **Polling:** Every 5 seconds, max 30 attempts (~2.5 min timeout)

See `references/create.md` for full documentation including auth flow, polling strategy, and examples.

## Agent Auth

- `POST /api/agent/purchase-credits` — Buy Lightning credits (request invoice for N sats)
  - Body: `{ amountSats }` (range: 10 – 500,000)
  - Returns: `{ invoice, paymentHash, amountSats, amountUsd, btcUsdRate, expiresAt }`

- `POST /api/agent/activate-credits` — Activate credits with Lightning preimage
  - Body: `{ preimage, paymentHash }`
  - Returns: `{ paymentHash, balanceUsd, balanceUsdMicro }`

- `GET /api/agent/balance` — Check remaining balance
  - Auth: `Authorization: preimage:paymentHash`
  - Returns: `{ balanceUsd, balanceUsdMicro, totalDepositedUsd, usedUsd, btcUsdRate }`

## Agent Pricing

| Endpoint | Cost (USD) | Cost (microUSD) |
|----------|------------|------------------|
| search-quotes | $0.002 | 2,000 |
| search-quotes-3d | $0.01 | 10,000 |
| make-clip | $0.05 | 50,000 |
| jamie-assist | $0.02 | 20,000 |
| ai-analyze | $0.02 | 20,000 |
| submit-on-demand-run | $0.45 | 450,000 |
