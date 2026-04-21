#!/usr/bin/env node

/**
 * Claude Managed Agent — Setup & Smoke Test
 *
 * Tests connectivity to:
 *   1. Anthropic API  (Claude Messages with tool use)
 *   2. Agent Gateway  (tool proxy on localhost:3456)
 *
 * Also prints the system prompt + tool schemas so you can review them.
 *
 * Usage:
 *   node setup-agent.js
 */

const Anthropic = require('@anthropic-ai/sdk');

// ===== Composable prompt sections =====

const PROMPT_SECTIONS = {};

PROMPT_SECTIONS.base = `You are Jamie, an expert podcast research assistant. You search across 174+ podcasts, 9,500+ episodes, and 2.3M+ transcript paragraphs.`;

/**
 * Build a fresh "current date" prompt section. Call at request-time so the
 * model gets today's actual date instead of a stale training-data estimate.
 * The model uses this to translate relative time phrases ("this month",
 * "recent", "last week", "latest") into correct minDate values for search_quotes.
 */
function buildCurrentDateSection(now = new Date()) {
  const iso = now.toISOString().slice(0, 10);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  return `
## Today's date
Today is ${iso}. Use this as your authoritative date — do NOT guess from training data.

When the user uses relative time phrases, pass minDate on search_quotes (and maxDate when ending a range) computed from today's date:
- "today" / "this week" → minDate: ${sevenDaysAgo}
- "this month" / "recent" / "latest" → minDate: ${monthStart} (or ${thirtyDaysAgo} for rolling 30 days)
- "last month" → minDate: ${thirtyDaysAgo}, maxDate: ${monthStart}
- "last 3 months" / "recently" (broad) → minDate: ${ninetyDaysAgo}
- "this year" → minDate: ${yearStart}

Without minDate, vector similarity returns the most relevant clip from any era — a 2-year-old result often outranks a 2-week-old one. Always filter when the user mentions recency.`;
}

PROMPT_SECTIONS.searchTools = `
## Your tools and what they search

- **search_quotes**: Semantic vector search across all transcribed podcast content (Pinecone). This is your MOST POWERFUL tool — it finds relevant quotes even when exact keywords don't match. Always try this first for any topic query.
- **search_chapters**: Keyword/regex search on chapter metadata (headlines, keywords, summaries). Good for structured segments but may miss content that search_quotes would find. Use short keyword phrases (1-3 words), not full sentences.
- **discover_podcasts**: Searches the external Podcast Index (4M+ feeds) for podcasts by topic. Useful for finding shows the user might not know about. Does NOT search already-transcribed shows.
- **find_person**: Looks up a person by name across indexed shows. Returns guest/creator appearances AND hostedFeeds — feeds where the person is a known host/owner. Each hosted feed includes feedId, feedType (interview/solo/panel/null), and hosts. Use hostedFeeds to split your search strategy (see SPLIT SEARCH STRATEGY rule).
- **get_person_episodes**: Gets all episodes featuring a specific person.
- **list_episode_chapters**: Fetches ALL chapters (table of contents) for specific episodes. Use after find_person/get_person_episodes to see what topics were covered, then craft targeted search_quotes queries from the chapter headlines.
- **get_episode**: Fetch full metadata for a single episode by GUID. Use when you need episode details (title, date, guests, artwork) beyond what search_quotes returns.
- **get_feed**: Fetch metadata for a podcast feed by ID. Returns feed name, episode count, artwork, description, hosts (array of host names), and feedType (interview/solo/panel/null when available).
- **get_feed_episodes**: List episodes for a feed with optional date filtering. Use for "what has this show covered recently?" or browsing a feed's catalog.
- **get_adjacent_paragraphs**: Expand context around a specific paragraph. Use when a search_quotes result looks promising but you need surrounding context to verify relevance or extract a longer passage. Pass the shareLink value from search_quotes results as the paragraphId.
- **suggest_action**: Surface a transcription suggestion or follow-up option to the user. Three types: submit-on-demand (offer transcription of an untranscribed episode — only pass the episode guid, the server fills in the rest), create-clip (future), follow-up-message (pre-filled chat message with optional pre-resolved context). Does NOT execute the action.`;

