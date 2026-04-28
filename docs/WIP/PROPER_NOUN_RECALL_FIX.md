# Proper-Noun Recall Failure — Diagnosis, Benchmark, Implementation

Last updated: **2026-04-27**

This doc captures (a) the diagnosis of the `lncurl.lol` recall failure that Roland from Alby surfaced in the Apr 23 email exchange, (b) the empirical benchmark results that ruled out a Mongo regex fallback, (c) the Atlas Search-based fix that shipped 2026-04-27, (d) the verification + curation steps to take before flipping the kill switch, and (e) the **follow-on LLM-driven query expansion layer** that shipped later the same day to bridge ASR phonetic mismatches the lexical path alone could not solve.

## The failing case

User query: `"search for lncurl.lol"`

Expected hit: Bitcoin Audible, Roundtable_018 ("Everything is Fake and Gay"), 2026-03-05, paragraph timestamped 7830.195-7856.325s. Transcript text:

> "I haven't actually used this, but one of the really promising features of this is essentially a plug and play networking system. This is why we are using it. Then another one that I thought was pretty cool, this was run with AlbiHub and Nostra Wallet Connect is l n curl. It's l n curl dot loll. So l n c u r l dot l o l."

That paragraph IS in the index. We confirmed it exists on the production Pinecone collection. The agent simply never surfaces it.

## Diagnosis (from code inspection)

The break is a chain of five reinforcing causes:

### 1. Embedding model is `text-embedding-ada-002`

