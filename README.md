# 🛠️ Pull That Up Jamie — Backend

### ⚡ The Agent-Payable Podcast Research API for the Machine-Payable Web

> Plain English in. Timestamped, deeplinked, audio-grounded podcast intel out. One Lightning credential. Zero accounts.

---

## 🔑 What Is It?

**Jamie Pull** is a podcast research agent that lives behind a single API. Hand it a question, it plans, searches, transcribes, curates, and streams back structured results with playable clips — across hundreds of feeds, tens of thousands of episodes, and millions of indexed paragraphs.

It's what OpenClaw's orchestration layer feels like, but:

- 🏗️ Runs on our infrastructure, not yours
- ⚡ ~$0.10 per call (bounded, not per-token)
- 🚫 No Docker, no API keys, no signup, no monthly bill
- 🌊 Streaming SSE results in 5–30 seconds
- 🤖 Built for agent-to-agent commerce from day one
- ₿ L402 Lightning payable — pay per request, scoped, ephemeral

---

## ✨ What's New

- 🧠 **DeepSeek V4 powers Deep Mode** — multi-angle research, better proper-noun recall, ~268× cheaper than closed frontier models. Same 10¢ pricing, more thinking per dollar.
- 🎯 **Smart Mode** — natural-language query routing. "What was Saylor saying about AI on TFTC last year" gets parsed into guest + topic + feed + time-frame filters before semantic search runs.
- 🧩 **Intent router** — agent triage classifier picks a trimmed prompt + tool subset per request (search / research_session / transcribe).
- 🎬 **Research sessions via agent** — `create_research_session` tool curates 5–12 clips into a shareable playlist URL.
- 🛡️ **Synthesis-failure recovery tiers** — three-tier reactive recovery (strict re-synth → cross-provider Haiku → hardcoded fallback) catches DSML leaks, narration, empty text.
- 🔁 **Multi-turn conversation** — client-side history, capped at 2 prior turns, works for human and agent-to-agent callers.

---

## 🤖 For Agents — One Endpoint, Plain English In

```bash
curl -X POST https://pullthatupjamie-nsh57.ondigitalocean.app/api/pull \
  -H "Content-Type: application/json" \
  -H "Authorization: L402 <macaroon>:<preimage>" \
  -d '{
    "message": "What did Michael Saylor say about AI on TFTC last year?",
    "stream": true
  }'
```

You get back:

- 🌊 Real-time streaming status (SSE)
- 🛠️ Tool calls and results as they happen
- 📝 Synthesized answer with embedded `{{clip:...}}` tokens that resolve to playable audio
- 👉 Suggested follow-up actions (`submit-on-demand`, `direct-query`, `follow-up-message`)
- 🔗 Session continuity for multi-turn research

