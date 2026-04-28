# WIP — "Catch the Failure" Synthesis Fallback Plan

Status: **implemented 2026-04-27.** All three tiers wired into
`routes/agentChatRoutes.js`. Quality gate in
`utils/agent/synthesisQuality.js`. Strict prompt + Tier 3 fallback message in
`setup-agent.js` (`buildStrictSynthesisPrompt`, `TIER3_FALLBACK_MESSAGE`).
Pending: regression validation with the 20-query suite to measure post-fix
failure rate and recovery latency.

## Why this exists

The `tool_choice: 'none'` synthesis fix
([`docs/AGENT_SYNTHESIS_PASS.md`](../AGENT_SYNTHESIS_PASS.md)) closed the
protocol-level path for raw DSML emission, but the regression showed
**3/19 (16%) DeepSeek queries still produce broken output** when synthesis
runs under budget pressure. The model honors `tool_choice: 'none'` (no
structured tool calls in the output), but when it really wants to call
another tool it falls back to one of two failure modes:

| Failure mode | Example | Frequency in 20-query regression |
|---|---|---|
| **DSML markup as plaintext** | `<｜DSML｜tool_calls>...<｜DSML｜invoke name="get_adjacent_paragraphs">...` | 1/19 (Chamath) |
| **Narration-only synthesis output** | `"Let me grab more context on the key Sacks quotes."` (49 chars, no clips) | 2/19 (PayPal Mafia, Roland Alby) |

All three failures share a profile: 4-6 rounds of tool use, high cumulative
input tokens (42-70k), `naturalCompletion: false`, synthesis exit reason
either `latency_hard_cap` or `max_rounds`. Run artifact:
`tests/output/comparison-2026-04-27T21-52-20.md`. Agent logs:
`logs/agent/2026-04-27T21-43-52-517Z_AGENT-6-kwmjg8.json` (Chamath),
`...21-48-30-146Z_AGENT-7-6hcp4o.json` (PayPal),
`...21-49-08-316Z_AGENT-5-0i2mux.json` (Roland).

## Where in the loop the catch should fire

Two natural insertion points in `routes/agentChatRoutes.js`:

1. **Pre-emit gate** — after the synthesis pass populates `streamedSynthesis`
   / `fullText` and **before** the `text_done` SSE event is emitted. This
   is the primary insertion point. If the gate flags the output, suppress
   `text_done`, run a recovery pass, then emit the recovered text.
2. **Post-loop `naturalCompletion === true` gate** — for cases where the
   model exited the main loop "naturally" but with bad text (e.g. a
   premature stop after a narration phrase). Currently `naturalCompletion`
   skips synthesis entirely. Add the same quality check here so we don't
   miss this path.

## Detection rules (cheap, deterministic)

A `finalText` is considered **bad** if any of these match. All checks run
*after* `sanitizeAgentText` strips known markup:

| Rule | Heuristic | Notes |
|---|---|---|
| **R1 (length floor)** | `text.length < 500` after sanitization | 500 because every clean answer in the regression was ≥1200 chars; 49/58/280-char failures all clearly below. |
| **R2 (narration-only)** | matches `/^\s*(let me|i'?ll|i'm going to|now let me|first,? let me|allow me to|let's |perfect[!.]|great[!.]|ok(?:ay)?[,!.])/i` AND `text.length < 1500` | Catches "Let me grab more context…", "Now let me…". Narration ≥1500 chars is fine — it's an essay opener, not an abandoned tool-call prelude. |
| **R3 (markup residue)** | `hasToolCallMarkup(text)` after sanitization | `sanitizeAgentText` should already strip these, but if a sanitized output still trips this regex, treat as broken. |
| **R4 (zero-clip + had results)** | `text` has zero `{{clip:` tokens AND `agentLog.toolCalls` shows ≥1 `search_quotes` call with `resultCount > 0` AND `text.length < 1500` | Soft check — short, evidence-free output when search returned hits is suspicious. |
| **R5 (truncation tail)** | `text.endsWith('{{clip:')` OR `text.match(/\{\{clip:[^}]*$/)` | Catches the exact `{{clip:9fd5e7dc-72de-11f0-9be||` truncation pattern from the tariffs case. |

R1+R2 together catch all three observed failures; R3 is belt-and-suspenders;
R5 catches a class of bug we already paid for once.

## Recovery actions (in order of escalation)

### Tier 1 — Strict re-synthesis with the *same* model (cheap, fast)

Same provider, same model, **stricter** system prompt, same conversation
history. Differences from the standard synthesis call:

- New system prompt (`buildStrictSynthesisPrompt(intent)`):
  - Explicit "do NOT mention tools, do NOT narrate your process, do NOT
    say 'let me' or 'I'll'."
  - Explicit "if you cannot answer from the conversation history, output
    the single line: `No transcribed coverage found for this query.`"
  - Suppress the clip floor entirely — better to have a clean "no
    coverage" answer than a leaky one.
