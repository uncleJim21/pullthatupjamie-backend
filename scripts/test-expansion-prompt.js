/**
 * test-expansion-prompt.js
 *
 * Unit-style probe: does the new `search_quotes.expansions` parameter actually
 * get populated correctly by each orchestrator we use (Haiku 4.5, DeepSeek
 * V4-Flash)? Validates that the prompt change in setup-agent.js triggers the
 * right behavior on both models before we change the index.
 *
 * For each test query, calls each model once with the search_quotes tool
 * definition and the user message, then extracts the tool_use input. Prints:
 *   - query / expansions the model chose
 *   - pass / fail vs expectation (canonical cases must produce non-empty
 *     expansions; the generic case must produce empty)
 *
 * Does NOT actually execute searchQuotes — purely tests the orchestrator's
 * tool-call shape.
 *
 * Usage:
 *   node scripts/test-expansion-prompt.js
 *
 * Requires: ANTHROPIC_API_KEY, OPENROUTER_API_KEY in .env.
 */

require('dotenv').config();

const { createProvider } = require('../utils/agent/providers');
const { TOOL_DEFINITIONS } = (() => {
  // setup-agent.js exports the agent factory + tool defs.
  const setupAgent = require('../setup-agent');
  return { TOOL_DEFINITIONS: setupAgent.TOOL_DEFINITIONS || setupAgent.tools || null };
})();

if (!Array.isArray(TOOL_DEFINITIONS)) {
  console.error('Could not locate TOOL_DEFINITIONS export on setup-agent.js');
  process.exit(1);
}

// Trim to just search_quotes to keep the prompt focused. Real agent runs send
// all tools; here we only want to probe one tool's parameter behavior.
const searchQuotesTool = TOOL_DEFINITIONS.find(t => t.name === 'search_quotes');
if (!searchQuotesTool) {
  console.error('search_quotes tool not found in TOOL_DEFINITIONS');
  process.exit(1);
}

const TEST_CASES = [
  {
    name: 'compound brand (albyhub)',
    userMessage: 'What did the host say about albyhub?',
    requireNonEmpty: true,
    mustInclude: ['Alby Hub'], // case-insensitive contains
  },
  {
    name: 'URL with spelled-out form (lncurl.lol)',
    userMessage: 'Find references to lncurl.lol in the transcripts.',
    requireNonEmpty: true,
    mustInclude: ['lncurl'],   // any variant that retains the lncurl token
  },
  {
    name: 'compound acronym (nostrwalletconnect)',
    userMessage: 'Tell me about nostrwalletconnect.',
    requireNonEmpty: true,
    mustInclude: ['Nostr Wallet Connect'],
  },
  {
    name: 'generic conceptual query (no specific terms)',
    userMessage: 'What general themes have the hosts discussed about market sentiment this year?',
    requireNonEmpty: false,
    mustInclude: [],
  },
];

const MODELS = [
  {
    label: 'Haiku 4.5',
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    skipIf: () => !process.env.ANTHROPIC_API_KEY,
  },
  {
    label: 'DeepSeek V4-Flash (OpenRouter)',
    provider: 'openrouter',
    model: process.env.OPENROUTER_DEEPSEEK_FLASH_MODEL || 'deepseek/deepseek-v4-flash',
    skipIf: () => !process.env.OPENROUTER_API_KEY,
  },
];

const SYSTEM_PROMPT = `You are a search assistant for a podcast transcript corpus. When the user asks about a topic, person, brand, or specific term, you should call the search_quotes tool to find relevant transcript passages.

Use the tool's expansions parameter as described in its tool description — populate it for proper-noun / brand / URL / spec queries, leave it empty for generic conceptual queries.`;

function extractToolCalls(response) {
  if (!response || !Array.isArray(response.content)) return [];
  return response.content.filter(c => c.type === 'tool_use');
}

