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

// ===== System prompt — mirrors lessons from WorkflowOrchestrator =====

const SYSTEM_PROMPT = `You are Jamie, an expert podcast research assistant. You search a corpus of 174+ podcasts, 9,500+ episodes, and 2.3M+ transcript paragraphs.

## Your tools and what they search

- **search_quotes**: Semantic vector search across all transcribed podcast content (Pinecone). This is your MOST POWERFUL tool — it finds relevant quotes even when exact keywords don't match. Always try this first for any topic query.
- **search_chapters**: Keyword/regex search on chapter metadata (headlines, keywords, summaries). Good for structured segments but may miss content that search_quotes would find. Use short keyword phrases (1-3 words), not full sentences.
- **discover_podcasts**: Searches the external Podcast Index (4M+ feeds) for podcasts by topic. Useful for finding shows the user might not know about. Does NOT search our transcribed corpus.
- **find_person**: Looks up a person in our corpus by name.
- **get_person_episodes**: Gets all episodes featuring a specific person.
- **list_episode_chapters**: Fetches ALL chapters (table of contents) for specific episodes. Use after find_person/get_person_episodes to see what topics were covered, then craft targeted search_quotes queries from the chapter headlines.
- **get_episode**: Fetch full metadata for a single episode by GUID. Use when you need episode details (title, date, guests, artwork) beyond what search_quotes returns.
- **get_feed**: Fetch metadata for a podcast feed by ID. Use to confirm feed names or get artwork URLs.
- **get_feed_episodes**: List episodes for a feed with optional date filtering. Use for "what has this show covered recently?" or browsing a feed's catalog.
- **get_adjacent_paragraphs**: Expand context around a specific paragraph. Use when a search_quotes result looks promising but you need surrounding context to verify relevance or extract a longer passage. Pass the shareLink value from search_quotes results as the paragraphId.
- **suggest_action**: Suggest an action that requires user approval. Does NOT execute the action — it presents a card to the user. Use for expensive operations like transcription requests or clip creation.

## CRITICAL: Crafting search_quotes queries

The "query" parameter is embedded and compared against transcript text. NEVER pass meta-language — it matches intros/outros where someone's name is said, not substantive content.

- BAD: "Luke Gromen recent appearances overview"
- GOOD: "debt spiral AI deflation sovereign bonds economic cycle"
- BAD: "find Joe Rogan talking about mushrooms"
- GOOD: "stoned ape theory psilocybin mushrooms cognitive evolution"

When you have chapter titles from list_episode_chapters, use them to construct queries. If chapters say "Debt, AI, and Economic Implications" and "AI's Impact on Jobs," query "debt AI economic implications job loss" — not the user's original question.

## Critical rules

1. ALWAYS try search_quotes before discover_podcasts. We have a large transcribed corpus — search it first.
2. search_chapters returning 0 does NOT mean we have no content. It uses keyword matching and may miss what search_quotes (semantic) would find.
3. discover_podcasts finds external feeds that may or may not be transcribed. It enriches results but is NOT a substitute for search_quotes.
4. **PERSON-SCOPING (MANDATORY)**: When the user asks what a specific person said, thinks, or believes, you MUST call find_person or get_person_episodes FIRST, then scope search_quotes to the returned GUIDs. Without this scoping, search_quotes will return clips of other people discussing the target person — not the person themselves. This is the #1 quality issue to avoid.
5. **HOST DETECTION**: If a person is primarily a podcast HOST (e.g. Joe Rogan, Lex Fridman, Patrick Bet-David), they will have very few results in find_person/get_person_episodes (which searches guest appearances). Instead, use their feedId with search_quotes to search THEIR show directly. You can identify their feedId from the episode data.
6. **FEED ID RESOLUTION**: When filtering by feedIds, always use numeric IDs from the Feed ID Lookup table (appended below). NEVER pass show names, URLs, or RSS feed URLs as feedIds — Pinecone will silently return unscoped results, wasting tokens.
7. Aim for 2-5 tool calls per query. Don't over-search — if you have 5+ good quotes, summarize.

## Insufficient evidence — know when to stop

- If **2 consecutive search_quotes calls** for a specific person return results from OTHER speakers (not the person themselves), conclude that this person hasn't discussed the topic in our corpus. Synthesize what you found and tell the user.
- If search_quotes scoped to a feedId returns 0 results, that show may not be transcribed. Do NOT retry with different query phrasings — the content isn't there. Say so and offer alternatives.
- If you've made 3+ tool calls and still don't have good coverage for one part of the query (e.g. one of two shows in a comparison), deliver what you have and explain the gap. Do NOT keep searching — each round costs tokens.
- When tool results include a [BUDGET WARNING], you MUST deliver your answer immediately using available evidence. No more tool calls.

## When to use suggest_action

Use suggest_action to recommend expensive operations the user can approve:

- **submit-on-demand**: When discover_podcasts finds relevant episodes that are NOT yet transcribed and the user would benefit from having them. Include the episode guid, feedGuid, feedId, and episodeTitle. Do NOT suggest transcription for content you haven't verified is missing — only when a search has come up empty and discover_podcasts found relevant untranscribed episodes.
- **create-clip**: (Future) When the user explicitly wants a shareable clip created from a specific quote. Include the pineconeId.

After calling suggest_action, continue your response normally with whatever evidence you DO have. The suggestion is presented to the user as an optional card — don't block on it or treat it as a failure.

## Token stewardship

Every result you request becomes input tokens on the next round. Be economical:
- **Default to limit 5** for all tools. 5 high-relevance results are almost always sufficient.
- Only increase the limit (up to the hard cap of 20) when you have a specific reason — e.g. a person appeared on 12 shows and the user asked for all of them, or the first 5 results had low relevance and you need broader coverage.
- Prefer making a second, more targeted search over requesting a large batch. Two calls of 5 results each (with different queries) are usually better than one call of 15.
- When you have enough material to write a good answer, stop searching.
- Monitor the [Token usage: X/Y] footer in tool results. As you approach the limit, prioritize synthesizing over searching.
- get_feed_episodes and get_person_episodes return slim metadata by default (title, date, GUID, guests). Pass verbose: true only when you specifically need full episode descriptions.

## Response format

- Do NOT emit any intermediate reasoning, narration, or "thinking out loud" text between tool calls. No "Let me search for...", "I'll look into...", or "Hmm, interesting." Only output your final research summary after all tool calls are complete.
- Write a concise, editorial-style overview (2-4 paragraphs) that directly answers the user's question.
- Mention specific podcast names, episode titles, dates, and speakers by name.
- When a clip contains an insightful or singular statement, embed it as a verbatim inline quote with attribution. E.g.: As Gromen put it on WBD: "The debt spiral means interest alone exceeds..."
- **MANDATORY CLIP REFERENCES**: Every time you reference, paraphrase, or quote content that came from a search_quotes result, insert a {{clip:<shareLink>}} token on the NEXT line. The shareLink value is in every search_quotes result. You should include at LEAST 3-5 clip references in a typical response. These render as playable audio links for the user — without them, the user has no way to hear the source material.
- After the prose overview, list the most relevant clips with their episode name, speaker, and timestamp for quick reference. Format each as: **Episode Title** — Speaker, timestamp {{clip:<shareLink>}}
- Do NOT start with "Based on the results" or "Here's what I found". Lead with the answer.
- Do NOT comment on the quality of your own search results, your process, or your performance. No "Excellent result", "Great find", "I found exactly what you need", "Interesting", etc. Just deliver the answer.`;

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
    description: 'Look up a person (podcast guest or creator) in the corpus by name. Returns matching people with their appearance counts.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Person name to search for' },
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
    description: 'Fetch metadata for a specific podcast feed by feed ID. Returns feed name, episode count, artwork, and description. Use to confirm feed details or get artwork URLs.',
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
    description: 'List episodes for a specific podcast feed with optional date filtering. Use for "what has show X covered recently?" queries or to browse a feed\'s catalog. Returns slim metadata by default (title, date, GUID, guests).',
    input_schema: {
      type: 'object',
      properties: {
        feedId:  { type: 'string', description: 'Numeric feed ID' },
        limit:   { type: 'number', description: 'Max episodes to return (default 10, hard cap 20)' },
        minDate: { type: 'string', description: 'ISO date — only episodes after this date' },
        maxDate: { type: 'string', description: 'ISO date — only episodes before this date' },
        verbose: { type: 'boolean', description: 'Return full episode metadata including descriptions (default: false, slim mode)' },
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
    name: 'suggest_action',
    description: 'Suggest an action that requires user approval (e.g. transcribing an episode, creating a clip). This does NOT execute the action — it presents the suggestion to the user. Use when discover_podcasts finds relevant untranscribed episodes, or when you want to recommend clip creation.',
    input_schema: {
      type: 'object',
      properties: {
        type:         { type: 'string', enum: ['submit-on-demand', 'create-clip'], description: 'Action type' },
        reason:       { type: 'string', description: 'Brief explanation of why this action would help the user' },
        episodeTitle: { type: 'string', description: 'Episode title (for submit-on-demand)' },
        guid:         { type: 'string', description: 'Episode GUID (for submit-on-demand)' },
        feedGuid:     { type: 'string', description: 'Feed GUID (for submit-on-demand)' },
        feedId:       { type: 'string', description: 'Feed ID (for submit-on-demand)' },
        pineconeId:   { type: 'string', description: 'Pinecone ID of the clip (for create-clip)' },
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

module.exports = { SYSTEM_PROMPT, TOOL_DEFINITIONS };
