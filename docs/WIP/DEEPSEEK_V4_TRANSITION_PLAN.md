# DeepSeek V4 Transition Plan

Status: **Waiting for Tinfoil to host DeepSeek V4.** Tinfoil has confirmed they intend to ship it; no ETA yet.

This doc is the checkpoint from the 2026-04-24 cost/quality investigation so a future session can pick up immediately once V4 lands on Tinfoil.

## TL;DR

1. The current default (Haiku 4.5) costs us **~$0.032 per pull** to serve; we charge **$0.10** → ~68% margin.
2. DeepSeek V4-Flash (released 2026-04-24, preview) is the first open model whose economics can realistically drop cost-per-pull to **~$0.01–0.02**.
3. The follow-on strategic move is **not to pocket the savings as margin** but to **reinvest the subsidy into quality** by running 2–3 parallel worker agents per pull — trading extra tokens for breadth of search and better synthesis at the same or lower total cost vs today.

## Current state (as of 2026-04-24)

- Default model: Haiku 4.5 (`fast` in `constants/agentModels.js`)
- Retail price: $0.10 per `pull` (see `constants/agentPricing.js`)
- Tinfoil (confidential inference) integrated as a second provider; only currently-usable Tinfoil model is **Gemma 4 31B**, which fails in multi-round tool use (runaway repetition, 170 s garbage outputs — see `docs/TINFOIL_GEMMA_BENCHMARK_RUNBOOK.md` for the original investigation).
- Viable Tinfoil models tested this session: **Kimi K2.6**, **GLM-5.1** — both reliable, both ~2× Haiku cost per pull, both produce materially more thorough summaries than Haiku.
- Tinfoil provider (`utils/agent/providers/tinfoilProvider.js`) has a 90 s per-round hard timeout but is **still non-streaming**, which is the biggest production blocker for any Tinfoil model.

## Evidence: 3×3 benchmark from this session

Saved in `tests/output/comparison-2026-04-24T18-22-21.md`. Three queries × three models, full metrics:

| # | Query | Model | Input tok | Output tok | LLM $ | Tool $ | **Total $** |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | Person Dossier (Luke Gromen) | Haiku 4.5 | 26,084 | 701 | $0.02959 | $0.0050 | **$0.03459** |
| 2 | Person Dossier | Kimi K2.6 | 35,207 | 4,033 | $0.07398 | $0.0170 | **$0.09098** |
| 3 | Person Dossier | GLM-5.1 | 42,854 | 2,526 | $0.07754 | $0.0160 | **$0.09354** |
| 4 | Precise Search (Rogan stoned ape) | Haiku 4.5 | 16,906 | 580 | $0.01981 | $0.0040 | **$0.02381** |
| 5 | Precise Search | Kimi K2.6 | 22,327 | 1,281 | $0.04022 | $0.0050 | **$0.04522** |
| 6 | Precise Search | GLM-5.1 | 15,472 | 906 | $0.02796 | $0.0080 | **$0.03596** |
| 7 | Huberman Cold Exposure | Haiku 4.5 | 27,689 | 731 | $0.03134 | $0.0050 | **$0.03634** |
| 8 | Huberman Cold Exposure | Kimi K2.6 | 40,554 | 2,228 | $0.07253 | $0.0140 | **$0.08653** |
| 9 | Huberman Cold Exposure | GLM-5.1 | 27,325 | 1,620 | $0.04949 | $0.0090 | **$0.05849** |

**Model averages:**

| Model | Mean cost | Mean latency | Mean summary chars | Clip coverage | Reliability |
|---|---:|---:|---:|---:|---|
| Haiku 4.5 | **$0.0316** | 13.99 s | 1,906 | 2/3 | Solid |
| Kimi K2.6 | $0.0742 | 50.89 s | 4,158 | 3/3 | Solid |
| GLM-5.1 | $0.0627 | 71.73 s | 4,304 | 3/3 | Solid |

Quality note: Haiku **dropped `{{clip:}}` tokens entirely** on the hardest query (Q1 Person Dossier). Both open models included them. That's a real regression for Haiku on long-horizon work.

