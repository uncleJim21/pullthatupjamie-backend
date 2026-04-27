# Agent Synthesis Pass

## What it is

When the main agent loop exits **without** the model producing a clean prose
answer (round budget exhausted, latency cap hit, hard tool-call cap, etc.),
we fall back to a single **synthesis call**: one final, tool-less LLM
invocation whose only job is to turn the conversation history (which already
contains all the search results, transcripts, and adjacent paragraphs the
agent gathered) into a user-facing response.

The synthesis call lives in `routes/agentChatRoutes.js` inside the
`if (!naturalCompletion) { ... }` branch. It uses a dedicated prompt
(`buildSynthesisPrompt`) that overrides the default search prompt and
hard-bans tool-call markup, intermediate reasoning, and fabricated citations.

## The DSML leak problem

DeepSeek (and any model whose native tool protocol is a custom in-band DSL,
not OpenAI-style structured tool calls) has a failure mode we observed in
production: when the conversation history shows tool calls and tool results
from earlier rounds, but the new request strips `tools` from the payload,
the model "remembers" it has tools and falls back to **inlining its native
tool-call DSL as plaintext** in the response body. Concretely, this looks
like:

```
<｜DSML｜tool_calls｜begin｜>
{ "name": "search_quotes", "arguments": { "query": "..." } }
<｜DSML｜tool_calls｜end｜>
```

The output stream then leaks raw markup into the user's screen mid-answer.
This was the root cause of multiple cut-off / garbled responses (`x402`,
`PayPal Mafia`, `lncurl.lol`, `tariffs`, `Luke Gromen`).

## The fix: `tool_choice: 'none'`

Per [DeepSeek's API guide](https://api-docs.deepseek.com/guides/function_calling),
the documented way to forbid tool invocation while keeping the model "tool
aware" is `tool_choice: 'none'`. This is also the OpenAI spec and is honored
by every OpenAI-compatible upstream we use (DeepSeek, Tinfoil, OpenRouter).

Crucially, when sending `tool_choice: 'none'` we **keep the tool schemas
attached** to the request. The combination tells the model:

  > "These tools exist (so the conversation history is consistent with the
  > current request), but you may not call any of them in this turn — emit
  > prose only."

Without `tool_choice: 'none'` and an empty `tools: []`, DeepSeek sees a
contradiction (history shows tool calls, but the request says no tools
exist) and the DSML inlining is its fallback behavior. This is in addition
to — not a replacement for — the synthesis prompt's textual ban on markup.

### What the providers do

All OpenAI-compatible providers (`deepSeekProvider`, `tinfoilProvider`,
`openRouterProvider`) translate `toolChoice: 'none'` directly to
`tool_choice: 'none'` and keep the tool schemas attached.

The Anthropic provider translates `toolChoice: 'none'` to Claude's object
form: `tool_choice: { type: 'none' }`.

The default codepath (`toolChoice` undefined) is unchanged: `tool_choice:
'auto'` is attached only when at least one tool is supplied; both fields
are omitted otherwise (the OpenAI spec rejects `tools: [] + 'auto'`).

## Defense in depth

The synthesis pass relies on three independent safeguards. If any one is
weakened, the others should still hold:

1. **`tool_choice: 'none'`** (this doc) — protocol-level guarantee that
   the model will not emit a structured tool call. For DeepSeek, also
   suppresses the DSML fallback.
2. **`buildSynthesisPrompt`** — system prompt that explicitly forbids
   tool-call markup, narration, and intermediate reasoning. See the
   `synthesisGuard` section in `setup-agent.js`.
3. **Streaming sanitizer** — `utils/agent/sanitizeOutput.js` strips known
   tool-call markup patterns from `text_delta` and `text_done` events as
   a last line of defense for fragmented streamed markup.

## Configuration

| Env var | Default | What it controls |
|---|---|---|
| `AGENT_SYNTHESIS_MAX_TOKENS` | `4096` | `max_tokens` for the synthesis call. Increase if you see UUIDs/clip refs cut off mid-token. |
| `AGENT_SYNTHESIS_BUDGET_MS` | `15000` | Wall-clock budget for the synthesis call. The `aborted()` callback fires once exceeded. |

## Related code

- Synthesis call site: `routes/agentChatRoutes.js` (search for
  `=== SYNTHESIS ===` log markers).
- Synthesis prompt builder: `setup-agent.js` (`buildSynthesisPrompt`,
  `PROMPT_SECTIONS.synthesisGuard`).
- Provider adapters: `utils/agent/providers/{deepSeek,tinfoil,openRouter,anthropic}Provider.js`.
- Sanitizer: `utils/agent/sanitizeOutput.js`.

## History

- **2026-04 — `tool_choice: 'none'` introduced** (this doc). DSML leak
  reproduced reliably on DeepSeek synthesis fallback for `x402`, `PayPal
  Mafia`, `lncurl.lol`. Documented fix from DeepSeek's own API guide;
  empty `tools: []` replaced with `tools: effectiveTools, tool_choice:
  'none'`.
- **2026-04 — synthesis `maxTokens` raised to 4096.** Earlier 2048 cap
  was truncating clip-token UUIDs mid-string under DeepSeek's verbose
  internal "thinking" output.
- **2026-04 — `synthesisGuard` prompt added.** Default search prompt
  advertises tools; under synthesis we override it with an explicit
  "no markup, no narration, prose only" guard.
