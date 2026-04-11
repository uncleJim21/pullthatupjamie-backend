# WIP Backlog

Ephemeral backlog for tracking cross-session work. New chat threads should check this file first.

## Active

- [ ] Frontend: handle `suggested_action` SSE event to render transcription upsell cards in the chat UI

## Parked

- [ ] Agent: `create-clip` suggest_action flow (currently stubbed in tool definition, no frontend handling)
- [ ] Research sessions integration with agent (agent doesn't currently create/manage research sessions)
- [ ] Production session store (replace in-memory `sessionStore` Map with Redis)

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
