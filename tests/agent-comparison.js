#!/usr/bin/env node

/**
 * Agent Comparison Test
 *
 * Sends the same queries to both:
 *   1. POST /api/chat/workflow  (hand-rolled orchestrator, gpt-4o-mini planner)
 *   2. POST /api/chat/agent    (Claude Sonnet tool-use loop)
 *
 * Compares: quality, tool ordering, cost, latency.
 *
 * Prerequisites:
 *   - Jamie API running on :4132     (nodemon server.js)
 *   - Agent gateway running on :3456  (node agent-gateway.js)
 *
 * Usage:
 *   node tests/agent-comparison.js [--query N]
 */

const JAMIE_URL = process.env.JAMIE_URL || 'http://localhost:4132';
const JWT = process.env.TEST_JWT || '';

const TEST_QUERIES = [
  {
    name: 'Person Dossier',
    task: "find Luke Gromen's last 5 appearances and give me a high level overview",
  },
  {
    name: 'Topic Research',
    task: 'find me key quotes on the privacy properties of the Lightning Network',
  },
  {
    name: 'Current Events',
    task: 'What are podcasters saying about AI regulation this month',
  },
];

// ===== Helpers =====

function parseSSE(raw) {
  const events = [];
  const lines = raw.split('\n');
  let currentEvent = null;
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
      if (currentEvent) {
        try {
          events.push({ event: currentEvent, data: JSON.parse(currentData) });
        } catch {
          events.push({ event: currentEvent, data: currentData });
        }
      }
      currentEvent = null;
      currentData = '';
    }
  }
  return events;
}

async function runWorkflowQuery(task) {
  const start = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  if (JWT) headers['Authorization'] = `Bearer ${JWT}`;
  else headers['X-Free-Tier'] = 'true';

  const resp = await fetch(`${JAMIE_URL}/api/chat/workflow`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      task,
      maxIterations: 3,
      outputFormat: 'streaming',
      premium: true,
    }),
  });

  const raw = await resp.text();
  const latencyMs = Date.now() - start;
  const events = parseSSE(raw);

  const resultEvent = events.find(e => e.event === 'result' && e.data?.summary);
  const doneEvent = events.find(e => e.event === 'done');
  const iterationEvents = events.filter(e => e.event === 'iteration');
  const statusEvents = events.filter(e => e.event === 'status');

  const toolOrder = iterationEvents
    .filter(e => e.data?.status === 'running' || e.data?.status === 'complete')
    .map(e => `${e.data.step}(${e.data.status === 'complete' ? e.data.resultCount + ' results' : 'running'})`)
    .filter((v, i, a) => a.indexOf(v) === i);

  return {
    engine: 'workflow (gpt-4o-mini planner)',
    latencyMs,
    summary: resultEvent?.data?.summary || '(no summary)',
    clipCount: resultEvent?.data?.results?.clips?.length || 0,
    personEpisodeCount: resultEvent?.data?.results?.personEpisodes?.length || 0,
    toolOrder,
    iterationsUsed: resultEvent?.data?.iterationsUsed || 0,
    cost: resultEvent?.data?.cost || {},
    tokens: { input: '~5K (estimated)', output: '~1K (estimated)' },
    statusMessages: statusEvents.map(e => e.data?.message).filter(Boolean),
    hasClipTokens: (resultEvent?.data?.summary || '').includes('{{clip:'),
  };
}