## Pricing reference

| Model | Input ($/1M) | Output ($/1M) | Source |
|---|---:|---:|---|
| Haiku 4.5 | $1.00 | $5.00 | Anthropic direct |
| Sonnet 4.6 | $3.00 | $15.00 | Anthropic direct |
| Kimi K2.6 | $1.50 | $5.25 | Tinfoil (confirmed) |
| GLM-5.1 | $1.50 | $5.25 | Tinfoil (confirmed) |
| Gemma 4 31B | $0.45 | $1.00 | Tinfoil (confirmed) |
| **DeepSeek V4-Flash** | **$0.14** | **$0.28** | DeepSeek direct |
| **DeepSeek V4-Flash (Tinfoil est., 2.5×/1.75× markup)** | **~$0.35** | **~$0.49** | Projection |
| **DeepSeek V4-Pro** | $1.74 | $3.48 | DeepSeek direct |
| **DeepSeek V4-Pro (Tinfoil est.)** | ~$4.35 | ~$6.10 | Projection |

Tinfoil markup factor derived empirically: Kimi K2.6 direct is $0.60/$3.00 on Moonshot, vs $1.50/$5.25 on Tinfoil → 2.5× input, 1.75× output. May differ for DeepSeek; Tinfoil already runs confidential-deepseek-r1 so they have infrastructure leverage.

## Cost-per-pull projection for V4-Flash

Using the 9 real runs above, repricing the LLM portion at V4-Flash rates (assumes V4-Flash uses approximately the token counts that model actually used):

| # | Trajectory | Actual cost | V4-Flash (direct) | V4-Flash (Tinfoil est.) |
|---:|---|---:|---:|---:|
| 1 | Haiku/Person Dossier (26k/701) | $0.03459 | $0.00885 | $0.01447 |
| 2 | Kimi/Person Dossier (35k/4k) | $0.09098 | $0.02720 | $0.03623 |
| 3 | GLM/Person Dossier (43k/2.5k) | $0.09354 | $0.02771 | $0.03824 |
| 4 | Haiku/Precise Search (17k/580) | $0.02381 | $0.00653 | $0.01020 |
| 5 | Kimi/Precise Search (22k/1.3k) | $0.04522 | $0.00877 | $0.01345 |
| 6 | GLM/Precise Search (15k/906) | $0.03596 | $0.01070 | $0.01387 |
| 7 | Haiku/Huberman Cold (28k/731) | $0.03634 | $0.00908 | $0.01503 |
| 8 | Kimi/Huberman Cold (41k/2.2k) | $0.08653 | $0.02091 | $0.03011 |
| 9 | GLM/Huberman Cold (27k/1.6k) | $0.05849 | $0.01388 | $0.01970 |

**Scenario summaries:**

| Scenario | Mean total cost per pull | Margin at $0.10 retail |
|---|---:|---:|
| Today — Haiku 4.5 | $0.03158 | $0.068 (68%) |
| V4-Flash on Haiku-style trajectories (Tinfoil est.) | **$0.01323** | $0.087 (87%) |
| V4-Flash on Haiku-style trajectories (direct) | **$0.00815** | $0.092 (92%) |
| V4-Flash on Kimi-style trajectories (Tinfoil est.) | $0.02660 | $0.073 (73%) |
| V4-Flash on GLM-style trajectories (Tinfoil est.) | $0.02394 | $0.076 (76%) |

### The floor: tool costs

Tools cost $0.004–$0.017 per pull regardless of model. That sets a **practical minimum of ~$0.005–0.015 per pull**, no matter how cheap the LLM gets.

## The strategic move: reinvest the subsidy into breadth, not margin

Once V4-Flash cost-per-pull is in the $0.01–0.02 range, the interesting question isn't "how much more margin do we keep?" It's **"what could we do differently at the same $0.03 budget we spend today?"**

### Idea: parallel path workers

Instead of one agent loop per pull, run **2–3 agent workers in parallel** exploring the problem space with different strategies, then synthesize their outputs into a single final answer.

