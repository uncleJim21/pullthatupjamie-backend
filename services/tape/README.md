# Tape backend module (`/api/tape/*`)

Self-contained backend for the **Tape** finance skin (Dossier, Brief, Split, Arc,
Read-in). Moves the editorial recipes (mainstream allowlist, dedicated-episode
filter, paragraph-span sort, themed-query fan-out) into a small retrieve-then-write
pipeline so every client inherits the same DNA and the heavy work is cached
cross-user. Design doc: `.claude/plans/i-am-making-a-gentle-treehouse.md`.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/tape/auth` | password | Exchange shared password → 30-day scoped JWT |
| GET  | `/api/tape/quote/:slug` | Bearer | Ticker price + sparkline (Yahoo/Finnhub proxy) |
| POST | `/api/tape/person-quotes` | Bearer | Best quotes **by a person** on themes (Dossier/Arc/Split) |
| POST | `/api/tape/topic-quotes` | Bearer | Best quotes **about a topic** (Brief/Split/Read-in) |
| POST | `/api/tape/synthesize` | Bearer | LLM writer — turns candidates into editorial prose |

Pipeline for any action: **retrieve** (`person-quotes` or `topic-quotes`) → **write**
(`synthesize`). Retrieval is cached so the fan-out is paid once; `synthesize` is
content-addressed by candidate set, so synthesis tokens are spent at most once per
unique set of quotes (a topic with no new episodes never pays twice).

## Reuses (no duplication)

- `services/searchQuotesService.searchQuotes` — semantic search
- `services/corpusService.{findPeople,getPersonEpisodes}` — person resolution
- `utils/agent/providers` + `constants/agentModels.resolveModelSelection` — LLM call + model routing
- `utils/agent/sanitizeOutput` — clip-token (`{{clip:id}}`) cleanup

## Freshness policy (two tiers, finance-tuned)

- **Quantitative** (prices): cache 60s open / 5m closed; never served older than **1 hour**
  (stale-fallback past the ceiling is flagged `_meta.stale` + `staleReason`).
- **Qualitative** (quotes + synthesis): cached up to **3 business days** (skips weekends).
  `synthesize` output is content-addressed with a long (30-day) TTL.

Every response carries a uniform `_meta` "last updated" block:
`{ cached, revalidated, tier, fetchedAt, cachedAt, ageSec, freshUntil, stale, staleReason }`.

## Stock-quote providers (interchangeable)

`services/tape/quoteProviders/` — a provider chain so Yahoo can be backed up or
replaced without touching the rest of the stack. Each provider exports
`{ name, isConfigured(), fetchQuote(slug) }` and returns the normalized shape
`{ symbol, name, price, currency, dayChangePct, spark[], marketState }`.

- **Yahoo** (default): no key required.
- **Finnhub**: auto-activates when `FINNHUB_API_KEY` is set; used as fallback under
  `TAPE_QUOTE_PROVIDER=yahoo` (default) or as primary under `TAPE_QUOTE_PROVIDER=finnhub`.

If Yahoo throttles or 5xxs, the chain transparently tries the next provider; if every
provider fails, the last cached price is served flagged `stale`. **You do not need a
Finnhub account today** — the plumbing is in place; just set `FINNHUB_API_KEY` to enable it.

Caveat: index/futures slugs differ across providers (Yahoo `^TNX`, `CL=F`, `DX-Y.NYB`).
Set `FINNHUB_SYMBOL_MAP` (JSON) to translate per slug, e.g. `{"^TNX":"...","CL=F":"..."}`.
Finnhub's candle/sparkline endpoint is paid-plan only; on the free tier the sparkline
degrades to a single point rather than failing.

## Environment variables

```bash
# --- auth (required to use the module) ---
TAPE_AUTH_PASSWORD=<shared demo password>
TAPE_AUTH_SECRET=<32+ random bytes; e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`>
TAPE_AUTH_KID=v1                 # bump to revoke ALL outstanding tokens
TAPE_AUTH_TTL_DAYS=30            # token lifetime (default 30)

# --- cost guards (synthesize) ---
TAPE_DAILY_OUTPUT_TOKEN_CAP=5000000   # global daily output-token cap (0 = off)
TAPE_DAILY_USD_CAP=                    # optional global daily $ cap
TAPE_SYN_HOURLY_LIMIT=30               # per-JWT synthesize calls/hour
TAPE_SYN_MAX_TOKENS=2048               # max synthesis output tokens

# --- cache backend (optional) ---
REDIS_URL=                       # unset = in-memory (per-container). Set → Redis (needs `npm i ioredis`)
TAPE_NOCACHE_ENABLED=false       # allow `_nocache:true` in request bodies (debug)

# --- freshness policy (defaults shown) ---
TAPE_QUAL_TTL_BUSINESS_DAYS=3
TAPE_QUANT_MAX_AGE_SEC=3600
TAPE_QUOTE_TTL_OPEN_SEC=60
TAPE_QUOTE_TTL_CLOSED_SEC=300
TAPE_SYN_TTL_DAYS=30

# --- quote providers ---
TAPE_QUOTE_PROVIDER=yahoo        # yahoo (default) | finnhub
FINNHUB_API_KEY=                 # enables Finnhub provider when set
FINNHUB_SYMBOL_MAP={}            # JSON map of Yahoo slug -> Finnhub symbol
```