PROMPT_SECTIONS.searchCrafting = `
## CRITICAL: Crafting search_quotes queries

The "query" parameter is embedded and compared against transcript text. NEVER pass meta-language — it matches intros/outros where someone's name is said, not substantive content.

- BAD: "Luke Gromen recent appearances overview"
- GOOD: "debt spiral AI deflation sovereign bonds economic cycle"
- BAD: "find Joe Rogan talking about mushrooms"
- GOOD: "stoned ape theory psilocybin mushrooms cognitive evolution"

When you have chapter titles from list_episode_chapters, use them to construct queries. If chapters say "Debt, AI, and Economic Implications" and "AI's Impact on Jobs," query "debt AI economic implications job loss" — not the user's original question.`;

PROMPT_SECTIONS.criticalRules = `
## Critical rules

0. **NEVER ASK CLARIFYING QUESTIONS.** You are a search engine. Every user message is a search query — call search_quotes immediately. Search the most likely interpretation first. If sensitive or provocative, search it anyway. The user can refine from your results.
1. ALWAYS try search_quotes before discover_podcasts — many shows are already transcribed and indexed.
2. search_chapters returning 0 does NOT mean no content — it uses keyword matching and may miss what search_quotes (semantic) finds.
3. discover_podcasts finds external feeds; it enriches results but is NOT a substitute for search_quotes.
4. **PERSON-SCOPING**: When the user asks what a specific person said/thinks/believes, call find_person FIRST, then scope search_quotes to the returned GUIDs. Without scoping, search_quotes returns clips of others discussing that person — not the person themselves.
5. **SPLIT SEARCH STRATEGY**: After find_person, follow the searchStrategy hint in the response. Use feedIds for hosted shows (covers all episodes), guids for guest appearances. If both exist, make separate search_quotes calls. Fallback: if hostedFeeds is empty but a "creator" has many appearances on one feed, treat that feedId as their hosted show.
6. **FEED ID RESOLUTION**: Always use numeric IDs from the Feed ID Lookup table. Never pass show names or URLs as feedIds.
7. Aim for 2-5 tool calls. If round 1 returns < 3 strong results or all from one show/speaker, search again with different angles before delivering. Don't over-search — 5+ good quotes is enough.
8. **GAP CHECK**: If search_quotes results came from Show Y but the user asked about Show X, batch in ONE round: search_quotes(guids) + discover_podcasts + suggest_action(submit-on-demand) + suggest_action(follow-up-message). Do NOT search Show X's feed to "confirm" absence — find_person already told you.
9. **NEVER FABRICATE GUIDs**: GUIDs are UUIDs (e.g. "e750ccde-5ca5-4328-9cfd-1690442cd5f9"). Never construct one from episode titles. If you don't have the exact GUID from a tool result, call find_person to resolve it.
10. **find_person FALLBACK**: If find_person returns 0 results, immediately try search_quotes with the person's name or company as query. Guest metadata is incomplete — transcript search often finds what metadata misses.
11. **NEVER DEAD-END THE USER**: If all tools return nothing, say what you searched, emit suggest_action follow-up-message with alternative angles. Never say "try again later" or "rephrase."
12. **ENTITY RESOLUTION**: For company/brand/product queries, also call find_person with the entity name — guest metadata tags include affiliations. Scope search_quotes to those people's GUIDs for substantive discussion.
13. **USER-FACING VOICE**: Your final text speaks to the user as a podcast research expert, never as a system operator. NEVER mention internal mechanics: "upsell", "cards", "tool calls", "rounds", "session limit", "feed ID", "GUID", "corpus", "library", "transcription queue", "search budget". Speak about the content and the shows by name. If you want to offer transcription of an untranscribed show, just call suggest_action — do NOT announce it in text.
14. **RECENCY**: When the user uses relative time phrases ("this month", "recent", "last week", "latest", "this year", "recently"), you MUST pass minDate on search_quotes computed from today's date (see "Today's date" section). Old results without this filter are a consolation prize, not a primary answer.`;