**Concrete shapes:**

- **Fan-out search** — each worker issues a different query reformulation (e.g. person-name vs topic vs exact-phrase). Union the results, dedupe by episode. Better recall on ambiguous queries like "cutting weight" or "fraud from Somalians and Armenians".
- **Persona/strategy split** — Worker A is a breadth-first searcher (many `discover_podcasts` + `search_quotes` calls), Worker B is a depth-first researcher (one show, multiple chapters). Synthesizer merges.
- **Answer + critic** — Worker A produces the answer. Worker B (cheap) critiques it for missing context, weak quotes, or misleading framing. If critic flags issues, Worker A runs one more round.
- **Hypothesis tree** — branch on 2–3 interpretations of the user query, drop branches early based on tool-result signal quality, keep the one with the best evidence.

**Budget math:** V4-Flash at ~$0.01 per pull × 3 parallel workers = ~$0.03 per pull total — **the same as today's single Haiku pull**, but with 3× the exploration budget and (plausibly) materially better answers on complex queries.

**Where it helps most:**

- Complex multi-person / multi-show queries ("compare what Breaking Points and All-In said about tariffs")
- Research session creation (`create_research_session` tool) where breadth matters more than latency
- Ambiguous queries where a single reformulation can miss the intent

**Where it doesn't help:**

- Precise searches ("Find Joe Rogan talking about stoned ape theory") — one worker nails it; parallel is wasted spend
- Cache-hit / known-person lookups

### Architectural implications

- Need a **worker pool abstraction** — probably a thin wrapper around `handleAgentChat` that can run N instances concurrently with different prompt variants / tool biases.
- Need a **synthesizer step** — a final LLM call (could be cheap: another V4-Flash, or even a templated merge) that unifies N worker outputs into one answer. Must dedupe clip references and pick the best quotes.
- Need a **router/heuristic** — decide per query whether single-path or multi-path is warranted. Simple v1: route by intent (research_session → multi-path; search → single-path). Smarter v2: run a cheap classifier round and escalate on ambiguity signals.
- Should be **opt-in** on a new execution profile (e.g. `parallel-breadth`) so it doesn't affect existing default behavior.

### Risk / honesty check

- More workers = **more tool-call fan-out** on services we already pay per call (search_quotes = $0.001 each). Tool costs scale linearly with worker count; LLM savings from V4-Flash have to more than offset that. Need real measurement, not assumption.
- **Latency probably gets worse**, not better, even with concurrency — synthesizer step adds a final round. Parallel worker mode is a **quality mode**, not a speed mode.
- **Synthesizer quality risk** — merging 3 good answers into 1 great answer is nontrivial. The synthesizer is where this idea lives or dies.

## Trigger checklist — when V4 drops on Tinfoil

Run these in order. Should take <30 minutes end-to-end.