> 📚 **Canonical workflows + capability discovery for agents:** [`https://www.pullthatupjamie.ai/llms.txt`](https://www.pullthatupjamie.ai/llms.txt)
> 📖 **Full API surface:** [`/api/docs`](https://pullthatupjamie-nsh57.ondigitalocean.app/api/docs) (Swagger UI) · [`/api/openapi.json`](https://pullthatupjamie-nsh57.ondigitalocean.app/api/openapi.json)

---

## 🧱 Or Pick Your Primitives — 4 L402 Endpoints

Prefer to orchestrate yourself? Hit the building blocks directly. Same Lightning credential covers all of them.

| Endpoint | What It Does | ~Price |
|----------|--------------|--------|
| 🔍 `POST /api/search-quotes` | Semantic search across millions of transcript paragraphs. Returns timestamped quotes with audio deeplinks. Supports `smartMode`. | ~$0.004 |
| 📚 `POST /api/search-chapters` | Survey 70K+ LLM-curated chapter labels to map *who* is talking about *what*, *when*. | ~$0.005 |
| 🎙️ `POST /api/discover-podcasts` | Natural-language podcast/episode discovery across 4M+ feeds. Flags transcript availability. | ~$0.005 |
| 🎧 `POST /api/on-demand/submitOnDemandRun` | Transcribe + index any episode by feed URL + GUID. Permanent semantic search after. | ~$0.45 |

All four are listed and probe-verified on [402index.io](https://402index.io/directory) and [satring.com](https://satring.com).

---

## ⚡ L402 in 30 Seconds

> **L402 = HTTP 402 + Bitcoin Lightning.** Pay per request, no account, no email, no API key.

1. 📡 Agent hits an endpoint
2. 🧾 Server returns `402 Payment Required` with a Lightning invoice
3. ⚡ Agent pays (Alby NWC, lnget, lightning-agent-tools, whatever)
4. 🔁 Agent retries with `Authorization: L402 <macaroon>:<preimage>`
5. ✅ Server returns the result

**One macaroon covers all Jamie endpoints.** Run the balance down, top it up when you want.

> 🆓 Want to try without a wallet? Send `X-Free-Tier: true` for the metered free tier.

📘 More on the philosophy: [How Do AI Agents Pay for APIs?](https://www.pullthatupjamie.ai/blog/how-do-ai-agents-pay-for-apis-and-why-they-dont-use-api-keys-20260325) · [Machine Payable Web is Blooming](https://www.pullthatupjamie.ai/blog/the-jamie-pull-request-1-the-machine-payable-web-is-blooming-20260324)

---

## 👤 For Humans — Web App

Don't want to write code? [pullthatupjamie.ai/app?view=agent](https://pullthatupjamie.ai/app?view=agent)

- 💬 Ask in plain English, get streaming responses with inline playable clips
- 🧪 **Deep Mode** (default) — multi-step reasoning, cross-referenced sources, ~60–90s
- ⚡ **Fast Mode** — single-pass answer, ~30–45s
- 💰 Same 10¢ per call either way
- 📦 Bundle findings into shareable research sessions

---

## 🏗️ What's Under the Hood

| Layer | Stack |
|-------|-------|
| 🧠 Reasoning | DeepSeek V4-Flash (default), Anthropic Claude Haiku 4.5 (recovery + classifier), OpenAI fallback |
| 🔎 Search | Pinecone (vector) + MongoDB Atlas Search (lexical/proper-noun recall) + custom re-ranker |
| 📦 Corpus | Hundreds of feeds, 10K+ episodes, millions of indexed paragraphs, 70K+ LLM-curated chapters |
| 🎞️ Media | On-demand transcription, word-level subtitle generation, TikTok-style clip rendering |
| 🌐 Edge | Express.js streaming SSE · CORS · DigitalOcean Spaces CDN |
| 💾 Data | MongoDB (Mongoose) · automated DO Spaces backups |
| ⚡ Payments | L402 (BOLT11 macaroons) · Lightning Network · Square (legacy email subs) |

---

## 🔐 Auth — Pick Your Lane

- ⚡ **L402 Lightning** (recommended for agents) — pay-per-request, no account, agent-native
- 🆓 **Free tier** — `X-Free-Tier: true` header for metered exploration
- 🛡️ **JWT / email subscriptions** — traditional accounts for the web app and pro features
- 🔑 **Service HMAC** — for trusted internal integrations

---

## 📡 Endpoint Cheatsheet

> 🗺️ **Always the source of truth:** [`/api/openapi.json`](https://pullthatupjamie-nsh57.ondigitalocean.app/api/openapi.json) and [`llms.txt`](https://www.pullthatupjamie.ai/llms.txt)

### 🤖 Agent
- `POST /api/pull` — one-call podcast research agent (L402)
- `POST /api/chat/workflow` — agent chat with multi-turn + research sessions

### 🔍 Search & Discovery
- `POST /api/search-quotes` — semantic transcript search (L402)
- `POST /api/search-chapters` — chapter-level corpus survey (L402)
- `POST /api/discover-podcasts` — NL podcast/episode discovery (L402)
- `POST /api/on-demand/submitOnDemandRun` — transcribe + index any episode (L402)
- `GET  /api/corpus/*` — feed/episode/chapter/topic navigation

### 🎬 Clips & Media
- `POST /api/make-clip` — generate subtitled clip
- `GET  /api/clip-status/:lookupHash` — poll clip status
- `GET  /api/render-clip/:lookupHash` — render with social-media metadata
- `POST /api/jamie-assist/:lookupHash` — AI-generated promotional copy

### 🧪 Research Sessions
- `POST /api/research-sessions` — create / fetch sessions
- `POST /api/shared-research-sessions` — share-link layer

### ⚡ Auth & Payments
- `GET  /invoice-pool` — Lightning invoices
- `POST /register-sub` — register email/Square subscription
- `POST /api/validate-privs` — privilege check

### 🩺 Health
- `GET  /health` — status
- `GET  /api/get-clip-count` — usage stats

---

## ❓ FAQ

### What is Pull That Up Jamie?
Pull That Up Jamie is an agent-orchestrated podcast research API. Ask any question in plain English and get back timestamped, deeplinked, audio-grounded answers from millions of indexed podcast paragraphs. It works for humans via the web app and for AI agents via a single L402-payable HTTP endpoint.

### How do AI agents use Jamie's API?
Agents POST to `/api/pull` with a natural-language `message` and an `Authorization: L402 <macaroon>:<preimage>` header. The server streams back SSE events with tool calls, intermediate results, a synthesized final answer with embedded clip tokens, and suggested follow-up actions. No API keys, no signup, no human in the loop.

### How does L402 authentication work?
L402 combines HTTP `402 Payment Required` with Bitcoin Lightning. The agent makes a request, receives a 402 with a Lightning invoice, pays it (via Alby NWC, lnget, or any Lightning wallet), and retries with the proof of payment as the `Authorization` header. One macaroon covers every Jamie endpoint until the balance runs out.

### What does it cost?
- 🔍 Search & discovery endpoints: fractions of a cent per call (~$0.004–$0.005)
- 🤖 `/api/pull` agent endpoint: ~$0.10 per call (bounded, not per-token)
- 🎧 On-demand transcription + indexing: ~$0.45 per episode
- 🆓 Free tier available for evaluation

### Do I need an API key?
No. Lightning payment *is* the authentication. There's also a free tier (`X-Free-Tier: true`) for evaluation, and traditional email/JWT auth if you specifically want an account-based flow.

### Where is the canonical API documentation?
- 🤖 **For agents:** [`https://www.pullthatupjamie.ai/llms.txt`](https://www.pullthatupjamie.ai/llms.txt) (capabilities, canonical workflows, integration patterns)
- 👨‍💻 **For developers:** [`/api/docs`](https://pullthatupjamie-nsh57.ondigitalocean.app/api/docs) (Swagger UI) and [`/api/openapi.json`](https://pullthatupjamie-nsh57.ondigitalocean.app/api/openapi.json)

### What podcasts are indexed?
Hundreds of feeds, 10K+ episodes, millions of paragraphs across shows like Joe Rogan Experience, Lex Fridman, Huberman Lab, TFTC, All-In, What Bitcoin Did, Acquired, and many more. Any episode from the 4M+ Podcast Index catalog can be transcribed and permanently indexed on demand via `/api/on-demand/submitOnDemandRun`.

### Why not just use ChatGPT or Spotify search?
ChatGPT hallucinates — it'll confidently quote things people never said. Spotify searches episode titles and descriptions, not transcripts. Jamie searches the actual spoken words semantically and returns timestamped audio you can press play on. Ground truth, not paraphrase.

### What's Smart Mode vs Fast Mode?
**Smart Mode** routes vague natural-language queries through an LLM that extracts guests, topics, feeds, and time frames *before* running semantic search — so "Rogan talking to that CIA guy about China" becomes a filtered, scoped query. **Fast Mode** runs a single-pass direct semantic match. Smart Mode is a conversation; Fast Mode is a scalpel. Same price.

### Does Jamie work with OpenClaw, Claude, or other agent frameworks?
Yes. Any framework that can make HTTP requests and parse SSE can drive Jamie. There's also a ClawHub skill for OpenClaw and an Alby MCP server that plugs Lightning payments directly into Claude, Cursor, and similar agent runtimes.

### What is the machine-payable web?
A vision of the internet where AI agents discover and pay for services in real time without accounts, API keys, or human intervention. Jamie is one of the first agent-research products built natively for this model. More: [The Machine Payable Web is Blooming](https://www.pullthatupjamie.ai/blog/the-jamie-pull-request-1-the-machine-payable-web-is-blooming-20260324).

---

## 📚 Further Reading

- 📝 [Jamie's NLP Just Got a Lot Smarter (DeepSeek V4)](https://www.pullthatupjamie.ai/blog/jamies-nlp-just-got-a-lot-smarter-thanks-deepseek-v4-20260428)
- 📝 [OpenClaw Is Great. Hosting & Paying the Bill Aren't. So I Built Jamie Pull.](https://www.pullthatupjamie.ai/blog/openclaw-is-great-hosting-paying-the-bill-arent-so-i-built-jamie-pull-20260421)
- 📝 [How Do AI Agents Pay for APIs?](https://www.pullthatupjamie.ai/blog/how-do-ai-agents-pay-for-apis-and-why-they-dont-use-api-keys-20260325)
- 📝 [The Jamie Pull Request #1 — The Machine Payable Web is Blooming](https://www.pullthatupjamie.ai/blog/the-jamie-pull-request-1-the-machine-payable-web-is-blooming-20260324)
- 🧰 [Registering L402 Endpoints](docs/REGISTERING_L402_ENDPOINTS.md)
- 🧪 [Agent Synthesis Pass](docs/AGENT_SYNTHESIS_PASS.md)

---

## 🚀 Try It Now

- 👤 **Human:** [pullthatupjamie.ai/app?view=agent](https://pullthatupjamie.ai/app?view=agent)
- 🤖 **Agent quick start:** point your agent at [`https://www.pullthatupjamie.ai/llms.txt`](https://www.pullthatupjamie.ai/llms.txt)
- ⚡ **Already have a Lightning wallet?** `POST /api/pull` and go.

> Keep building with us. The internet is shifting from something you stare at to something that works for you. 🌐