[services/searchQuotesService.js:52-56](../../services/searchQuotesService.js#L52-L56) — ada-002 (Dec 2022 vintage) is weak on novel proper nouns and out-of-vocabulary tokens. `"lncurl.lol"` embeds near generic URL/internet semantic territory. `"l n c u r l dot l o l"` (how Guy Swann actually pronounces it) embeds near letter-spelling / pronunciation territory. They are not neighbors in ada-002 space.

### 2. No lexical fallback. Pure vector retrieval

[agent-tools/pineconeTools.js:360-400](../../agent-tools/pineconeTools.js#L360-L400) — Pinecone vector query is the ONLY retrieval surface. The "hybrid" reranking later in `findSimilarDiscussions` is a TF-IDF rerank of the top-20 vector results. If the right paragraph never makes the vector topK, nothing pulls it back.

### 3. No spelled-out / phonetic normalization at ingest or query time

The transcript stores `"l n c u r l"` as-is. There is no `searchableText` field that collapses it back to `"lncurl"`. Conversely, `"lncurl.lol"` at query time is not expanded into spelled-out variants. The two forms remain canonically separate strings forever.

### 4. The agent system prompt actively steers AWAY from literal proper-noun queries

[setup-agent.js:67-76](../../setup-agent.js#L67-L76) — the `searchCrafting` section instructs the model:

> NEVER pass meta-language — it matches intros/outros where someone's name is said, not substantive content.
> BAD: "find Joe Rogan talking about mushrooms"
> GOOD: "stoned ape theory psilocybin mushrooms cognitive evolution"

Correct guidance for topic queries. Wrong for proper-noun queries. A model that obeys this prompt will rewrite `"lncurl.lol"` into something like `"Lightning Network plug-and-play wallet connect protocol"` and confidently search for the wrong thing.

### 5. Triage / query rewriting doesn't run for the agent's `search_quotes` calls

[services/searchQuotesService.js:37](../../services/searchQuotesService.js#L37) — `triageQuery` is gated behind `smartMode && !feedIds.length && !guids.length`. The agent calls `search_quotes` without `smartMode: true`, so we never get a chance to detect "this is a literal proper noun" before embedding.

## Lexical-fallback benchmark — Bucket 4 result

Before committing to a fix, we benchmarked the cheapest proposed mitigation: add a Mongo regex / `$text` lookup on `JamieVectorMetadata.metadataRaw.text` and run it in parallel with (or as a fallback after) the vector path.

### Setup

Read-only benchmark via `scripts/benchmark-lexical-fallback.js` (since deleted). Connected to prod Mongo via the existing `MONGO_URI`. Per-query ceiling of 8s `maxTimeMS` so a single COLLSCAN couldn't tie up a worker indefinitely. Each probe = 1 explain + 2 timed `find().toArray()` runs. All projected to `{ pineconeId, metadataRaw.text }` and limited to 20 results.

### Collection state

- Database: `tabconf2023-hackathon`
- Total docs: **3,227,379**
- Paragraph docs: **3,112,074**
- Indexes on the collection: 14, none of which are text indexes. `metadataRaw.text` is indexed by no index.

The `{ type: 1 }` and `{ type: 1, guid: 1 }` indexes ARE used by the planner to narrow to paragraph docs first, but since 96% of all docs ARE paragraphs, that prefilter saves only ~3% of the work. Effectively a full-collection regex evaluation.

### Results

| Probe | Wall P50 | Server exec time | docsExamined | Stage | Outcome |
|---|---|---|---|---|---|
| **rare-substring (`/lncurl/i`)** | **8.26s** | 171.30s | 3,112,074 | IXSCAN+regex | TIMEOUT (0 hits found in 8s) |
| **spelled-out (`/l n c u r l/i`)** | **8.21s** | 194.13s | 3,112,074 | IXSCAN+regex | TIMEOUT |
| common token (`/bitcoin/i`) | 122ms | 25ms | 48 | IXSCAN+regex | 20 results (short-circuit) |
| mid-frequency (`/alby hub/i`) | **8.14s** | 175.59s | 3,112,074 | IXSCAN+regex | TIMEOUT |
| anchored prefix (`/^lncurl/i`) | **8.22s** | 170.40s | 3,112,074 | IXSCAN+regex | TIMEOUT |

### The killer insight

**Regex performance is inversely proportional to query rarity.** Common queries like `bitcoin` short-circuit fast because the engine fills the `limit: 20` within the first 48 docs scanned. Rare queries — exactly the proper-noun, novel-domain, hard-to-find lookups this fix is meant to address — have to scan all 3.1M paragraphs before timing out.

The unbounded server-side execution time tells the rest of the story: a single `lncurl` query, run without `maxTimeMS`, would take ~3 minutes (171s) of CPU on a Mongo worker. We can't ship that.

The anchored prefix `^lncurl` performed identically to the unanchored case because Mongo's anchored regex still requires a B-tree index on the field to skip work — and we don't have one on `metadataRaw.text`.

### Bucket assignment

**Bucket 4.** Plain-regex lexical fallback (Option A in the original plan) is dead. Even with a bounded timeout, it returns zero useful answers for the cases that matter. Without a timeout, it's a stability hazard.

## What this rules in / rules out

### Ruled out

- **Option A (regex fallback, no schema change).** Empirically too slow on rare tokens. Killed.

### Still on the table

- **Option D1: Mongo `$text` index on `metadataRaw.text`**
  - Build cost: index build on 3.1M docs is probably 10-60 minutes. Should be done as a background index. Disk overhead: O(unique tokens × occurrences) — likely several GB.
  - Runtime cost: `$text: { $search: "lncurl" }` should be sub-100ms when there's an index.
  - Recall trade-off: tokenizer-based. Default Mongo tokenizer would NOT match `"l n c u r l"` against the query `"lncurl"` — those are 7 tokens vs 1 token. So this fixes the rare-token case (a doc that contains the literal `lncurl` token would surface) but does NOT fix Roland's exact failure unless we also normalize at index time.
  - **Verdict**: necessary but not sufficient on its own.

- **Option D2: Index-time normalization (`searchableText` parallel field)**
  - At ingest: write a normalized field that collapses spelled-out forms (`l n c u r l` → `lncurl`) and stores both. For backfill on existing 3.1M docs: a one-time migration script.
  - Pairs with D1: the text index sits on `searchableText`, not `metadataRaw.text`.
  - Engineering scope: changes the ingestor, requires a backfill, requires regression-testing the existing search pipeline against the new field.
  - **Verdict**: this is the pair that actually solves Roland's case end-to-end.

- **Option D3: Atlas Search ✅ CONFIRMED — we are on Atlas (2026-04-26)**
  - Atlas Search has built-in custom analyzers, fuzzy, autocomplete, ngrams, and shingle filters. A single search index sitting on the existing `metadataRaw.text` field can solve rare-token AND spelled-out AND fuzzy/typo cases simultaneously.
  - Index config sketch: `standard` tokenizer + `shingle` filter (concatenates adjacent tokens — produces `"l_n_c_u_r_l"` from `"l n c u r l"`, which normalizes to a token close to `"lncurl"`) + optional `synonyms` mapping for known spelled-out↔compact pairs.
  - Query shape: `aggregate([{ $search: { compound: { should: [{ phrase }, { fuzzy: { maxEdits: 1 } }, { autocomplete }] } } }, { $project }, { $limit }])` issued in parallel with the existing vector path when query is proper-noun-shaped.
  - **Major wins vs D1+D2**: no schema change, no backfill migration, no app-layer normalization function to write/maintain, fuzzy matching is built-in, index builds async on Atlas without locking writes.
  - **Scope estimate**: 0.5-1 day vs 1.5-2 days for D1+D2.

- **Option D4: Pinecone sparse-dense hybrid**
  - Pinecone supports sparse vectors alongside dense. BM25-encoded sparse vectors at ingest let us run hybrid queries (dense for semantic + sparse for literal). Solves the rare-token case at the vector-store layer.
  - Substantial rework: needs a sparse encoder service, ingest pipeline change, query-time dual-encoding, and a new Pinecone index config.
  - Doesn't trivially solve the spelled-out problem either — still needs index-time normalization.
  - **Verdict**: heavier than D1+D2 for similar payoff. Defer unless we want to consolidate retrieval at the vector store.

- **Option D5: Re-embedding to `text-embedding-3-large`**
  - Modern embedders handle novel proper nouns and OOV tokens significantly better than ada-002.
  - Cost estimate: 3M paragraphs × ~200 tokens avg × $0.13 / 1M tokens (3-large) ≈ ~$80 in OpenAI fees. Plus Pinecone re-upsert. Plus a new index for the 3072-dim vectors.
  - **Does NOT fix Roland's case.** `"lncurl.lol"` and `"l n c u r l dot l o l"` are semantically distant in ANY embedding space — they're literally different word sequences from the embedder's POV. Better embeddings help when query and doc share a core concept with different phrasings; they don't help when query and doc are different tokens.
  - **Verdict**: park as a separate quality-improvement project for unrelated recall failures (novel brand names, technical jargon coined after 2022 that ada-002 never saw). Do NOT bundle into the proper-noun fix.

### Cheapest prompt-only mitigation (independent of D1-D5)

- **Option C: Agent prompt update**
  - Detect proper-noun queries (URL, all-lowercase no-space token, capitalized brand) at the agent layer. Pass them literally on the first call. On miss, do a query expansion call with spelled-out variants.
  - Doesn't solve recall in itself if the underlying retrieval is the bottleneck — but it WOULD improve the cases where the embedder almost-but-not-quite finds the right thing, and it's nearly free to ship.
  - **Verdict**: ship alongside any retrieval-layer fix as belt-and-suspenders.

## Recommended next step

The empirically-honest framing is:

1. **Roland's exact case requires shared-tokenization between query and document.** No retrieval engine — vector OR lexical — that compares the literal token `"lncurl.lol"` against the literal tokens `"l", "n", "c", "u", "r", "l"` in the document will produce a hit. We need an analyzer chain that produces overlapping tokens from both forms.

2. **Confirmed 2026-04-26: we are on Mongo Atlas.** This makes Atlas Search (Option D3) the right path. Atlas Search dominates a regular-Mongo `$text`+`searchableText` migration on every dimension: no schema change, no backfill migration, no hand-rolled normalization function, fuzzy matching is built-in, and the index builds async without locking writes.

3. **The recommended fix is D3 + C**:
   - Configure an Atlas Search index on `metadataRaw.text` with a custom analyzer chain (standard tokenizer + shingle filter, optionally with a synonyms mapping)
   - Add a parallel `$search` aggregation in `searchQuotes` triggered when the query is proper-noun-shaped or vector returns weak results
   - Tweak the agent prompt to detect literal proper-noun queries and pass them as-is without semantic rewriting

4. **Scope estimate**: 0.5-1 day. Breakdown:
   - 0.25 day: design + create the Atlas Search index (index config tuning is the main risk; iterate against an adversarial query set)
   - 0.25 day: searchQuotes integration (`$search` aggregation, merge with vector results, gating heuristic for "proper-noun-shaped")
   - 0.25 day: agent prompt update for proper-noun detection
   - 0.25 day: end-to-end verification against `lncurl.lol` case + adversarial query set

5. **Resolved questions**:
   - ~~Are we on Mongo Atlas?~~ → **Yes (confirmed 2026-04-26).** D3 is the path.
   - ~~Should the embedding-model upgrade be bundled?~~ → **No.** It does not fix this case (semantically-distant tokens stay distant in any embedding space). Parked as a separate quality project.

6. **Open todo**: brainstorm a small adversarial query set of known-failing proper-noun cases beyond `lncurl.lol`. Used to (a) tune the Atlas Search analyzer config and (b) regression-test the fix end-to-end. User has none top-of-mind today; capture them as they come up.

## What shipped (2026-04-27)

### Atlas infra (manual, done)

- M20 storage bumped 42 GB → 64 GB on the cluster (~$14.40/mo additional for the Azure-premium-SSD storage delta) to accommodate the search index.
- Empty Mongo collection `searchSynonyms` created in the `tabconf2023-hackathon` database. Used by the Atlas Search index as the source for the `brand_aliases` synonym mapping. Documents follow Atlas Search's synonym-collection format (`{ mappingType: 'equivalent', synonyms: [...] }`). Curated entries to be added over time as adversarial cases surface.
- Atlas Search index `paragraph_text_search` created on `tabconf2023-hackathon.jamieVectorMetadata`. Index size on disk: **11.52 GB**. Configuration:
  - `mappings.dynamic = false`. Indexed fields: `type`, `feedId`, `guid` (token), `publishedTimestamp` (number), `metadataRaw.text` (string, `lucene.standard` analyzer, with `multi.shingleSquashed` sub-field using a custom analyzer).
  - Custom analyzer `shingleSquashed`: `standard` tokenizer + `lowercase` + `asciiFolding` + `shingle 2-6` + `regex` filter that strips spaces from each shingle. Produces tokens like `lncurl` from a transcript that contains `"l n c u r l"`. The `searchAnalyzer` for the sub-field is `lucene.standard` so a query of `lncurl` matches without re-shingling.
  - Synonyms block `brand_aliases` sourced from `searchSynonyms` (currently empty, ready for curation).

### Code (committed, kill switch OFF)

- `utils/properNounDetector.js` — `isProperNounShaped(query)` heuristic. Detects URL/domain, hashtag, hyphenated identifier, capitalized multi-word brand, CamelCase, mostly-uppercase short token, and "low-vowel-ratio compact token" patterns. False positives are cheap (extra query); calibrated to be permissive.
- `services/atlasTextSearch.js` — thin `$search` aggregation wrapper. Compound query has four primary `should` clauses (boosted): `phrase` exact match (boost 4), `text` with `fuzzy: { maxEdits: 2, prefixLength: 1 }` (boost 2), `text` on the `shingleSquashed` sub-field (boost 3), `text` with the `brand_aliases` synonym mapping (boost 2). Plus a query-time **URL-shape expansion**: when the query contains `.`, `/`, or `\`, each ≥3-char sub-token is added as an additional `text` clause against the shingle-squashed path (boost 2). Hyphens and underscores are deliberately excluded from the split set — `BIP-32` is already handled by the standard analyzer, and including hyphens caused a regression where generic-BIP-mention docs out-ranked actual `BIP 32` docs. Filters mirror the Pinecone path (`type: paragraph`, optional `feedId`, `guid`, `publishedTimestamp` range). Hard 5s `maxTimeMS`. Errors swallowed and logged — lexical is a non-critical parallel path.
- `services/searchQuotesService.js` — the lexical path runs in parallel with the Pinecone embedding via `Promise.all` when `PROPER_NOUN_SEARCH_ENABLED=true` AND `isProperNounShaped(query)` AND no `episodeName` filter. `mergeVectorAndLexical` interleaves results literal-first, dedupes by `pineconeId`, caps at `limit`. Each result now carries a `source: 'vector' | 'lexical' | 'both'` field and (when applicable) both `vectorScore` and `lexicalScore`. Response gains a top-level `lexical: { activated, latencyMs, hits }` field for observability.
- `setup-agent.js` — `PROMPT_SECTIONS.searchCrafting` gains an "EXCEPTION — proper nouns, brands, URLs, hashtags, novel coinages" sub-rule instructing the model to pass literal proper-noun queries AS-IS instead of rewriting them into semantic descriptions. Examples cover URL, brand, BIP-style identifier.
- `scripts/smoke-test-atlas-search.js` — read-only manual verification script. Runs a default battery of proper-noun queries (or a custom one via CLI arg) directly through `atlasTextSearch`, then prints the matched paragraph snippets so the operator can confirm Roland's clip surfaces.

### Kill switch + rollback

- Env var `PROPER_NOUN_SEARCH_ENABLED` (string `"true"` to enable). Default OFF — deploy is a no-op until flipped.
- Rollback: set `PROPER_NOUN_SEARCH_ENABLED=false` (or unset) in the env and restart. Traffic immediately reverts to vector-only.
- Atlas index is independent of the env var. Even if the env var is OFF the index continues to exist (storage cost) but is not queried.

## Bugs caught during verification (2026-04-27)

The smoke test ran twice on 2026-04-27 and surfaced two bugs in `services/atlasTextSearch.js` that were fixed before declaring the lexical path healthy:

1. **Multi-field path syntax was wrong.** The shingle-squashed clause used `path: 'metadataRaw.text.shingleSquashed'` (dotted-string form). Per Atlas Search's [path-construction docs](https://www.mongodb.com/docs/atlas/atlas-search/path-construction/), querying a `multi` sub-field requires `path: { value: 'metadataRaw.text', multi: 'shingleSquashed' }`. The dotted form silently matched nothing, which is why `lncurl` initially returned only `lnurl` fuzzy hits and never Roland's clip. Confirmed by querying both forms in Atlas Search Tester — the `{ value, multi }` form returned Roland's paragraph; the dotted form returned 0.
2. **No URL-shape expansion.** Even with the shingle path fixed, `lncurl.lol` still returned 0 hits because lucene.standard's `searchAnalyzer` either keeps `lncurl.lol` as one token or splits to `["lncurl", "lol"]` — neither maps to the indexed shingle-squashed token `lncurl` produced from spelled-out `l n c u r l`. Added a query-time `splitPunctuationTokens` helper that splits on `.`, `/`, `\` (URL-shaped only) and adds each ≥3-char sub-token as an additional shingle-path clause. Initial implementation also split on `-`/`_`, which surfaced a `BIP-32` regression (generic-BIP docs out-ranked actual BIP-32 docs because `bip` matched many shingles) — narrowed to URL-shape only, regression resolved.

Final smoke test (2026-04-27, post-fix) confirmed:
- `lncurl.lol` → Roland's `Roundtable_018` clip at #1 (score 41.346)
- `lncurl` → Roland's clip at #1 (score 37.371), `lnurl` fuzzy hits ranked below
- `l n c u r l` → Roland's clip at #1 (score 133.430)
- `Alby Hub`, `Nostr Wallet Connect`, `BIP-32`, `#nostr` → all healthy, top hits stay topical

## Verification + go-live checklist

1. ☑ Run `node scripts/smoke-test-atlas-search.js`. Confirm `lncurl.lol` returns Roland's Roundtable_018 paragraph at #1, and other proper-noun probes stay healthy. **Done 2026-04-27.**
2. ☐ Set `PROPER_NOUN_SEARCH_ENABLED=true` in local `.env`. Restart the server.
3. ☐ Run a hand-crafted agent query that includes `lncurl.lol` end-to-end (via `POST /api/pull` with `X-Free-Tier: true` for local). Confirm the response cites the Roundtable_018 paragraph. Inspect logs for `[SEARCH-...] Lexical activated` line + `lexical.activated/latencyMs/hits` field on the search response.
4. ☐ Add `PROPER_NOUN_SEARCH_ENABLED=true` to prod env. Deploy. Watch logs for activation rate and average lexical latency over the first hour.
5. ☐ Optionally seed the `searchSynonyms` collection with the first known equivalence class (e.g. Alby spelling variants).

## Maintenance — `searchSynonyms` curation

When a known-failing proper-noun case surfaces (a brand, person, or product name with multiple spellings or pronunciations the fuzzy/shingle paths don't recover), add a doc to `searchSynonyms`:

```json
{ "mappingType": "equivalent", "synonyms": ["alby", "albi", "albee", "albie", "albey"] }
```

For one-way mappings (input must be the canonical form):

```json
{ "mappingType": "explicit", "input": ["lncurl"], "synonyms": ["ln-curl", "ln curl", "lncurl.lol"] }
```

Atlas picks up changes at query time — no app restart, no index rebuild. Keep entries lower-cased; the synonym analyzer is `lucene.standard`.

## Related files

- [services/searchQuotesService.js](../../services/searchQuotesService.js) — parallel lexical+vector retrieval, merge logic
- [services/atlasTextSearch.js](../../services/atlasTextSearch.js) — `$search` aggregation wrapper
- [utils/properNounDetector.js](../../utils/properNounDetector.js) — `isProperNounShaped` heuristic
- [scripts/smoke-test-atlas-search.js](../../scripts/smoke-test-atlas-search.js) — manual verification
- [setup-agent.js](../../setup-agent.js) — agent prompt with proper-noun exception
- [agent-tools/pineconeTools.js](../../agent-tools/pineconeTools.js) — vector retrieval (unchanged)
- [models/JamieVectorMetadata.js](../../models/JamieVectorMetadata.js) — schema (unchanged; Atlas Search index is metadata-only)

## LLM-driven query expansion (shipped 2026-04-27, kill switch OFF by default)

After the Atlas Search lexical path went live, manual testing surfaced a second-order recall problem the lexical path alone could not fix: **ASR phonetic mismatch across feeds.**

### The gap the lexical path leaves open

Roland's email referenced two podcasts that mention `lncurl.lol`:

1. **Bitcoin Audible (Guy Swann)** — transcript reads `"l n curl. It's l n curl dot loll. So l n c u r l dot l o l."`. The Atlas Search shingle-squashed analyzer collapses `"l n c u r l"` into the indexed token `lncurl`, so a user query of `lncurl.lol` matches at score 41+ via the lexical path.
2. **Stacker News Live (SNL)** — same product, but the speaker pronounced the name run-together as `"Ellen Curl."` The ASR transcribed that literally as `"Ellen Curl"`. The shingle-squashed analyzer cannot collapse that token sequence into `lncurl` because the spoken form genuinely is `ellencurl`, not `l n c u r l`. Both are valid English-language transcriptions of the same coined term.

A user querying `lncurl.lol` (or `ln curl`) gets only Bitcoin Audible. A user querying `ellen curl` gets only SNL. The two communities never see each other's coverage. **No lexical analyzer chain — fuzzy, shingle, synonym, or otherwise — can bridge `lncurl` and `ellencurl` automatically**, because the edit distance is large and the phonemes overlap is L→Ellen, which is a homophone humans recognize but tokenizers cannot.

### The fix: LLM-driven query expansion

When a user (or the agent) queries a proper-noun-shaped term, run a fast `gpt-4o-mini` call in parallel with the embedding to generate up to 5 alternate spellings/transcriptions an ASR might produce when the term is spoken aloud. Pass those variants to `atlasTextSearch` as `extraQueries`, where each variant is added to the `compound.should` array with a **lower boost (1.5)** than the original query's clauses (boost 2-4) to prevent a low-quality variant from outranking a real hit.

The expansion call:
- Uses `gpt-4o-mini` (already wired via `openai` client) at `temperature: 0.3`, `max_tokens: 200`
- 2-second hard timeout via `Promise.race` — if the LLM is slow, fall back to lexical-without-expansion
- Returns up to 5 sanitized variants (max 50 chars each, deduped, original query excluded)
- In-memory LRU cache keyed by exact query string, capped at 1000 entries — repeated queries (the common case) cost zero
- Logs to `[ProperNounExpansion-${requestId}]`

System prompt directs the model to include letter-by-letter spell-outs (`L N curl`), run-together phonetic homophones (`ellen curl`), common misspellings, and TLD-stripped forms. Output is strict JSON array — no prose, no markdown.

### Insertion point

`services/searchQuotesService.js` runs the expansion in parallel with the embedding via `Promise.all`, so the LLM call is fully masked by Pinecone latency. By the time the lexical path is ready to fire, expansion variants are in hand. The lexical aggregation runs second, so it gets full benefit of the variants without adding any wall-clock latency.

### Kill switch

Env var `PROPER_NOUN_LLM_EXPANSION_ENABLED` (string `"true"` to enable). Default OFF. Layered behind `PROPER_NOUN_SEARCH_ENABLED` — expansion only fires when the lexical path is also enabled and the gate matches. Rollback: unset the env var, restart. Lexical path keeps working.

### Validation — adversarial cohort run 2026-04-27

Ran a 5-query proper-noun cohort via `tests/agent-comparison.js` (cohort6) against `localhost:4132` with `PROPER_NOUN_LLM_EXPANSION_ENABLED=true`. Full output: `tests/output/comparison-2026-04-27T20-31-44.md`.

| # | Query | Outcome | Latency | Cost | Notes |
|---|---|---|---|---|---|
| 1 | `what is lncurl.lol and what is it used for?` | **WIN** | 53s | $0.026 | Surfaced Roland's Roundtable_018 paragraph at #1 with clip card. |
| 2 | `tell me about ellen curl` | **HOME RUN** | 44s | $0.022 | Bridged "Ellen Curl" → lncurl.lol. Surfaced **both** Stacker News Live AND Bitcoin Audible. Explicitly answered the original "designed for AI agents" claim. This is the validation of the expansion mechanism. |
| 3 | `what is x402 used for?` | DSML leak (pre-existing) | 41s | $0.027 | Hit max rounds → DeepSeek synthesis emitted raw `<｜DSML｜tool_calls>` markup. Strip filter caught `text_done` (281→0 chars) but raw deltas already streamed. **Not caused by expansion** — `isProperNounShaped` rejects multi-word natural-language queries with embedded proper nouns, so expansion never fired. Tracked as F1+F2 follow-ups in `WIP.md`. |
| 4 | `what has been said about zaprite` | No regression | 55s | $0.027 | 8 distinct clip cards. Expansion did not pollute. |
| 5 | `what about nostr on podcasts` | No regression | 46s | $0.018 | Only 4 rounds (efficient). Boost weighting prevented variant-flooding. |

Aggregate: mean cost $0.024, mean latency 48s, total spend $0.12. 4/5 wins; 1 pre-existing DeepSeek synthesis edge case unrelated to this feature.

### Code (committed, kill switch OFF)

- `services/properNounLLMExpansion.js` — new module. Calls `gpt-4o-mini`, parses + sanitizes variants, caches results.
- `services/atlasTextSearch.js` — `buildShouldClauses(query, extraQueries = [])` accepts the variants. Each variant is added as `text` clauses against both `metadataRaw.text` (lucene.standard) and `metadataRaw.text` `multi: 'shingleSquashed'` paths with `boost: 1.5`. Original-query clauses keep their original boost (2-4) so they outrank variants on tie.
- `services/searchQuotesService.js` — gates expansion on `PROPER_NOUN_LLM_EXPANSION_ENABLED && lexicalActivated`. Runs `expandProperNounQuery` and `embeddings.create` in parallel via `Promise.all`. Passes `expansionVariants` to `atlasTextSearch` as `extraQueries`. Logs include `llmExpansion=N variant(s) [...]` suffix when active.

### Tuning knobs (currently hardcoded — see `WIP.md` housekeeping section)

| Constant | Default | Location | Notes |
|---|---|---|---|
| `MODEL` | `gpt-4o-mini` | `properNounLLMExpansion.js` | Pinned cheap, fast model |
| `TIMEOUT_MS` | `2000` | `properNounLLMExpansion.js` | LLM hard timeout |
| `MAX_VARIANTS` | `5` | `properNounLLMExpansion.js` | Upper bound per query |
| `CACHE_MAX` | `1000` | `properNounLLMExpansion.js` | LRU cache size |
| Expansion-clause boost | `1.5` | `atlasTextSearch.js` `buildShouldClauses` | Lower than original clause boosts (2-4) to prevent variant flooding |

## Provenance

- Email exchange: Roland Bewick (Alby) → Jim Carucci, Apr 23 2026, "Re: Beta Release of Jamie - General Purpose Agent Endpoint"
- Benchmark script: `scripts/benchmark-lexical-fallback.js` (deleted post-analysis per the plan)
- Benchmark run: 2026-04-26, prod Mongo (`tabconf2023-hackathon` DB), commit-on-disk at the time of run
- Atlas Search index created + storage bump: 2026-04-27
- LLM expansion layer shipped + validated: 2026-04-27 (`tests/output/comparison-2026-04-27T20-31-44.md`)
