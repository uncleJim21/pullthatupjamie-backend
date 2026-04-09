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
 *   node tests/agent-comparison.js [--query N] [--save]
 *
 * --save writes full output to tests/output/<timestamp>.md (gitignored)
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const JAMIE_URL = process.env.JAMIE_URL || 'http://localhost:4132';
const JWT = process.env.JWT_TEST_TOKEN || process.env.TEST_JWT || '';

const TEST_QUERIES = [
  // --- Original 6 ---
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
  {
    name: 'Precise Search',
    task: 'Find Joe Rogan talking about stoned ape theory',
  },
  {
    name: 'Expert Insights',
    task: 'Find Roger Penrose talking in depth about the physics of black holes',
  },
  {
    name: 'Expert Insights #2',
    task: 'Find a history expert talking about Russia in the Soviet era',
  },
  // --- New scenarios: cross-genre, diverse feeds ---
  {
    name: 'Finance Deep Dive',
    task: 'What is the bull case for gold right now? Find specific arguments from macro analysts.',
  },
  {
    name: 'True Crime',
    task: 'Find the most chilling story covered on Casefile or Darknet Diaries about social engineering',
  },
  {
    name: 'Health & Science',
    task: 'What has Andrew Huberman said about the effects of cold exposure on the immune system?',
  },
  {
    name: 'Geopolitics',
    task: 'Find discussions about the BRICS alliance challenging dollar hegemony',
  },
  {
    name: 'Tech / AI',
    task: 'What are the best arguments for and against open source AI models?',
  },
  {
    name: 'Host as Subject',
    task: "What is Scott Galloway's take on big tech monopolies?",
  },
  {
    name: 'Niche Bitcoin',
    task: 'Explain the tradeoffs of coinjoin vs payjoin for Bitcoin privacy',
  },
  {
    name: 'Historical',
    task: 'Find Dan Carlin or a similar host talking about the fall of the Roman Republic',
  },
  {
    name: 'Philosophy',
    task: 'What do podcast philosophers say about whether free will is an illusion?',
  },
  {
    name: 'Cross-Show Comparison',
    task: 'Compare what Breaking Points and All-In have said about tariffs this year',
  },
  {
    name: 'Specific Episode Recall',
    task: 'Find the Lex Fridman episode with a guest talking about consciousness and quantum mechanics',
  },
  {
    name: 'Obscure Topic',
    task: 'Has anyone on EconTalk or Conversations with Tyler discussed the economics of space colonization?',
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
    llmCosts: resultEvent?.data?.llmCosts || null,
    statusMessages: statusEvents.map(e => e.data?.message).filter(Boolean),
    hasClipTokens: (resultEvent?.data?.summary || '').includes('{{clip:'),
  };
}