Rate limits (per-JWT, per hour): `synthesize` 30, `person-quotes`/`topic-quotes` 120,
`quote/*` 600. Kill switches: bump `TAPE_AUTH_KID`, or the daily synth cap.

### Force re-synthesize (`refresh: true`)

Send `{"refresh": true}` in a `synthesize` (or `person-quotes`/`topic-quotes`) body to
bypass the cache **read** and regenerate, while still writing the fresh result back to
cache. Distinct from `_nocache` (a gated debug flag that bypasses read *and* write).

For `synthesize`, a forced pass spends tokens and counts against the daily cap. **During
beta it is unlimited and only measured** — see the `TODO(beta)` in
[synthesize.js](synthesize.js) to add a per-user cap later. Measurement hooks already in place:
- structured log gets `forced: true` and `_meta.forced: true` on the response;
- counters `tape:syn:resynth:<jwt_sub>:<utc-date>` (per user) and
  `tape:syn:resynth:all:<utc-date>` (global) increment on each forced pass, so you can
  read real usage before picking a limit.

## Token cost (DeepSeek V4 Flash default)

Only `synthesize` spends LLM tokens (~$0.0012–0.0015 per cold query); retrieval
embeddings are ~$0.0001 and quotes are free. Cached / revalidated repeats are ~$0.
The 5M daily token cap ≈ 3,300 synth calls ≈ <$3/day at the ceiling.

## Quick verification

```bash
# 1. auth
TAPE_JWT=$(curl -s localhost:4132/api/tape/auth -H 'content-type: application/json' \
  -d '{"password":"<TAPE_AUTH_PASSWORD>"}' | jq -r .token)

# 2. quote (note _meta.source = yahoo|finnhub|cache, _meta.tier = quantitative)
curl -s localhost:4132/api/tape/quote/APP -H "Authorization: Bearer $TAPE_JWT" | jq

# 3. person-quotes
curl -s localhost:4132/api/tape/person-quotes -H "Authorization: Bearer $TAPE_JWT" \
  -H 'content-type: application/json' \
  -d '{"name":"Mohamed El-Erian","themes":["Federal Reserve interest rates inflation","recession risk Treasury yields"]}' | jq '.candidates[0]'

# 4. topic-quotes (grouped)
curl -s localhost:4132/api/tape/topic-quotes -H "Authorization: Bearer $TAPE_JWT" \
  -H 'content-type: application/json' \
  -d '{"themes":["Strait of Hormuz Iran oil","oil price spike Middle East"],"groupBy":"creator"}' | jq '.groups | length'

# 5. synthesize (feed candidates from step 3)
curl -s localhost:4132/api/tape/synthesize -H "Authorization: Bearer $TAPE_JWT" \
  -H 'content-type: application/json' \
  -d '{"kind":"dossier","input":{"person":"Mohamed El-Erian"},"candidates":[...],"model":"fast"}' | jq '.text, .tokens'
```
