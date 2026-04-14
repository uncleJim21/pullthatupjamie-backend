# WIP Backlog

Ephemeral backlog for tracking cross-session work. New chat threads should check this file first.

## Active

- [ ] Frontend: handle `suggested_action` SSE event — render `submit-on-demand` as upsell cards, `direct-query` as one-tap search cards, `follow-up-message` as chat chips

## Recently Implemented (pending frontend integration)

- [x] **Multi-turn conversation support.** Decision: client-side history, chat-only (user msg + assistant final text — no tool results). Cap: 2 prior turns (4 history messages). Works for both human and agent-to-agent callers. Frontend sends `history: [{ role, content }]` in request body. Backend validates, caps, and prepends to messages array. Cost: ~$0.003/request added on Haiku — negligible.
- [x] **Suggested follow-up actions (3 types via `suggest_action` tool):**
  - `submit-on-demand` — Upsell transcription (existing, unchanged)
  - `direct-query` — Agent pre-builds a fully structured API request from context it already resolved (GUIDs, feed IDs, query terms). Frontend renders a card, user taps, frontend fires the request directly. No agent round-trip, ~$0.002 instead of $0.10. Schema: `{ type, reason, label, endpoint, method, body }`
  - `follow-up-message` — Pre-filled chat message for follow-ups needing LLM reasoning. Schema: `{ type, reason, label, message }`. Frontend renders as a tappable chip that sends the message as the next turn (uses multi-turn).
- [x] Agent prompt updated: MUST emit `direct-query` or `follow-up-message` alongside `submit-on-demand` when correcting user assumptions. No dead-end corrections.

## Parked

- [ ] Agent: `create-clip` suggest_action flow (currently stubbed in tool definition, no frontend handling)
- [ ] Research sessions integration with agent (agent doesn't currently create/manage research sessions)
- [ ] Production session store (replace in-memory `sessionStore` Map with Redis) — revisit if agent-to-agent requires server-side history

## Done

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