1. **Watch for availability:**
   - Check [Tinfoil chat models docs](https://docs.tinfoil.sh/models/chat) for `deepseek-v4-flash` / `deepseek-v4-pro` slugs.
   - Check [Tinfoil changelog](https://docs.tinfoil.sh/resources/changelog) for the addition.
   - Or just ask Tinfoil directly.

2. **Add to the registry** — `constants/agentModels.js`:

   ```js
   'deepseek-v4-flash': {
     key: 'deepseek-v4-flash',
     provider: 'tinfoil',
     id: process.env.TINFOIL_DEEPSEEK_V4_FLASH_MODEL || 'deepseek-v4-flash',
     inputPer1M: parseFloat(process.env.TINFOIL_DEEPSEEK_V4_FLASH_INPUT_PER_1M || '0.35'),
     outputPer1M: parseFloat(process.env.TINFOIL_DEEPSEEK_V4_FLASH_OUTPUT_PER_1M || '0.49'),
     label: 'DeepSeek V4-Flash (Tinfoil)',
   },
   'deepseek-v4-pro': {
     key: 'deepseek-v4-pro',
     provider: 'tinfoil',
     id: process.env.TINFOIL_DEEPSEEK_V4_PRO_MODEL || 'deepseek-v4-pro',
     inputPer1M: parseFloat(process.env.TINFOIL_DEEPSEEK_V4_PRO_INPUT_PER_1M || '4.35'),
     outputPer1M: parseFloat(process.env.TINFOIL_DEEPSEEK_V4_PRO_OUTPUT_PER_1M || '6.10'),
     label: 'DeepSeek V4-Pro (Tinfoil)',
   },
   ```

   Update the defaults once Tinfoil publishes actual $/1M rates for their DeepSeek hosting.

3. **Run the 3-query benchmark** (same queries used this session, so results are directly comparable):

   ```bash
   node tests/agent-comparison.js --queries 1,4,9 --models fast,deepseek-v4-flash,deepseek-v4-pro --save
   ```

4. **Read the saved markdown in `tests/output/`** and check:
   - Does V4-Flash complete without hanging? (If latency > 90 s per round, the existing timeout will kill it.)
   - Is tool-use quality at least as good as Kimi K2.6 / GLM-5.1?
   - Does clip coverage match or exceed Haiku?
   - Token counts per query — are they closer to Haiku (good) or Kimi/GLM (chattier)?

5. **If V4-Flash passes the quality bar:**
   - Flip `DEFAULT_AGENT_MODEL` to `deepseek-v4-flash` in the registry (or via `AGENT_MODEL=deepseek-v4-flash` env).
   - Add `TINFOIL_API_KEY` verification at startup as a gating check.
   - **Production blocker to resolve first**: non-streaming Tinfoil provider. Users currently see a silent 30–60 s block. Must add SSE streaming before V4-Flash can replace Haiku on the user-facing `pull` endpoint.

6. **If V4-Pro looks strong on quality:**
   - Use it as the `quality-tinfoil` tier instead of Sonnet 4.6 for research sessions / deep-research workflows.
   - Add a `deep-turns` execution profile variant that routes there.

7. **Start the parallel-workers experiment** (separate branch, not the default path):
   - Build a `utils/agent/parallelWorkers.js` that runs N `handleAgentChat` invocations concurrently.
   - Add a `parallel-breadth` execution profile gated on query intent.
   - Benchmark the same 3 queries with `--profile parallel-breadth` against single-path V4-Flash to measure if the breadth investment actually improves output quality.

## Open questions / what to verify post-launch

- **Actual Tinfoil markup for DeepSeek** — Kimi/GLM are 2.5× / 1.75× input/output. DeepSeek may be different (they already run R1, so infrastructure is amortized).
- **Prompt caching** — does Tinfoil expose DeepSeek's cache-hit pricing through their `/v1/chat/completions` endpoint? If yes, our 7k-token system prompt could run at near-zero input cost across a session. Would be a step-function change.
- **Latency profile** — V4-Flash should be Haiku-speed based on 13B active params, but Tinfoil enclave inference has its own overhead. Measure, don't assume.
- **Tool-call reliability on `gemma4-31b`-style degenerations** — DeepSeek has solid post-training for this, but validate in-context with our 7k-token prompt and OpenAI-style `tools` schema.
- **SWE-bench Verified = 83.7%** claim for V4-Pro is leaked/unofficial. Independent benchmarks will land in the weeks after release.

## Related files

- `constants/agentModels.js` — model registry (add V4 entries here)
- `constants/agentPricing.js` — retail price per endpoint + per-tool costs
- `utils/agent/providers/tinfoilProvider.js` — OpenAI-compatible adapter (needs streaming before V4-Flash production rollout)
- `utils/agent/providers/anthropicProvider.js` — reference implementation with streaming
- `routes/agentChatRoutes.js` — agent orchestration loop (`handleAgentChat`, the place where parallel workers would branch)
- `tests/agent-comparison.js` — benchmark harness (supports `--queries`, `--models`, `--profile`)
- `docs/TINFOIL_GEMMA_BENCHMARK_RUNBOOK.md` — historical; how we ruled out Gemma
- `tests/output/comparison-2026-04-24T18-22-21.md` — the 3×3 reference run this plan is built on