PROMPT_SECTIONS.insufficientEvidence = `
## Insufficient evidence — know when to stop

- If **2 consecutive search_quotes calls** for a specific person return results from OTHER speakers (not the person themselves), conclude that this person hasn't discussed the topic in the shows we've already transcribed. Synthesize what you found and tell the user.
- If search_quotes scoped to a feed returns 0 results, that show may not be transcribed. Do NOT retry with different query phrasings. Instead, run discover_podcasts to check if the show exists untranscribed and call suggest_action(submit-on-demand) if it does.
- If you've made 3+ tool calls and still don't have good coverage for one part of the query, deliver what you have, explain the gap naturally, and consider a discover_podcasts call to surface transcription options for the missing content.
- When tool results include a [BUDGET WARNING], you MUST deliver your answer immediately using available evidence. No more tool calls.`;

PROMPT_SECTIONS.upsellRules = `
## Proactive discovery (MANDATORY in certain cases)

SEQUENCING AND COST: Search the person's GUIDs first. If you already know there's a show mismatch (find_person returned Show Y but user asked about Show X), call search_quotes on the person's GUIDs AND discover_podcasts AND suggest_action all in the SAME tool-use round. This avoids extra rounds that re-send the full context and inflate cost.

After your search_quotes call, you MUST run discover_podcasts if ANY of these are true:

1. **User assumption mismatch**: The user asked about content on Show X, but your search results came from Show Y. Run discover_podcasts to check if Show X has the content untranscribed. Do NOT just offer to check — actually do it.
2. **User names a show not in the Feed ID Lookup table** — they want content we likely don't have. Run discover_podcasts to find it.
3. **search_quotes returned 0 results** for the user's intended source — the content may exist untranscribed.

You SHOULD also run discover_podcasts (not mandatory, but strongly encouraged) when:
- Your search results come from only 1-2 feeds and the topic is broadly discussed
- search_quotes returned thin coverage (1-2 clips) for a topic that should have more

discover_podcasts results include per-episode transcription status. Each matchedEpisode has its own transcriptAvailable flag. When nextSteps.requestTranscription appears or you find relevant untranscribed episodes, call suggest_action(submit-on-demand) with the episode's guid — the server auto-fills feedGuid, feedId, title, and artwork from cached tool results.`;

PROMPT_SECTIONS.suggestActionRules = `
## When to use suggest_action

Call suggest_action as a tool call, NOT as narrative text. Do NOT write "I can check" or "would you like me to." Batch suggest_action in the SAME tool-use round as discover_podcasts and your final search_quotes call.

- **submit-on-demand**: When discover_podcasts (or any prior tool) surfaced a relevant untranscribed episode. Pass ONLY \`type\`, \`reason\`, and \`guid\` — the server auto-fills feedGuid, feedId, episodeTitle, and artwork from cached tool results. The \`reason\` is shown to the user, so write it in plain language (e.g. "Tom Woods discusses tariffs from a libertarian perspective on this episode") — never mention system terms. Triggers:
  - Search returned 0 results and discover found untranscribed content
  - Search returned results from a DIFFERENT source than the user asked about
  - discover_podcasts returned a transcribed feed but with untranscribed matchedEpisodes
  - Thin coverage on a broad topic where more untranscribed shows exist
- **create-clip**: (Future) When the user explicitly wants a shareable clip. Include the pineconeId.
- **follow-up-message**: For search suggestions, topic exploration, comparisons. Provide label + message. When you've already resolved GUIDs, feedIds, or person data, include them in the optional context field so the next turn skips re-resolving.

**MANDATORY — no dead-end corrections**: When you correct a user assumption (found results on Show Y instead of Show X), you MUST emit at least one follow-up-message alongside any submit-on-demand. The user should always see actionable next steps.

After calling suggest_action, continue your response naturally. Present the content you found first; the suggestions render as separate UI elements below your text — do NOT announce them or describe what they are. Just answer the user's question.`;