function evaluate(testCase, expansions) {
  const isEmpty = !expansions || expansions.length === 0;
  if (testCase.requireNonEmpty && isEmpty) {
    return { pass: false, reason: 'expected non-empty expansions, got empty' };
  }
  if (!testCase.requireNonEmpty && !isEmpty) {
    return { pass: false, reason: `expected empty expansions, got ${JSON.stringify(expansions)}` };
  }
  for (const needle of testCase.mustInclude) {
    const present = expansions.some(v =>
      typeof v === 'string' && v.toLowerCase().includes(needle.toLowerCase())
    );
    if (!present) {
      return { pass: false, reason: `missing expected variant matching "${needle}"` };
    }
  }
  return { pass: true, reason: 'ok' };
}

async function runOne({ providerName, modelId, label, testCase }) {
  const provider = createProvider(providerName);
  const started = Date.now();
  let response;
  try {
    response = await provider.createResponse({
      model: modelId,
      maxTokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: testCase.userMessage }],
      tools: [searchQuotesTool],
      toolChoice: { type: 'tool', name: 'search_quotes' }, // force tool call so we always get a tool_use back
      timeoutMs: 30000,
      // Provider abstractions expect these as callables: anthropicProvider's
      // consumeAnthropicStream calls aborted() on every stream event and
      // onTextDelta(text) whenever a text delta appears.
      aborted: () => false,
      onTextDelta: () => {},
      requestId: `expansion-test-${Date.now()}`,
    });
  } catch (err) {
    return { label, model: modelId, testCase: testCase.name, error: err.message, elapsed: Date.now() - started };
  }
  const elapsed = Date.now() - started;
  const toolCalls = extractToolCalls(response);
  const sq = toolCalls.find(tc => tc.name === 'search_quotes');
  if (!sq) {
    return { label, model: modelId, testCase: testCase.name, error: 'no search_quotes tool call returned', elapsed, raw: response };
  }
  const expansions = Array.isArray(sq.input?.expansions) ? sq.input.expansions : [];
  const evalResult = evaluate(testCase, expansions);
  return {
    label, model: modelId, testCase: testCase.name,
    query: sq.input?.query, expansions,
    pass: evalResult.pass, reason: evalResult.reason, elapsed,
  };
}

async function main() {
  const banner = '━'.repeat(80);
  console.log(`\n${banner}`);
  console.log('search_quotes.expansions — orchestrator behavior test');
  console.log(banner);

  const results = [];
  for (const m of MODELS) {
    if (m.skipIf && m.skipIf()) {
      console.log(`\n⊘ SKIP ${m.label} — missing API key`);
      continue;
    }
    console.log(`\n${m.label}`);
    console.log('─'.repeat(80));
    for (const testCase of TEST_CASES) {
      const r = await runOne({ providerName: m.provider, modelId: m.model, label: m.label, testCase });
      results.push(r);
      const verdict = r.error ? '✘ ERROR' : (r.pass ? '✓ PASS ' : '✘ FAIL ');
      console.log(`  ${verdict} [${testCase.name}]  (${r.elapsed}ms)`);
      if (r.error) {
        console.log(`          error: ${r.error}`);
      } else {
        console.log(`          query: "${r.query}"`);
        console.log(`          expansions: ${JSON.stringify(r.expansions)}`);
        if (!r.pass) console.log(`          reason: ${r.reason}`);
      }
    }
  }

  // --- Summary ---
  console.log(`\n${banner}`);
  console.log('Summary');
  console.log(banner);
  const byModel = new Map();
  for (const r of results) {
    if (!byModel.has(r.label)) byModel.set(r.label, { pass: 0, fail: 0, error: 0 });
    const slot = byModel.get(r.label);
    if (r.error) slot.error++;
    else if (r.pass) slot.pass++;
    else slot.fail++;
  }
  for (const [label, slot] of byModel) {
    console.log(`  ${label.padEnd(40)}  pass=${slot.pass}  fail=${slot.fail}  err=${slot.error}`);
  }
  console.log('');

  const anyFailures = results.some(r => r.error || !r.pass);
  process.exit(anyFailures ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
