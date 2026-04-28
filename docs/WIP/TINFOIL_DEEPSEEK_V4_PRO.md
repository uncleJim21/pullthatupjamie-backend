# Tinfoil DeepSeek V4-Pro — Verification & Integration Runbook

Last updated: **2026-04-26**

This doc captures the empirical findings from the day Tinfoil shipped DeepSeek V4-Pro on their confidential inference platform, plus the open work needed before it can replace our current production default (`deepseek-v4-flash-direct`) for `/api/pull` traffic.

For the broader cost/quality case for moving off Haiku, see `DEEPSEEK_V4_TRANSITION_PLAN.md`. This doc is specifically about the **Tinfoil branch** of that rollout.

## TL;DR

- ✅ **`deepseek-v4-pro` is live on Tinfoil** — confirmed via `/v1/models`.
- ✅ **Tool calls work** — single-round and multi-round chained.
- ✅ **Streaming works at the endpoint** — 24 SSE chunks in 250ms on a hello-world.
- ❌ **`deepseek-v4-flash` is NOT yet hosted by Tinfoil.** Only Pro.
- ⚠️ **Chained-call argument double-encoding bug** — DeepSeek V4 occasionally wraps tool args in an extra `{ "arguments": "<json string>" }` layer on the **second+** tool call. Affects both Tinfoil and direct DeepSeek; needs a defensive unwrap in `tinfoilProvider.js` and `deepSeekProvider.js` before either V4-Pro provider is production-safe in our agent loop.
- ⚠️ **`tinfoilProvider` is still hard-coded `stream: false`** (`utils/agent/providers/tinfoilProvider.js:158`) — needs the same SSE refactor that already landed in `deepSeekProvider.js`.
- ❓ **Tinfoil pricing for DeepSeek is not on the public docs page.** Earlier projection (`$4.35` input / `$6.10` output per 1M for Pro) is a Kimi/GLM-derived extrapolation, not a confirmed rate. Needs verification with Tinfoil before registry pricing is trustworthy.

## Verification probes (2026-04-26)

### 1. Model availability

`GET https://inference.tinfoil.sh/v1/models` returned 14 models including:

```
deepseek-v4-pro          ← new
gemma4-31b
glm-5-1
gpt-oss-120b
gpt-oss-safeguard-120b
kimi-k2-6
llama3-3-70b
...
```

No `deepseek-v4-flash`. Tinfoil's docs page ([docs.tinfoil.sh/models/chat](https://docs.tinfoil.sh/models/chat)) confirms V4-Pro: 1.6T total / 49B activated MoE, 800K context window (Tinfoil's deployment, not the upstream 1M).

### 2. Single-round tool call

```js
{
  model: "deepseek-v4-pro",
  messages: [
    { role: "system", content: "...use the find_person tool..." },
    { role: "user", content: "Find episodes featuring Joe Rogan." },
  ],
  tools: [{ type: "function", function: { name: "find_person", parameters: {...} } }],
  tool_choice: "auto",
}
```

Result: **HTTP 200 in 2.3s**, `finish_reason: tool_calls`, clean OpenAI-shape tool call:

```json
{
  "id": "chatcmpl-tool-a331c750bd718983",
  "type": "function",
  "function": { "name": "find_person", "arguments": "{\"name\": \"Joe Rogan\"}" }
}
```

### 3. Multi-round chained tool calls

Three rounds, ~11s end-to-end, with simulated tool results fed back via standard OpenAI `role: "tool"` messages:

| Round | Latency | Action | Result |
|---|---|---|---|
| 1 | 2.6s | `find_person({ name: "Lex Fridman" })` | Clean shape, correct args |
| 2 | 3.1s | Chains to `search_quotes` using `guest_guid` from round 1 | Threaded prior tool result correctly |
| 3 | 4.9s | `finish_reason: stop` — synthesizes final answer with both shareLinks cited | Clean prose, no markup leakage |

**This is the test Gemma 4 31B failed at.** V4-Pro maintains tool_call → tool_result → tool_call → tool_result → final-text state across the conversation without degenerating, hallucinating tool results, or emitting native DSL as plaintext.