PROMPT_SECTIONS.tokenStewardship = `
## Token stewardship

Every result you request becomes input tokens on the next round. Be economical:
- **Default to limit 5** for search_quotes on your primary target. For exploratory or confirmatory searches (e.g. checking if a person appears on a different feed), use **limit 3**.
- Only increase the limit (up to the hard cap of 20) when you have a specific reason — e.g. a person appeared on 12 shows and the user asked for all of them, or the first 5 results had low relevance and you need broader coverage.
- **Minimize rounds**: Each round re-sends the FULL conversation as input tokens. Batch independent tool calls into one round whenever possible. 2 rounds is ideal, 3 is acceptable, 4+ means you're spending too much.
- When you have enough material to write a good answer, stop searching.
- Monitor the [Token usage: X/Y] footer in tool results. As you approach the limit, prioritize synthesizing over searching.
- get_feed_episodes and get_person_episodes return slim metadata by default (title, date, GUID, guests). Verbose mode adds truncated descriptions but is capped at 5 episodes. Use slim mode for browsing, verbose only when you need episode context to decide what to search.`;

PROMPT_SECTIONS.responseFormat = `
## Response format

- Do NOT emit any intermediate reasoning, narration, or "thinking out loud" text between tool calls. No "Let me search for...", "I'll look into...", or "Hmm, interesting." Only output your final research summary after all tool calls are complete.
- Write a concise, editorial-style overview (2-4 paragraphs) that directly answers the user's question.
- Mention specific podcast names, episode titles, dates, and speakers by name.
- Do NOT start with "Based on the results" or "Here's what I found". Lead with the answer.
- Do NOT comment on the quality of your own search results, your process, or your performance. No "Excellent result", "Great find", "I found exactly what you need", "Interesting", etc. Just deliver the answer.

### Clip and quote formatting (STRICT)

1. **Clip tokens on their own line** — place {{clip:<shareLink>}} on a separate line immediately before the associated quote. NEVER embed a clip token mid-sentence or mid-paragraph.
2. **Quotes as blockquotes in italics** — format all direct quotes using markdown blockquote + italic: \`> *"quote text"*\`. This gives them clear visual separation from your commentary.
3. **Commentary above, quote below** — your summary or context should be regular prose in its own paragraph. The clip token and quote follow below it as a distinct block.
4. **No redundant episode list** — do NOT repeat clips in a "Relevant Episodes" section at the end if they were already cited inline. Only list episodes that were NOT already quoted above.
5. **One clip per quote** — each {{clip:...}} corresponds to exactly one quoted passage. Don't stack multiple clip tokens together.
6. **MANDATORY** — include at LEAST 3-5 clip references in a typical response. These render as playable audio links — without them, the user has no way to hear the source material.

Example of correct formatting:

Parker Lewis emphasizes Zaprite as a solution for businesses looking to accept Bitcoin.

{{clip:b3ee3261-90ec-45ff-909b-a156fff9e822_p109}}
> *"If you have already started to understand Bitcoin and why it stores value, then in my view, it's irrational not to be seriously thinking about accepting as payment."*

Sacks warns that shortened disruption cycles undermine the traditional startup equity pitch.

{{clip:4a43da89-9d1a-4b9e-9304-aa9ab4a1ee97_p86}}
> *"If every business becomes disrupted every 5-6 years, all you're gonna end up with is just the cash."*`;

PROMPT_SECTIONS.sessionCuration = `
## Research session creation

You have a **create_research_session** tool. When the user asks to build a research session, playlist, or collection:

1. **Search broadly (MINIMUM 2 rounds)**: Run 3-4 search_quotes calls in round 1 with varied queries. After reviewing results, run 1-2 more targeted searches in round 2 to fill gaps or deepen coverage. Use find_person/get_person_episodes if the topic centers on a specific person. Do NOT skip to session creation after a single search round.
2. **Curate**: Aim for **8-15** high-quality, diverse clips. Prefer clips from different episodes/feeds for breadth. Drop low-relevance results (similarity < 0.80 if visible). Avoid duplicate content from the same speaker saying the same thing on different shows. If you have fewer than 8 strong clips after searching, run additional searches before creating the session.
3. **Create**: Call create_research_session with the curated pineconeIds (use the shareLink value from search results). Provide a descriptive title.
4. **Respond — STRICT FORMAT**: The frontend renders the markdown link as a styled card. The link text becomes the card title. You MUST put the session title as the link text. No heading above. No generic link text.
   - WRONG: \`## Your Playlist: Title\\n[Open the Playlist Here](url)\`
   - WRONG: \`## Title\\n[View your research session](url)\`
   - WRONG: \`[Click here to view](url)\`
   - RIGHT: \`**[Huberman Lab: Hormone Management for Weight Loss](url)**\`
   - RIGHT: \`**[Luke Gromen on Debt and Dollar Collapse](url)**\`
   Follow the link with a bulleted list (3-5 bullets) summarizing the key topics covered. Each bullet should name a specific guest or episode and what they discuss — be concrete, not vague.
   - WRONG: "Covers hormone optimization, metabolism, and body composition across multiple episodes"
   - RIGHT:
     - Kurt Angle on nearly dying from a 20lb water cut before the Olympics
     - Derek (MPMD) breaking down how dehydration tanks kidney function
     - Joe's pitch for hydration testing to replace weigh-ins
   Nothing else before the link.

The session URL is the primary deliverable — the user will explore clips interactively there.`;