async function runAgentQuery(task) {
  const start = Date.now();

  const resp = await fetch(`${JAMIE_URL}/api/chat/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: task }),
  });

  const raw = await resp.text();
  const latencyMs = Date.now() - start;
  const events = parseSSE(raw);

  const textEvents = events.filter(e => e.event === 'text');
  const toolCallEvents = events.filter(e => e.event === 'tool_call');
  const toolResultEvents = events.filter(e => e.event === 'tool_result');
  const doneEvent = events.find(e => e.event === 'done');

  const fullText = textEvents.map(e => e.data?.text || '').join('');
  const toolOrder = toolCallEvents.map(e => {
    const matchingResult = toolResultEvents.find(r => r.data?.tool === e.data?.tool && r.data?.round === e.data?.round);
    return `${e.data.tool}(${matchingResult?.data?.resultCount ?? '?'} results)`;
  });

  return {
    engine: 'agent (Claude Sonnet 4.5)',
    latencyMs,
    summary: fullText.substring(0, 500) + (fullText.length > 500 ? '...' : ''),
    fullSummaryLength: fullText.length,
    toolOrder,
    rounds: doneEvent?.data?.rounds || 0,
    cost: doneEvent?.data?.cost || {},
    tokens: doneEvent?.data?.tokens || {},
    hasClipTokens: fullText.includes('{{clip:'),
  };
}

// ===== Main =====

async function main() {
  const queryIndex = process.argv.includes('--query')
    ? parseInt(process.argv[process.argv.indexOf('--query') + 1], 10) - 1
    : null;

  const queries = queryIndex !== null && queryIndex >= 0 && queryIndex < TEST_QUERIES.length
    ? [TEST_QUERIES[queryIndex]]
    : TEST_QUERIES;

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║         Jamie Agent vs Workflow Comparison Test         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  for (const q of queries) {
    console.log(`━━━ ${q.name} ━━━`);
    console.log(`Query: "${q.task}"\n`);

    // Run both in parallel
    const [workflowResult, agentResult] = await Promise.allSettled([
      runWorkflowQuery(q.task),
      runAgentQuery(q.task),
    ]);

    const wf = workflowResult.status === 'fulfilled' ? workflowResult.value : { engine: 'workflow', error: workflowResult.reason?.message };
    const ag = agentResult.status === 'fulfilled' ? agentResult.value : { engine: 'agent', error: agentResult.reason?.message };

    // Print comparison table
    console.log('┌─────────────────────┬────────────────────────────┬────────────────────────────┐');
    console.log('│ Metric              │ Workflow (gpt-4o-mini)     │ Agent (Claude Sonnet)      │');
    console.log('├─────────────────────┼────────────────────────────┼────────────────────────────┤');

    const rows = [
      ['Latency', `${wf.latencyMs || '?'}ms`, `${ag.latencyMs || '?'}ms`],
      ['Tool order', truncate((wf.toolOrder || []).join(' → '), 26), truncate((ag.toolOrder || []).join(' → '), 26)],
      ['Iterations/Rounds', `${wf.iterationsUsed || '?'} iterations`, `${ag.rounds || '?'} rounds`],
      ['Summary length', `${(wf.summary || '').length} chars`, `${ag.fullSummaryLength || (ag.summary || '').length} chars`],
      ['{{clip:}} tokens', wf.hasClipTokens ? 'Yes' : 'No', ag.hasClipTokens ? 'Yes' : 'No'],
      ['Cost (Claude/OpenAI)', formatCost(wf.cost), `$${ag.cost?.claude?.toFixed(4) || '?'}`],
      ['Cost (gateway/API)', wf.cost?.net ? `$${(wf.cost.net / 1_000_000).toFixed(4)}` : '?', `$${ag.cost?.gateway?.toFixed(4) || '?'}`],
      ['Cost (total)', wf.cost?.net ? `$${(wf.cost.net / 1_000_000).toFixed(4)}` : '?', `$${ag.cost?.total?.toFixed(4) || '?'}`],
      ['Tokens', typeof wf.tokens === 'object' ? wf.tokens.input : '?', `${ag.tokens?.input || '?'}in / ${ag.tokens?.output || '?'}out`],
    ];

    for (const [label, val1, val2] of rows) {
      console.log(`│ ${pad(label, 19)} │ ${pad(val1, 26)} │ ${pad(val2, 26)} │`);
    }

    console.log('└─────────────────────┴────────────────────────────┴────────────────────────────┘');

    // Print summaries
    console.log('\n--- Workflow Summary (first 300 chars) ---');
    console.log((wf.summary || wf.error || '(none)').substring(0, 300));
    console.log('\n--- Agent Summary (first 300 chars) ---');
    console.log((ag.summary || ag.error || '(none)').substring(0, 300));

    if (wf.error) console.log(`\nWorkflow ERROR: ${wf.error}`);
    if (ag.error) console.log(`\nAgent ERROR: ${ag.error}`);

    console.log('\n');
  }
}

function pad(str, len) {
  const s = String(str || '');
  return s.length > len ? s.substring(0, len - 1) + '…' : s.padEnd(len);
}

function truncate(str, len) {
  return str.length > len ? str.substring(0, len - 1) + '…' : str;
}

function formatCost(cost) {
  if (!cost) return '?';
  if (cost.net !== undefined) return `$${(cost.net / 1_000_000).toFixed(4)}`;
  return '?';
}

main().catch(err => {
  console.error('Comparison test failed:', err);
  process.exit(1);
});