async function runAgentQuery(task) {
  const start = Date.now();

  const agentModel = process.env.AGENT_MODEL || 'fast';

  const resp = await fetch(`${JAMIE_URL}/api/chat/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: task, model: agentModel }),
  });

  const raw = await resp.text();
  const latencyMs = Date.now() - start;
  const events = parseSSE(raw);

  const textEvents = events.filter(e => e.event === 'text');
  const toolCallEvents = events.filter(e => e.event === 'tool_call');
  const toolResultEvents = events.filter(e => e.event === 'tool_result');
  const doneEvent = events.find(e => e.event === 'done');

  const fullText = textEvents.map(e => e.data?.text || '').join('');
  const modelLabel = doneEvent?.data?.model || agentModel;
  const toolOrder = toolCallEvents.map(e => {
    const matchingResult = toolResultEvents.find(r => r.data?.tool === e.data?.tool && r.data?.round === e.data?.round);
    return `${e.data.tool}(${matchingResult?.data?.resultCount ?? '?'} results)`;
  });

  return {
    engine: `agent (${modelLabel})`,
    latencyMs,
    summary: fullText,
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

  const shouldSave = process.argv.includes('--save');
  const allResults = [];

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║         Jamie Agent vs Workflow Comparison Test         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  JWT: ${JWT ? JWT.substring(0, 20) + '...' : '\x1b[31mNOT SET — workflow will hit quota limits\x1b[0m'}`);
  if (shouldSave) console.log('  Saving full output to tests/output/');
  console.log();

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
    const agentLabel = ag.engine || 'Agent';
    console.log('┌─────────────────────┬────────────────────────────┬────────────────────────────┐');
    console.log(`│ Metric              │ Workflow (gpt-4o-mini)     │ ${pad(agentLabel, 26)} │`);
    console.log('├─────────────────────┼────────────────────────────┼────────────────────────────┤');

    // Build cost strings
    const wfLlmCost = wf.llmCosts?.totalEstimatedCost;
    const wfBillingCost = wf.cost?.net ? (wf.cost.net / 1_000_000) : null;
    const agLlmCost = ag.cost?.claude;
    const agGwCost = ag.cost?.gateway;

    const wfLlmDetail = (wf.llmCosts?.calls || []).map(c => `${c.role}(${c.model}): $${c.estimatedCost.toFixed(5)}`).join(', ') || '?';
    const agLlmDetail = ag.tokens?.input ? `${ag.tokens.input}in/${ag.tokens.output}out` : '?';

    const rows = [
      ['Latency', `${wf.latencyMs || '?'}ms`, `${ag.latencyMs || '?'}ms`],
      ['Tool order', truncate((wf.toolOrder || []).join(' → '), 26), truncate((ag.toolOrder || []).join(' → '), 26)],
      ['Iterations/Rounds', `${wf.iterationsUsed || '?'} iterations`, `${ag.rounds || '?'} rounds`],
      ['Summary length', `${(wf.summary || '').length} chars`, `${ag.fullSummaryLength || (ag.summary || '').length} chars`],
      ['{{clip:}} tokens', wf.hasClipTokens ? 'Yes' : 'No', ag.hasClipTokens ? 'Yes' : 'No'],
      ['LLM cost', wfLlmCost != null ? `$${wfLlmCost.toFixed(5)}` : '?', agLlmCost != null ? `$${agLlmCost.toFixed(5)}` : '?'],
      ['Billing cost', wfBillingCost != null ? `$${wfBillingCost.toFixed(4)}` : '?', agGwCost != null ? `$${agGwCost.toFixed(4)}` : '?'],
      ['Total infra cost', wfLlmCost != null ? `$${wfLlmCost.toFixed(5)}` : '?', ag.cost?.total != null ? `$${ag.cost.total.toFixed(5)}` : '?'],
      ['Tokens', agLlmDetail === '?' ? '?' : 'see breakdown', agLlmDetail],
    ];

    for (const [label, val1, val2] of rows) {
      console.log(`│ ${pad(label, 19)} │ ${pad(val1, 26)} │ ${pad(val2, 26)} │`);
    }

    console.log('└─────────────────────┴────────────────────────────┴────────────────────────────┘');

    // LLM cost breakdown
    if (wf.llmCosts?.calls?.length) {
      console.log('\n  Workflow LLM breakdown:');
      for (const c of wf.llmCosts.calls) {
        console.log(`    ${c.role.padEnd(12)} ${c.model.padEnd(14)} ${String(c.inputTokens).padStart(6)}in ${String(c.outputTokens).padStart(6)}out  $${c.estimatedCost.toFixed(6)}`);
      }
      console.log(`    ${'TOTAL'.padEnd(12)} ${' '.repeat(14)} ${' '.repeat(15)}  $${wf.llmCosts.totalEstimatedCost.toFixed(6)}`);
    }
    if (ag.tokens?.input) {
      const agModelName = ag.engine?.replace('agent (', '').replace(')', '') || 'claude';
      console.log('\n  Agent LLM breakdown:');
      console.log(`    ${agModelName.padEnd(22)} ${String(ag.tokens.input).padStart(6)}in ${String(ag.tokens.output).padStart(6)}out  $${(ag.cost?.claude || 0).toFixed(6)}`);
    }

    // Print summaries
    console.log('\n--- Workflow Summary (first 300 chars) ---');
    console.log((wf.summary || wf.error || '(none)').substring(0, 300));
    console.log('\n--- Agent Summary (first 300 chars) ---');
    console.log((ag.summary || ag.error || '(none)').substring(0, 300));

    if (wf.error) console.log(`\nWorkflow ERROR: ${wf.error}`);
    if (ag.error) console.log(`\nAgent ERROR: ${ag.error}`);

    console.log('\n');

    allResults.push({ query: q, wf, ag });
  }

  if (shouldSave && allResults.length > 0) {
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const agModel = allResults[0].ag.engine || 'agent';
    const filename = `comparison-${ts}.md`;
    const filepath = path.join(outputDir, filename);

    let md = `# Agent vs Workflow Comparison\n\n`;
    md += `**Date:** ${new Date().toISOString()}\n`;
    md += `**Agent model:** ${agModel}\n\n`;

    for (const { query, wf, ag } of allResults) {
      md += `---\n\n## ${query.name}\n\n`;
      md += `**Query:** "${query.task}"\n\n`;

      md += `| Metric | Workflow | Agent |\n|--------|---------|-------|\n`;
      md += `| Latency | ${wf.latencyMs || '?'}ms | ${ag.latencyMs || '?'}ms |\n`;
      md += `| Iterations/Rounds | ${wf.iterationsUsed || '?'} | ${ag.rounds || '?'} |\n`;
      md += `| Summary length | ${(wf.summary || '').length} chars | ${ag.fullSummaryLength || 0} chars |\n`;
      md += `| {{clip:}} tokens | ${wf.hasClipTokens ? 'Yes' : 'No'} | ${ag.hasClipTokens ? 'Yes' : 'No'} |\n`;
      md += `| LLM cost | $${(wf.llmCosts?.totalEstimatedCost || 0).toFixed(5)} | $${(ag.cost?.claude || 0).toFixed(5)} |\n`;
      md += `| Total cost | $${(wf.llmCosts?.totalEstimatedCost || 0).toFixed(5)} | $${(ag.cost?.total || 0).toFixed(5)} |\n`;
      md += `| Tool order | ${(wf.toolOrder || []).join(' → ') || '(none)'} | ${(ag.toolOrder || []).join(' → ') || '(none)'} |\n\n`;

      if (wf.llmCosts?.calls?.length) {
        md += `### Workflow LLM Breakdown\n\n`;
        md += `| Role | Model | Input | Output | Cost |\n|------|-------|-------|--------|------|\n`;
        for (const c of wf.llmCosts.calls) {
          md += `| ${c.role} | ${c.model} | ${c.inputTokens} | ${c.outputTokens} | $${c.estimatedCost.toFixed(6)} |\n`;
        }
        md += `| **TOTAL** | | | | **$${wf.llmCosts.totalEstimatedCost.toFixed(6)}** |\n\n`;
      }

      md += `### Workflow Summary\n\n${wf.summary || wf.error || '(none)'}\n\n`;
      md += `### Agent Summary\n\n${ag.summary || ag.error || '(none)'}\n\n`;
    }

    // Append aggregate statistics
    md += `---\n\n## Aggregate Statistics\n\n`;

    const wfCosts = allResults.map(r => r.wf.llmCosts?.totalEstimatedCost).filter(c => c != null && c > 0);
    const agCosts = allResults.map(r => r.ag.cost?.total).filter(c => c != null && c > 0);
    const wfLatencies = allResults.map(r => r.wf.latencyMs).filter(Boolean);
    const agLatencies = allResults.map(r => r.ag.latencyMs).filter(Boolean);

    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const stddev = arr => {
      if (arr.length < 2) return 0;
      const m = avg(arr);
      return Math.sqrt(arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / (arr.length - 1));
    };
    const min = arr => arr.length ? Math.min(...arr) : 0;
    const max = arr => arr.length ? Math.max(...arr) : 0;

    md += `### Cost Analysis (n=${allResults.length} queries)\n\n`;
    md += `| Metric | Workflow | Agent |\n|--------|---------|-------|\n`;
    md += `| Queries with cost data | ${wfCosts.length} | ${agCosts.length} |\n`;
    md += `| Mean cost | $${avg(wfCosts).toFixed(5)} | $${avg(agCosts).toFixed(5)} |\n`;
    md += `| Std deviation | $${stddev(wfCosts).toFixed(5)} | $${stddev(agCosts).toFixed(5)} |\n`;
    md += `| Min cost | $${min(wfCosts).toFixed(5)} | $${min(agCosts).toFixed(5)} |\n`;
    md += `| Max cost | $${max(wfCosts).toFixed(5)} | $${max(agCosts).toFixed(5)} |\n`;
    md += `| Total spend | $${wfCosts.reduce((a, b) => a + b, 0).toFixed(5)} | $${agCosts.reduce((a, b) => a + b, 0).toFixed(5)} |\n\n`;

    md += `### Latency Analysis\n\n`;
    md += `| Metric | Workflow | Agent |\n|--------|---------|-------|\n`;
    md += `| Mean latency | ${avg(wfLatencies).toFixed(0)}ms | ${avg(agLatencies).toFixed(0)}ms |\n`;
    md += `| Std deviation | ${stddev(wfLatencies).toFixed(0)}ms | ${stddev(agLatencies).toFixed(0)}ms |\n`;
    md += `| Min latency | ${min(wfLatencies)}ms | ${min(agLatencies)}ms |\n`;
    md += `| Max latency | ${max(wfLatencies)}ms | ${max(agLatencies)}ms |\n\n`;

    md += `### Quality Summary\n\n`;
    const wfClipTokens = allResults.filter(r => r.wf.hasClipTokens).length;
    const agClipTokens = allResults.filter(r => r.ag.hasClipTokens).length;
    const wfHasSummary = allResults.filter(r => (r.wf.summary || '').length > 50).length;
    const agHasSummary = allResults.filter(r => (r.ag.summary || '').length > 50).length;
    md += `| Metric | Workflow | Agent |\n|--------|---------|-------|\n`;
    md += `| Produced summary (>50 chars) | ${wfHasSummary}/${allResults.length} | ${agHasSummary}/${allResults.length} |\n`;
    md += `| Included {{clip:}} tokens | ${wfClipTokens}/${allResults.length} | ${agClipTokens}/${allResults.length} |\n`;

    fs.writeFileSync(filepath, md);
    console.log(`\x1b[32m✔ Full output saved to ${filepath}\x1b[0m\n`);
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