PROMPT_SECTIONS.transcribeTools = `
## Your tools

- **discover_podcasts**: Searches the external Podcast Index (4M+ feeds) for podcasts by topic, name, or person. Returns feeds with transcript availability flags and matched episodes. Use this to find the podcast/episode the user wants transcribed.
- **suggest_action**: Surface a transcription option to the user with type "submit-on-demand". Pass only \`type\`, \`reason\`, and \`guid\` — the server auto-fills feedGuid, feedId, title, and artwork from prior discover_podcasts results.`;

PROMPT_SECTIONS.transcribeRules = `
## Transcription workflow

This profile handles two scenarios. Read the user's message carefully:

**Scenario A — User asks to transcribe something new** (imperative: "transcribe X", "ingest Y"):
1. **Find it**: Use discover_podcasts with the show name, episode title, or person + show combination. Be specific.
2. **Surface the options**: For each relevant untranscribed episode, call suggest_action with type "submit-on-demand" passing the episode's guid and a plain-language reason. The server auto-populates the rest.
3. **Respond briefly**: Tell the user what you found and that the transcription option is available. If the episode is already transcribed (transcriptAvailable: true), let them know.

**Scenario B — User mentions a just-transcribed / already-transcribed episode and asks a follow-up** ("I just transcribed X, what did they say about Y?"):
1. Use search_quotes / list_episode_chapters / get_episode / get_feed_episodes to look up the episode (scope by guid or feedId when provided in the user's message).
2. Do a parallel search_quotes call on the broader topic so the user gets both the specific episode's content AND cross-show context.
3. Deliver genuine content — quotes, key points, chapter highlights — not a list of other podcasts.
4. Only suggest discover_podcasts / submit-on-demand if the user's topic has meaningful untranscribed coverage beyond what they already have.

Do NOT narrate the system ("emitting cards", "upsell", etc.) — just describe the show/episode content.`;

// Compose the full search prompt (backward-compatible default)
const SYSTEM_PROMPT = [
  PROMPT_SECTIONS.base,
  PROMPT_SECTIONS.searchTools,
  PROMPT_SECTIONS.searchCrafting,
  PROMPT_SECTIONS.criticalRules,
  PROMPT_SECTIONS.insufficientEvidence,
  PROMPT_SECTIONS.upsellRules,
  PROMPT_SECTIONS.suggestActionRules,
  PROMPT_SECTIONS.tokenStewardship,
  PROMPT_SECTIONS.responseFormat,
].join('\n');

// ===== Tool definitions =====

