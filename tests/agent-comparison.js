#!/usr/bin/env node

/**
 * Agent Benchmark Test
 *
 * Sends queries to the Claude agent at POST /api/chat/workflow and
 * measures quality, tool ordering, cost, and latency.
 *
 * Prerequisites:
 *   - Jamie API running on :4132 (nodemon server.js)
 *   - No separate gateway needed (inlined)
 *
 * Usage:
 *   node tests/agent-comparison.js [--query N] [--cohort cohortN] [--save] ["custom query 1" ...]
 *
 * --save           writes full output to tests/output/<timestamp>.md (gitignored)
 * --cohort cohortN only run queries from the specified cohort (cohort1, cohort2, cohort3)
 * --query N        run a single query by 1-based index
 * Positional args (quoted strings) override the built-in TEST_QUERIES list
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const JAMIE_URL = process.env.JAMIE_URL || 'http://localhost:4132';
const JWT = process.env.JWT_TEST_TOKEN || process.env.TEST_JWT || '';

const TEST_QUERIES = [
  // --- Cohort 1: Original core scenarios ---
  { name: 'Person Dossier',     cohort: 'cohort1', task: "find Luke Gromen's last 5 appearances and give me a high level overview" },
  { name: 'Topic Research',     cohort: 'cohort1', task: 'find me key quotes on the privacy properties of the Lightning Network' },
  { name: 'Current Events',     cohort: 'cohort1', task: 'What are podcasters saying about AI regulation this month' },
  { name: 'Precise Search',     cohort: 'cohort1', task: 'Find Joe Rogan talking about stoned ape theory' },
  { name: 'Expert Insights',    cohort: 'cohort1', task: 'Find Roger Penrose talking in depth about the physics of black holes' },
  { name: 'Expert Insights #2', cohort: 'cohort1', task: 'Find a history expert talking about Russia in the Soviet era' },

  // --- Cohort 2: Cross-genre diversity ---
  { name: 'Finance Deep Dive',       cohort: 'cohort2', task: 'What is the bull case for gold right now? Find specific arguments from macro analysts.' },
  { name: 'True Crime',              cohort: 'cohort2', task: 'Find the most chilling story covered on Casefile or Darknet Diaries about social engineering' },
  { name: 'Health & Science',        cohort: 'cohort2', task: 'What has Andrew Huberman said about the effects of cold exposure on the immune system?' },
  { name: 'Geopolitics',             cohort: 'cohort2', task: 'Find discussions about the BRICS alliance challenging dollar hegemony' },
  { name: 'Tech / AI',               cohort: 'cohort2', task: 'What are the best arguments for and against open source AI models?' },
  { name: 'Host as Subject',         cohort: 'cohort2', task: "What is Scott Galloway's take on big tech monopolies?" },
  { name: 'Niche Bitcoin',           cohort: 'cohort2', task: 'Explain the tradeoffs of coinjoin vs payjoin for Bitcoin privacy' },
  { name: 'Historical',              cohort: 'cohort2', task: 'Find Dan Carlin or a similar host talking about the fall of the Roman Republic' },
  { name: 'Philosophy',              cohort: 'cohort2', task: 'What do podcast philosophers say about whether free will is an illusion?' },
  { name: 'Cross-Show Comparison',   cohort: 'cohort2', task: 'Compare what Breaking Points and All-In have said about tariffs this year' },
  { name: 'Specific Episode Recall', cohort: 'cohort2', task: 'Find the Lex Fridman episode with a guest talking about consciousness and quantum mechanics' },
  { name: 'Obscure Topic',           cohort: 'cohort2', task: 'Has anyone on EconTalk or Conversations with Tyler discussed the economics of space colonization?' },

  // --- Cohort 3: Edge cases, multi-step, and broader feed coverage ---
  { name: 'Comedian Deep Cut',       cohort: 'cohort3', task: 'Find the funniest story a comedian has told on Kill Tony or Flagrant' },
  { name: 'Founder Interview',       cohort: 'cohort3', task: "What did the Anduril founder say about defense tech on Lex Fridman's show?" },
  { name: 'Diet Wars',               cohort: 'cohort3', task: 'What do podcasters say about carnivore vs vegan diets? Find the strongest arguments on each side.' },
  { name: 'Narrative History',        cohort: 'cohort3', task: 'Find a detailed retelling of the Cuban Missile Crisis from a history podcast' },
  { name: 'Investor Thesis',         cohort: 'cohort3', task: "What is Chamath Palihapitiya's current investment thesis? Find his own words." },
  { name: 'Music & Culture',         cohort: 'cohort3', task: 'Has anyone discussed the cultural impact of hip hop on American politics?' },
  { name: 'Multi-Guest Debate',      cohort: 'cohort3', task: 'Find a podcast episode where multiple guests debated immigration policy' },
  { name: 'Science Explainer',       cohort: 'cohort3', task: 'Find someone explaining CRISPR gene editing in plain language on a science podcast' },
  { name: 'Contrarian Take',         cohort: 'cohort3', task: 'Find the most controversial or contrarian opinion expressed on the All-In podcast this year' },
  { name: 'Sports Analytics',        cohort: 'cohort3', task: 'Has anyone discussed how data analytics is changing basketball strategy?' },
  { name: 'Book Deep Dive',          cohort: 'cohort3', task: 'Find in-depth discussion of "The Changing World Order" by Ray Dalio across podcasts' },
  { name: 'Whistleblower',           cohort: 'cohort3', task: 'Find podcast coverage of the David Grusch UFO whistleblower testimony' },
  {name: 'Specific Point from Memory',            cohort: 'cohort3', task: 'mike rowe talking about how the human brain corrects for safety measures like helmets and takes more risk under those conditions'},

  // --- Cohort 4: Prompt/execution flaw regressions ---
  { name: 'Entity Resolution (Company)',    cohort: 'cohort4', task: 'what are people saying about zaprite' },
  { name: 'Entity Resolution (Org)',        cohort: 'cohort4', task: 'what has the IMF said about bitcoin on podcasts' },
  { name: 'Sensitive/Provocative Topic',    cohort: 'cohort4', task: 'fraud from Somalians and Armenians' },
  { name: 'No Clarifying Questions',        cohort: 'cohort4', task: 'cutting weight' },
  { name: 'Thin Results Escalation',        cohort: 'cohort4', task: 'what has anyone said about nostr on podcasts' },
  { name: 'Multi-Person Company Query',     cohort: 'cohort4', task: 'what have people from Strike said about Lightning adoption' },
  { name: 'Budget Panic Prevention',        cohort: 'cohort4', task: 'What have PayPal mafia members like Peter Thiel and David Sacks said about startups on podcasts?' },
  { name: 'find_person Fallback',           cohort: 'cohort4', task: 'Roland from Alby talking about self custody' },
  { name: 'Never Dead-End',                 cohort: 'cohort4', task: 'what did Satoshi Nakamoto say on Joe Rogan' },
  { name: 'Research Session Quality',       cohort: 'cohort4', task: 'Make me a research session about Huberman on hormones and weight loss', mode: 'fast' },
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

async function runAgentQuery(task, mode) {
  const start = Date.now();

  const agentModel = mode || process.env.AGENT_MODEL || 'fast';

  const headers = { 'Content-Type': 'application/json' };
  if (JWT) headers['Authorization'] = `Bearer ${JWT}`;

  const resp = await fetch(`${JAMIE_URL}/api/chat/workflow`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: task, model: agentModel }),
  });

  const raw = await resp.text();
  const latencyMs = Date.now() - start;
  const events = parseSSE(raw);

  const textDoneEvent = events.find(e => e.event === 'text_done');
  const textDeltaEvents = events.filter(e => e.event === 'text_delta');
  const toolCallEvents = events.filter(e => e.event === 'tool_call');
  const toolResultEvents = events.filter(e => e.event === 'tool_result');
  const doneEvent = events.find(e => e.event === 'done');

  const fullText = textDoneEvent?.data?.text || textDeltaEvents.map(e => e.data?.text || '').join('');
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
  const args = process.argv.slice(2);
  const shouldSave = args.includes('--save');

  const cohortFilter = args.includes('--cohort')
    ? args[args.indexOf('--cohort') + 1]
    : null;

  const queryIndex = args.includes('--query')
    ? parseInt(args[args.indexOf('--query') + 1], 10) - 1
    : null;

  const flagArgs = new Set(['--query', '--cohort']);
  const positionalQueries = args.filter(a => !a.startsWith('--') && !flagArgs.has(args[args.indexOf(a) - 1]));
  
  let queries;
  if (positionalQueries.length > 0) {
    queries = positionalQueries.map((q, i) => ({ name: `Custom #${i + 1}`, cohort: 'custom', task: q }));
  } else if (queryIndex !== null && queryIndex >= 0 && queryIndex < TEST_QUERIES.length) {
    queries = [TEST_QUERIES[queryIndex]];
  } else if (cohortFilter) {
    queries = TEST_QUERIES.filter(q => q.cohort === cohortFilter);
    if (queries.length === 0) {
      const cohorts = [...new Set(TEST_QUERIES.map(q => q.cohort))];
      console.error(`No queries in cohort "${cohortFilter}". Available: ${cohorts.join(', ')}`);
      process.exit(1);
    }
  } else {
    queries = TEST_QUERIES;
  }

  const allResults = [];

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║              Jamie Agent Benchmark Test                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  JWT: ${JWT ? JWT.substring(0, 20) + '...' : '\x1b[33mNOT SET\x1b[0m'}`);
  if (cohortFilter) console.log(`  Cohort: \x1b[33m${cohortFilter}\x1b[0m (${queries.length} queries)`);
  if (shouldSave) console.log('  Saving full output to tests/output/');
  console.log();

  for (const q of queries) {
    console.log(`━━━ ${q.name} ━━━`);
    console.log(`Query: "${q.task}"\n`);

    const ag = await runAgentQuery(q.task, q.mode).catch(err => ({ engine: 'agent', error: err.message }));

    const agentLabel = ag.engine || 'Agent';
    const agLlmCost = ag.cost?.claude;
    const agToolCost = ag.cost?.tools;
    const agLlmDetail = ag.tokens?.input ? `${ag.tokens.input}in/${ag.tokens.output}out` : '?';

    console.log('┌─────────────────────┬────────────────────────────┐');
    console.log(`│ Metric              │ ${pad(agentLabel, 26)} │`);
    console.log('├─────────────────────┼────────────────────────────┤');

    const rows = [
      ['Latency', `${ag.latencyMs || '?'}ms`],
      ['Tool order', truncate((ag.toolOrder || []).join(' → '), 26)],
      ['Rounds', `${ag.rounds || '?'}`],
      ['Summary length', `${ag.fullSummaryLength || (ag.summary || '').length} chars`],
      ['{{clip:}} tokens', ag.hasClipTokens ? 'Yes' : 'No'],
      ['LLM cost', agLlmCost != null ? `$${agLlmCost.toFixed(5)}` : '?'],
      ['Tool cost', agToolCost != null ? `$${agToolCost.toFixed(4)}` : '?'],
      ['Total cost', ag.cost?.total != null ? `$${ag.cost.total.toFixed(5)}` : '?'],
      ['Tokens', agLlmDetail],
    ];

    for (const [label, val] of rows) {
      console.log(`│ ${pad(label, 19)} │ ${pad(val, 26)} │`);
    }

    console.log('└─────────────────────┴────────────────────────────┘');

    if (ag.tokens?.input) {
      const agModelName = ag.engine?.replace('agent (', '').replace(')', '') || 'claude';
      console.log(`\n  LLM: ${agModelName} — ${ag.tokens.input}in/${ag.tokens.output}out — $${(ag.cost?.claude || 0).toFixed(6)}`);
    }

    console.log('\n--- Summary (first 300 chars) ---');
    console.log((ag.summary || ag.error || '(none)').substring(0, 300));

    if (ag.error) console.log(`\nERROR: ${ag.error}`);

    console.log('\n');

    allResults.push({ query: q, ag });
  }

  if (shouldSave && allResults.length > 0) {
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const agModel = allResults[0].ag.engine || 'agent';
    const filename = `comparison-${ts}.md`;
    const filepath = path.join(outputDir, filename);

    let md = `# Agent Benchmark\n\n`;
    md += `**Date:** ${new Date().toISOString()}\n`;
    md += `**Agent model:** ${agModel}\n`;
    md += `**Endpoint:** POST /api/chat/workflow\n\n`;

    for (const { query, ag } of allResults) {
      md += `---\n\n## ${query.name}${query.cohort ? ` [${query.cohort}]` : ''}\n\n`;
      md += `**Query:** "${query.task}"\n\n`;

      md += `| Metric | Value |\n|--------|-------|\n`;
      md += `| Latency | ${ag.latencyMs || '?'}ms |\n`;
      md += `| Rounds | ${ag.rounds || '?'} |\n`;
      md += `| Summary length | ${ag.fullSummaryLength || 0} chars |\n`;
      md += `| {{clip:}} tokens | ${ag.hasClipTokens ? 'Yes' : 'No'} |\n`;
      md += `| LLM cost | $${(ag.cost?.claude || 0).toFixed(5)} |\n`;
      md += `| Tool cost | $${(ag.cost?.tools || 0).toFixed(4)} |\n`;
      md += `| Total cost | $${(ag.cost?.total || 0).toFixed(5)} |\n`;
      md += `| Tokens | ${ag.tokens?.input || '?'}in / ${ag.tokens?.output || '?'}out |\n`;
      md += `| Tool order | ${(ag.toolOrder || []).join(' → ') || '(none)'} |\n\n`;

      md += `### Summary\n\n${ag.summary || ag.error || '(none)'}\n\n`;
    }

    md += `---\n\n## Aggregate Statistics\n\n`;

    const agCosts = allResults.map(r => r.ag.cost?.total).filter(c => c != null && c > 0);
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
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Queries with cost data | ${agCosts.length} |\n`;
    md += `| Mean cost | $${avg(agCosts).toFixed(5)} |\n`;
    md += `| Std deviation | $${stddev(agCosts).toFixed(5)} |\n`;
    md += `| Min cost | $${min(agCosts).toFixed(5)} |\n`;
    md += `| Max cost | $${max(agCosts).toFixed(5)} |\n`;
    md += `| Total spend | $${agCosts.reduce((a, b) => a + b, 0).toFixed(5)} |\n\n`;

    md += `### Latency Analysis\n\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Mean latency | ${avg(agLatencies).toFixed(0)}ms |\n`;
    md += `| Std deviation | ${stddev(agLatencies).toFixed(0)}ms |\n`;
    md += `| Min latency | ${min(agLatencies)}ms |\n`;
    md += `| Max latency | ${max(agLatencies)}ms |\n\n`;

    md += `### Quality Summary\n\n`;
    const agClipTokens = allResults.filter(r => r.ag.hasClipTokens).length;
    const agHasSummary = allResults.filter(r => (r.ag.summary || '').length > 50).length;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Produced summary (>50 chars) | ${agHasSummary}/${allResults.length} |\n`;
    md += `| Included {{clip:}} tokens | ${agClipTokens}/${allResults.length} |\n`;

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

main().catch(err => {
  console.error('Comparison test failed:', err);
  process.exit(1);
});
