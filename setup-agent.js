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

const GATEWAY_URL = process.env.AGENT_GATEWAY_URL || 'http://localhost:3456';
const GATEWAY_KEY = process.env.AGENT_GATEWAY_KEY || 'jamie_agent_poc_key';

// ===== System prompt — mirrors lessons from WorkflowOrchestrator =====

const SYSTEM_PROMPT = `You are Jamie, an expert podcast research assistant. You search a corpus of 174+ podcasts, 9,500+ episodes, and 2.3M+ transcript paragraphs.

## Your tools and what they search

- **search_quotes**: Semantic vector search across all transcribed podcast content (Pinecone). This is your MOST POWERFUL tool — it finds relevant quotes even when exact keywords don't match. Always try this first for any topic query.
- **search_chapters**: Keyword/regex search on chapter metadata (headlines, keywords, summaries). Good for structured segments but may miss content that search_quotes would find. Use short keyword phrases (1-3 words), not full sentences.
- **discover_podcasts**: Searches the external Podcast Index (4M+ feeds) for podcasts by topic. Useful for finding shows the user might not know about. Does NOT search our transcribed corpus.
- **find_person**: Looks up a person in our corpus by name.
- **get_person_episodes**: Gets all episodes featuring a specific person.

## Critical rules

1. ALWAYS try search_quotes before discover_podcasts. We have a large transcribed corpus — search it first.
2. search_chapters returning 0 does NOT mean we have no content. It uses keyword matching and may miss what search_quotes (semantic) would find.
3. discover_podcasts finds external feeds that may or may not be transcribed. It enriches results but is NOT a substitute for search_quotes.
4. For person queries, start with find_person or get_person_episodes, then use search_quotes scoped to the discovered episode GUIDs.
5. Aim for 2-5 tool calls per query. Don't over-search — if you have 5+ good quotes, summarize.

## Response format

- Write a concise, editorial-style overview (2-4 paragraphs) that directly answers the user's question.
- Mention specific podcast names, episode titles, dates, and speakers by name.
- When citing a specific quote, insert a {{clip:<pineconeId>}} token on its own line immediately after the paragraph. Only use pineconeIds from search_quotes results.
- After the prose overview, you may list the most relevant clips with timestamps for quick reference.
- Do NOT start with "Based on the results" or "Here's what I found". Lead with the answer.`;

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
        limit:   { type: 'number', description: 'Max results (default 10)' },
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
        limit:   { type: 'number', description: 'Max results (default 20)' },
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
        limit: { type: 'number', description: 'Max results (default 10)' },
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
    description: 'Get all episodes featuring a specific person (as guest or creator). Returns episode titles, dates, GUIDs, and feed IDs.',
    input_schema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Person name' },
        limit: { type: 'number', description: 'Max episodes (default 20)' },
      },
      required: ['name'],
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

  // 2. Check gateway health
  console.log('\n2. Checking Agent Gateway...');
  try {
    const resp = await fetch(`${GATEWAY_URL}/health`);
    const data = await resp.json();
    console.log(`   Gateway OK — status: ${data.status}, uptime: ${data.uptime?.toFixed(1)}s`);
  } catch (err) {
    console.error(`   Gateway ERROR: ${err.message}`);
    console.error('   Make sure agent-gateway.js is running: node agent-gateway.js');
    process.exit(1);
  }

  // 3. Test a tool call through the gateway
  console.log('\n3. Testing search_quotes through gateway...');
  try {
    const resp = await fetch(`${GATEWAY_URL}/api/search-quotes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_KEY}`,
        'X-Session-ID': 'setup-test',
      },
      body: JSON.stringify({ query: 'Bitcoin', limit: 2 }),
    });
    const data = await resp.json();
    const count = data.results?.length || 0;
    console.log(`   Gateway → Jamie API OK — ${count} results returned`);
  } catch (err) {
    console.error(`   Gateway tool call ERROR: ${err.message}`);
  }

  // 4. Print config summary
  console.log('\n4. Configuration summary:\n');
  console.log(`   GATEWAY_URL:  ${GATEWAY_URL}`);
  console.log(`   GATEWAY_KEY:  ${GATEWAY_KEY}`);
  console.log(`   MODEL:        claude-sonnet-4-5-20250514`);
  console.log(`   TOOLS:        ${TOOL_DEFINITIONS.map(t => t.name).join(', ')}`);
  console.log(`   SYSTEM_PROMPT: ${SYSTEM_PROMPT.length} chars`);

  console.log('\n=== Setup complete. Start the chat route to test interactively. ===\n');
}

// Only run smoke test when executed directly (not when imported)
if (require.main === module) {
  main().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
}

module.exports = { SYSTEM_PROMPT, TOOL_DEFINITIONS, GATEWAY_URL, GATEWAY_KEY };