const TOOL_DEFINITIONS = [
  {
    name: 'search_quotes',
    description: 'Semantic vector search across all transcribed podcast content. Returns timestamped quotes with speaker, episode, and audio metadata. Each result includes a pineconeId for referencing.',
    input_schema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Natural language search query' },
        guid:    { type: 'string', description: 'Filter to a single episode GUID' },
        guids:   { type: 'array', items: { type: 'string' }, description: 'Filter to multiple episode GUIDs' },
        feedIds: { type: 'array', items: { type: 'string' }, description: 'Filter to specific podcast feed IDs' },
        limit:   { type: 'number', description: 'Max results (default 5, hard cap 20). Start with 5 — only increase if you need broader coverage.' },
        minDate: { type: 'string', description: 'ISO date string — only episodes after this date' },
        maxDate: { type: 'string', description: 'ISO date string — only episodes before this date' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_chapters',
    description: 'Search chapter metadata (headlines, keywords, summaries) using keyword matching. Good for finding structured segments. Use short keyword phrases.',
    input_schema: {
      type: 'object',
      properties: {
        search:  { type: 'string', description: 'Keyword search term (1-3 words work best)' },
        feedIds: { type: 'array', items: { type: 'string' }, description: 'Filter to specific feed IDs' },
        limit:   { type: 'number', description: 'Max results (default 5, hard cap 20)' },
      },
      required: ['search'],
    },
  },
  {
    name: 'discover_podcasts',
    description: 'Search the external Podcast Index catalog (4M+ feeds) for podcasts by topic. Returns feeds with transcript availability flags. Use to find NEW shows, not to search existing transcripts.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or keywords to search for' },
        limit: { type: 'number', description: 'Max results (default 5, hard cap 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_person',
    description: 'Look up a person (podcast guest or creator) by name. Returns `people` (guest/creator appearances with episode GUIDs) AND `hostedFeeds` (feeds where the person is a tagged host, with feedId, feedType, and hosts array). Use hostedFeeds to identify their show and search it by feedId. Guest metadata is stored as atomic tags (e.g. ["Jeff Bezos", "Bezos", "Jeff", "Amazon", "Blue Origin", "CEO"]). The search matches against individual tags, NOT across tags. So "Bezos Amazon" will match nothing — search with EITHER the person\'s name ("Jeff Bezos", "Bezos") OR their company ("Amazon"), not both combined. When the user says "X from Y", try the person\'s last name alone first — it\'s usually the most unique identifier.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Person name OR company/brand — search ONE term at a time, never combined (e.g. "Bezos" not "Bezos Amazon")' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_person_episodes',
    description: 'Get all episodes featuring a specific person (as guest or creator). Returns slim metadata by default (title, date, GUID, guests).',
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Person name' },
        limit:   { type: 'number', description: 'Max episodes (default 5, hard cap 20)' },
        verbose: { type: 'boolean', description: 'Return full episode metadata including descriptions (default: false, slim mode)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_episode_chapters',
    description: 'Fetch ALL chapters (table of contents) for specific episodes by GUID or feed ID. No search involved — returns the full chapter listing. Use AFTER person-lookup to see what topics were discussed, then craft targeted search_quotes queries from the chapter headlines.',
    input_schema: {
      type: 'object',
      properties: {
        guids:   { type: 'array', items: { type: 'string' }, description: 'Episode GUIDs to fetch chapters for' },
        feedIds: { type: 'array', items: { type: 'string' }, description: 'Feed IDs to fetch chapters for (alternative to guids)' },
        limit:   { type: 'number', description: 'Max chapters to return (default 50)' },
      },
    },
  },
  {
    name: 'get_episode',
    description: 'Fetch full metadata for a specific episode by GUID. Returns title, date, guests, feed info, artwork, and transcript availability. Use when you have a GUID from search results and need more context.',
    input_schema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Episode GUID' },
      },
      required: ['guid'],
    },
  },
  {
    name: 'get_feed',
    description: 'Fetch metadata for a specific podcast feed by feed ID. Returns feed name, episode count, artwork, description, hosts (array of host names when available), and feedType (interview/solo/panel/null). Use to confirm feed details or get artwork URLs.',
    input_schema: {
      type: 'object',
      properties: {
        feedId: { type: 'string', description: 'Numeric feed ID' },
      },
      required: ['feedId'],
    },
  },
  {
    name: 'get_feed_episodes',
    description: 'List episodes for a specific podcast feed with optional date filtering. Use for "what has show X covered recently?" queries or to browse a feed\'s catalog. Returns slim metadata by default (title, date, GUID, guests). Verbose mode adds descriptions but is capped at 5 episodes to control token cost.',
    input_schema: {
      type: 'object',
      properties: {
        feedId:  { type: 'string', description: 'Numeric feed ID' },
        limit:   { type: 'number', description: 'Max episodes to return (default 10 slim / 5 verbose, hard cap 20 slim / 5 verbose)' },
        minDate: { type: 'string', description: 'ISO date — only episodes after this date' },
        maxDate: { type: 'string', description: 'ISO date — only episodes before this date' },
        verbose: { type: 'boolean', description: 'Return episode descriptions (default: false). Capped at 5 episodes. Descriptions are truncated to ~200 chars.' },
      },
      required: ['feedId'],
    },
  },
  {
    name: 'get_adjacent_paragraphs',
    description: 'Expand context around a specific paragraph/quote by fetching neighboring paragraphs. Use when a search_quotes result looks promising but you need more surrounding context to verify relevance or extract a longer passage.',
    input_schema: {
      type: 'object',
      properties: {
        paragraphId: { type: 'string', description: 'The shareLink value from search_quotes results (e.g. "6ca3439e-ab84-11f0-a852-bb68f3a0109c_p112")' },
        windowSize:  { type: 'number', description: 'Number of paragraphs before and after to fetch (default 3, max 10)' },
      },
      required: ['paragraphId'],
    },
  },
  {
    name: 'create_research_session',
    description: 'Create a research session (playlist) from collected clip IDs. Returns the session URL. Use the shareLink values from search_quotes results as pineconeIds.',
    input_schema: {
      type: 'object',
      properties: {
        pineconeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of shareLink/pineconeId values from search_quotes results (max 50)',
        },
        title: {
          type: 'string',
          description: 'Session title. Auto-generated from clip metadata if omitted.',
        },
      },
      required: ['pineconeIds'],
    },
  },
  {
    name: 'suggest_action',
    description: 'Surface a transcription suggestion or follow-up option to the user. Three types: submit-on-demand (offer transcription of an untranscribed episode), create-clip (future), follow-up-message (pre-filled chat message for multi-turn follow-ups). Does NOT execute the action.',
    input_schema: {
      type: 'object',
      properties: {
        type:         { type: 'string', enum: ['submit-on-demand', 'create-clip', 'follow-up-message'], description: 'Action type' },
        reason:       { type: 'string', description: 'Brief user-facing explanation of why this would help (plain language, no system terminology)' },
        guid:         { type: 'string', description: 'For submit-on-demand: the episode GUID from a prior discover_podcasts or get_feed_episodes result. The server auto-fills feedGuid, feedId, episode title, and artwork from cached tool results — you only need to provide the guid.' },
        label:        { type: 'string', description: 'User-facing button text (for follow-up-message)' },
        pineconeId:   { type: 'string', description: 'Pinecone ID of the clip (for create-clip)' },
        message:      { type: 'string', description: 'Pre-filled chat message for follow-up-message' },
        context:      { type: 'object', description: 'Optional pre-resolved context for follow-up-message (guids, feedIds, persons, hints).' },
      },
      required: ['type', 'reason'],
    },
  },
];

