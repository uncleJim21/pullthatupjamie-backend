# WIP Backlog

Ephemeral backlog for tracking cross-session work. New chat threads should check this file first.

## Active

- [ ] Frontend: handle `suggested_action` SSE event — render `submit-on-demand` as upsell cards (with `image` thumbnail + Fountain listen link via `getFountainLink` API), `direct-query` as one-tap search cards, `follow-up-message` as chat chips
- [ ] Frontend: handle `session_created` SSE event — render a card with the session URL when the agent creates a research session
- [ ] **Waiting on Tinfoil**: migrate default pull model to DeepSeek V4-Flash once it's available on Tinfoil. Full plan + cost math + "reinvest subsidy into parallel workers" idea in [`DEEPSEEK_V4_TRANSITION_PLAN.md`](./DEEPSEEK_V4_TRANSITION_PLAN.md). Baseline benchmark to compare against is `tests/output/comparison-2026-04-24T18-22-21.md`.

## Recently Implemented (pending frontend integration)

- [x] **Intent router / triage classifier.** Haiku classifier runs before the main agent to select a trimmed prompt + tool subset per intent. 3 intents: `search` (full, default), `research_session` (session creation tools), `transcribe` (discover + upsell only). Bypass via `bypassTriage: true` in request body or `AGENT_TRIAGE_ENABLED=false` env var. Classifier cost: ~$0.0003/request. SSE `status` event now includes `intent` field; `done` event includes `intent`.
- [x] **Research session creation via agent.** New `create_research_session` tool lets the agent build sessions directly. Agent searches, curates 5-12 clips, calls the tool with pineconeIds + title. Service layer extracted to `services/researchSessionService.js`. SSE event `session_created` emitted with `{ sessionId, url, itemCount }`. Session URL: `https://www.pullthatupjamie.ai/app?researchSessionId={ID}`.
- [x] **Composable system prompt.** `setup-agent.js` refactored into `PROMPT_SECTIONS` (base, searchTools, searchCrafting, criticalRules, insufficientEvidence, upsellRules, suggestActionRules, tokenStewardship, responseFormat, sessionCuration, transcribeTools, transcribeRules). Profiles in `setup-agent-profiles.js` compose subsets per intent.
- [x] **`submit-on-demand` image field.** Discover results now include `image` (episode/feed artwork URL) in matchedEpisodes. Agent includes it in suggest_action payloads. Haiku XML-in-JSON sanitizer handles malformed payloads. Frontend resolves listen link via `getFountainLink` API using `guid`.
- [x] **Multi-turn conversation support.** Decision: client-side history, chat-only (user msg + assistant final text — no tool results). Cap: 2 prior turns (4 history messages). Works for both human and agent-to-agent callers. Frontend sends `history: [{ role, content }]` in request body. Backend validates, caps, and prepends to messages array. Cost: ~$0.003/request added on Haiku — negligible.
- [x] **Suggested follow-up actions (3 types via `suggest_action` tool):**
  - `submit-on-demand` — Upsell transcription (existing, unchanged)
  - `direct-query` — Agent pre-builds a fully structured API request from context it already resolved (GUIDs, feed IDs, query terms). Frontend renders a card, user taps, frontend fires the request directly. No agent round-trip, ~$0.002 instead of $0.10. Schema: `{ type, reason, label, endpoint, method, body }`
  - `follow-up-message` — Pre-filled chat message for follow-ups needing LLM reasoning. Schema: `{ type, reason, label, message }`. Frontend renders as a tappable chip that sends the message as the next turn (uses multi-turn).
- [x] Agent prompt updated: MUST emit `direct-query` or `follow-up-message` alongside `submit-on-demand` when correcting user assumptions. No dead-end corrections.

## Parked

- [ ] Agent: `create-clip` suggest_action flow (currently stubbed in tool definition, no frontend handling)
- [ ] Production session store (replace in-memory `sessionStore` Map with Redis) — revisit if agent-to-agent requires server-side history

## Done

- [x] Research sessions integration with agent (`create_research_session` tool + intent router)
- [x] Agent upsell flow: prompt rewrite so agent proactively runs `discover_podcasts` + `suggest_action(submit-on-demand)` when user assumption mismatch, thin coverage, or missing show detected
- [x] Per-episode `transcriptAvailable` in `discoverPodcasts` enrichment — `matchedEpisodes` now show which specific episodes are/aren't transcribed
- [x] `buildNextSteps` includes `requestTranscription` when feed is transcribed but matched episodes are not
- [x] Agent prompt: concrete example in critical rule 8 showing exact tool call sequence for upsell + fallback `suggest_action` when discover can't find the specific episode
- [x] Replaced hand-rolled workflow engine with Claude agent at `POST /api/chat/workflow`
- [x] Inlined agent-gateway.js into main Express server (eliminated separate port 3456 process)
- [x] Implemented real-time text streaming (text_delta / text_done SSE events)
- [x] Mandatory clip references ({{clip:shareLink}} tokens) in agent responses
- [x] Extracted service layer: corpusService, searchQuotesService, searchChaptersService, discoverPodcasts
- [x] Eliminated loopback HTTP — agent tool handler calls service functions directly
- [x] Added agent session file logging to `logs/agent/`