- `temperature: 0` (or as low as the provider supports) to reduce
  exploratory generation.
- `tool_choice: 'none'` (same as primary synthesis).
- `maxTokens: AGENT_SYNTHESIS_MAX_TOKENS` (4096 default, unchanged).
- Time budget: half of `AGENT_SYNTHESIS_BUDGET_MS` (default 7.5s) — if the
  primary synthesis already burned its budget, the recovery should not
  blow the user's perceived latency further.

If Tier 1 output passes the same detection rules, emit it. Otherwise
escalate to Tier 2.

### Tier 2 — Cross-provider re-synthesis (Haiku, slow path)

Same conversation history, system prompt = strict synthesis prompt,
provider switched to Anthropic Haiku (`fast` model key). Haiku does not
exhibit DSML markup leakage (different model family, different tool DSL),
which is the primary value of this tier.

Costs ~$0.04/call (vs ~$0.007 for DeepSeek synthesis), but only fires when
both Tiers 0 (primary synthesis) and 1 (strict re-synthesis) failed the
quality gate. Expected hit rate: ≤5% of synthesis runs based on the
current regression.

This is also why we kept Haiku registered — see the corresponding WIP
entry "Haiku swap-in backup path" in `WIP.md`.

### Tier 3 — Graceful degradation (last resort)

If Tier 2 ALSO fails, emit a hand-written fallback message:

> I gathered some results for your question but had trouble assembling
> them into a clean response. Try rephrasing or narrowing the question.

Plus the upsell card path if applicable.

This must always succeed — never let the user see narration/DSML/empty
output even if every recovery tier collapses.

## Observability

Every recovery tier should:

1. Log the trigger to `agentLog.synthesisRecovery`:
   ```json
   { "trigger": "R1|R2|R3|R4|R5", "tier": "tier1|tier2|tier3",
     "primaryText": "<first 200 chars>", "recoveredText": "<first 200 chars>",
     "deltaMs": 4321 }
   ```
2. Emit a `status` SSE event so the frontend can surface `"Polishing your
   answer..."` if the user is watching the stream.
3. Track in `agentLog.summary.synthesisRecoveryUsed` for downstream
   metrics. Aim to keep the recovery rate visible so we know if DeepSeek
   silently regresses.

## Anti-goals (deliberately not in scope for v1)

- **No streaming pause / hold-and-flush.** Tempting to buffer the
  synthesis output instead of streaming it, then validate before flushing.
  Costs perceived latency for the 84% of clean cases. Only adopt if v1
  shows the recovery flicker is visible/jarring to users.
- **No model-quality fine-tuning of DeepSeek.** The recovery system is
  meant to be provider-agnostic and survive provider quirks. We are not
  in the business of retraining DeepSeek.
- **No tool-call-as-text auto-execution.** Briefly considered: parse the
  DSML markup that DeepSeek emits and execute the tool call ourselves.
  Rejected — it puts us deep in DeepSeek-specific territory and opens an
  injection surface (the model could "call tools" the user shouldn't be
  able to trigger via crafted input). Strict re-synthesis is safer.

## Implementation order (when picked up)

1. Add `evaluateOutputQuality(text, agentLog)` helper → returns
   `{ ok: bool, trigger?: 'R1'|'R2'|'R3'|'R4'|'R5', reason?: string }`.
   Pure function, easy to unit test against the three logged failures.
2. Add `buildStrictSynthesisPrompt(intent)` to `setup-agent.js`.
3. Wire Tier 1 into `routes/agentChatRoutes.js` synthesis branch
   (post-synthesis, pre-`text_done`).
4. Run the 20-query regression. Verify the 3 known-bad queries recover.
5. Add Tier 2 (Haiku cross-provider). Verify against the same regression.
6. Add Tier 3 graceful-degradation message + frontend handling.
7. Hook synthesis recovery telemetry into the existing cost / latency
   summary log line for visibility.

## Open questions (defer until implementation)

- Should the strict re-synthesis prompt force absolute clip-citation
  silence (`zero clips`) or keep the soft `at least 1` rule? The fewer
  rules the model has to balance, the better its compliance — leaning
  toward zero-clip-required for Tier 1.
- Recovery latency budget: 7.5s is half of synthesis budget. If we observe
  that real recovery takes longer (Haiku Tier 2 commonly does 8-15s),
  raise the cap rather than letting Tier 2 systematically time out.
- Cache key: should recovered output be cached against the original query
  so the next identical request short-circuits? Probably yes, but only
  after we've shipped enough usage to know the cache hit rate matters.