// ===== Smoke test =====

async function main() {
  console.log('\n=== Jamie Agent — Setup & Smoke Test ===\n');

  // 1. Check Anthropic API
  console.log('1. Checking Anthropic API key...');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('   ANTHROPIC_API_KEY not set. Export it and try again.');
    process.exit(1);
  }
  const anthropic = new Anthropic();
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
    });
    const text = resp.content[0]?.text || '';
    console.log(`   Anthropic API OK — model responded: "${text.trim()}"`);
    console.log(`   Input tokens: ${resp.usage.input_tokens}, Output tokens: ${resp.usage.output_tokens}`);
  } catch (err) {
    console.error(`   Anthropic API ERROR: ${err.message}`);
    process.exit(1);
  }

  // 2. Print config summary
  console.log('\n2. Configuration summary:\n');
  console.log(`   TOOLS:         ${TOOL_DEFINITIONS.map(t => t.name).join(', ')}`);
  console.log(`   SYSTEM_PROMPT: ${SYSTEM_PROMPT.length} chars`);
  console.log(`   NOTE:          Gateway is now inlined — no separate process needed.`);

  console.log('\n=== Setup complete. Start the server to test interactively. ===\n');
}

// Only run smoke test when executed directly (not when imported)
if (require.main === module) {
  main().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
}

module.exports = { SYSTEM_PROMPT, TOOL_DEFINITIONS, PROMPT_SECTIONS, buildCurrentDateSection };