### 4. Streaming at the endpoint

```
HTTP 200
content-type: text/event-stream; charset=utf-8
24 SSE chunks, first at 646ms, last at 890ms
text: "Hello, nice to meet you today!"
```

Tinfoil's deployment streams DeepSeek properly. The block we currently see in production is purely a **client-side** issue (`tinfoilProvider.js` hard-codes `stream: false`).

## Known gotcha: chained-call argument double-encoding

In **round 2** of the multi-round probe, V4-Pro returned this:

```json
"arguments": "{\"arguments\": \"{\\\"query\\\": \\\"consciousness\\\", \\\"guest_guid\\\": \\\"lex-fridman-guid-001\\\", \\\"limit\\\": 5}\"}"
```

A single `JSON.parse` yields:

```js
{ arguments: '{"query":"consciousness","guest_guid":"lex-fridman-guid-001","limit":5}' }
```

…instead of the expected `{ query, guest_guid, limit }`. Our `agentToolHandler` would receive `{ arguments: "..." }` and either crash (schema validation) or silently misinterpret it.

This is a known DeepSeek V4 quirk — has been observed on direct DeepSeek too, not Tinfoil-specific. Both `tinfoilProvider.js` and `deepSeekProvider.js` need a defensive unwrap when normalizing tool arguments. Pseudocode:

```js
function parseToolArgs(rawArgs) {
  let parsed;
  try { parsed = JSON.parse(rawArgs || '{}'); } catch { return {}; }
  // Defensive unwrap: V4 occasionally double-encodes chained tool calls
  // as { arguments: "<inner json string>" }. Re-parse if we detect it.
  if (parsed
      && typeof parsed === 'object'
      && Object.keys(parsed).length === 1
      && typeof parsed.arguments === 'string'
      && parsed.arguments.trim().startsWith('{')) {
    try { return JSON.parse(parsed.arguments); } catch { return parsed; }
  }
  return parsed;
}
```

Apply at the spot in each provider where `JSON.parse(tc.function.arguments)` happens. Log a `console.warn` when the unwrap fires so we can track frequency.

**Severity:** This blocks any V4-Pro provider (Tinfoil or direct) from being safe as the agent default for multi-round queries. Single-round queries (Joe Rogan psychedelics in round 1, no chaining) won't trigger it. The bigger the agent loop, the higher the chance of hitting this.

## Open work, in order

### 1. (low risk, high value) Defensive arg-unwrap

Apply the `parseToolArgs` helper above to `utils/agent/providers/tinfoilProvider.js` and `utils/agent/providers/deepSeekProvider.js`. Log when the unwrap fires.

This unblocks V4-Pro on either provider for the agent loop. Should be ~10 lines per file, plus a test if the testing setup supports it.

### 2. (medium) Register `deepseek-v4-pro-tinfoil` in `constants/agentModels.js`

```js
'deepseek-v4-pro-tinfoil': {
  key: 'deepseek-v4-pro-tinfoil',
  provider: 'tinfoil',
  id: process.env.TINFOIL_DEEPSEEK_V4_PRO_MODEL || 'deepseek-v4-pro',
  // PROVISIONAL — Tinfoil hasn't published $/1M for DeepSeek yet. These
  // are the original 2026-04-24 projections (2.5x/1.75x markup vs
  // direct rates). Replace with empirical numbers from a real billing
  // cycle before treating cost reports as authoritative.
  inputPer1M: parseFloat(process.env.TINFOIL_DEEPSEEK_V4_PRO_INPUT_PER_1M || '4.35'),
  outputPer1M: parseFloat(process.env.TINFOIL_DEEPSEEK_V4_PRO_OUTPUT_PER_1M || '6.10'),
  label: 'DeepSeek V4-Pro (Tinfoil)',
},
```

Note: do NOT also register `deepseek-v4-pro` (without the suffix) under the Tinfoil provider — that key is already taken by the OpenRouter entry. The `-tinfoil` suffix matches the existing `-direct` convention used by `deepseek-v4-flash-direct`.

### 3. (medium) Run the 3-query benchmark against Tinfoil V4-Pro

Same queries as the 2026-04-24 reference run so results are comparable:

```bash
node tests/agent-comparison.js \
  --queries 1,4,9 \
  --models fast,deepseek-v4-pro-tinfoil,deepseek-v4-pro-direct \
  --save
```

Compare across:
- LLM cost per pull
- Latency (Tinfoil enclave inference adds overhead vs direct DeepSeek)
- Clip coverage (does Pro still drop `{{clip:}}` tokens like Haiku does on hard queries?)
- Token counts (cache-hit ratio is invisible to us until we wire that in — see #5 below)

If V4-Pro-Tinfoil costs ≥ 3× V4-Pro-Direct AND output quality isn't materially better, the privacy story is the only remaining argument for Tinfoil routing. That's a real argument but should be a deliberate decision, not a default.

### 4. (large) Port SSE streaming into `tinfoilProvider.js`

The `deepSeekProvider.js` SSE refactor (2026-04-25) is the reference implementation. Same pattern applies:

- Replace `stream: false` with `stream: true` + `stream_options: { include_usage: true }`
- Read `resp.body` chunk-by-chunk via `for await (const chunk of resp.body)`
- Parse `data: {...}` SSE lines; accumulate `delta.content`, `delta.reasoning_content`, indexed `delta.tool_calls[]`
- Fire `onTextDelta(text)` per content chunk
- Honor the `aborted()` predicate per chunk so synthesis-deadline / user-abort flows work
- Build the same `{ content, stop_reason, usage }` shape on completion

Until this lands, `/api/pull` traffic on any Tinfoil model shows a silent 30–60s block before the full response dumps. This is a UX blocker, not a correctness blocker — but it makes Tinfoil unusable for the user-facing endpoint regardless of model quality.

### 5. (medium) Expose Tinfoil's prompt-cache pricing if it exists

DeepSeek's direct API exposes `prompt_cache_hit_tokens` in the response usage object. Our cost tracker (already noted in `routes/agentChatRoutes.js`) doesn't account for this yet — every input token is billed at the cache-miss rate. With multi-round agents and a stable 7k-token system prompt, real cache-hit rates of 80–95% are common, and the actual bill is 30–50% of what we report.

Open question: does Tinfoil's OpenAI-compatible response surface that field? Probe needed:

```bash
node -e '...' # send a request, then a near-identical second request, log usage object on both
```

If yes, the cost tracker fix that needs to land for direct DeepSeek will work for Tinfoil for free.

### 6. Reach out to Tinfoil for actual $/1M rates for DeepSeek V4-Pro

The `$4.35` input / `$6.10` output projection in this doc and in `DEEPSEEK_V4_TRANSITION_PLAN.md` is a guess based on Kimi/GLM markup factors. Until confirmed, do not trust cost reports for `deepseek-v4-pro-tinfoil` runs.

## Probe scripts

For reproducibility — these are the scripts used in this verification run. None of them are checked in; they were one-shot probes:

- **List models**: `GET https://inference.tinfoil.sh/v1/models` with bearer auth
- **Single-round tool call**: `POST /chat/completions` with `find_person` tool
- **Multi-round chain**: same, three rounds, simulated tool results between
- **Streaming probe**: `POST /chat/completions` with `stream: true`, count chunks

Recreate from the conversation transcript at `/Users/jamescarucci/.cursor/projects/Users-jamescarucci-Documents-GitLab-pullthatupjamie-backend/agent-transcripts/` if needed.

## Related files

- `constants/agentModels.js` — registry; add `deepseek-v4-pro-tinfoil` here
- `utils/agent/providers/tinfoilProvider.js` — needs (a) defensive arg unwrap, (b) SSE streaming port
- `utils/agent/providers/deepSeekProvider.js` — needs the same defensive arg unwrap
- `routes/agentChatRoutes.js` — orchestrator; cache-hit-aware cost tracking belongs here
- `tests/agent-comparison.js` — benchmark harness for the 3-query run
- `docs/WIP/DEEPSEEK_V4_TRANSITION_PLAN.md` — economic / strategic case (the parent doc)
- `docs/TINFOIL_GEMMA_BENCHMARK_RUNBOOK.md` — historical; how Gemma was ruled out
