#!/usr/bin/env node

/**
 * Multi-turn Agent Benchmark
 *
 * Simulates real conversations by sending chat history with each turn.
 * Compares compaction ON vs OFF across different conversation patterns.
 *
 * NOTE 2026-04-27: previously hit /api/chat/workflow, which was removed
 * (unauthenticated public mount). The agent is now reachable only via
 * POST /api/pull, gated by serviceHmac + L402/JWT/free-tier. This test
 * sends X-Free-Tier: true (when no JWT is set) so it works locally
 * without auth setup, and forces SSE via `stream: true` because
 * /api/pull defaults to JSON.
 *
 * Usage:
 *   node tests/agent-multiturn.js [--set N] [--compact-off]
 *
 *   --set N         Run only conversation set N (1-based)
 *   --compact-off   Disable compaction (sends compactResults:false, compactHistory:false)
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const JAMIE_URL = process.env.JAMIE_URL || 'http://localhost:4132';
const JWT = process.env.JWT_TEST_TOKEN || process.env.TEST_JWT || '';

const CONVERSATION_SETS = [
  {
    name: 'Deep Dive (related follow-ups)',
    description: 'User digs deeper into a single person across turns',
    turns: [
      'Who is Luke Gromen and what does he talk about?',
      'What specifically has he said about the debt spiral and AI?',
      'Find his most quotable line about gold or the dollar',
      'How does his view compare to Lyn Alden on the same topic?',
    ],
  },
  {
    name: 'Topic Pivot (completely new angle mid-convo)',
    description: 'User starts on one topic then switches to something unrelated',
    turns: [
      'Find quotes about Lightning Network privacy',
      'What about the tradeoffs of custodial vs self-custodial wallets?',
      'Totally different question — what has Joe Rogan said about psychedelics?',
      'Find the best Paul Stamets clip from that conversation',
    ],
  },
  {
    name: 'Show Explorer (browsing a single feed)',
    description: 'User explores one podcast across turns',
    turns: [
      'What topics has TFTC covered recently?',
      'Tell me about their episode with Will Cole',
      'What about their coverage of mining?',
    ],
  },
  {
    name: 'Person + Upsell (cross-show, triggers discover)',
    description: 'User asks about a person on a show that may not be transcribed',
    turns: [
      'Roland from Alby',
      'Has he appeared on any other podcasts?',
      'What about Alby Hub specifically — find the best technical explanation',
    ],
  },
];

function parseSSE(raw) {
  const events = [];
  const lines = raw.split('\n');
  let currentEvent = null;

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      if (currentEvent) {
        try {
          events.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
        } catch {
          events.push({ event: currentEvent, data: line.slice(6) });
        }
      }
      currentEvent = null;
    }
  }
  return events;
}

async function runTurn(message, history, { compactOff }) {
  const start = Date.now();
  const agentModel = 'quality';

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
  if (JWT) headers['Authorization'] = `Bearer ${JWT}`;
  else headers['X-Free-Tier'] = 'true';

  const body = {
    message,
    model: agentModel,
    history,
    stream: true,
  };

  if (compactOff) {
    body.compactResults = false;
    body.compactHistory = false;
  }

  const resp = await fetch(`${JAMIE_URL}/api/pull`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const raw = await resp.text();
  const latencyMs = Date.now() - start;
  const events = parseSSE(raw);

  const textDoneEvent = events.find(e => e.event === 'text_done');
  const textDeltaEvents = events.filter(e => e.event === 'text_delta');
  const toolCallEvents = events.filter(e => e.event === 'tool_call');
  const doneEvent = events.find(e => e.event === 'done');

  const fullText = textDoneEvent?.data?.text || textDeltaEvents.map(e => e.data?.text || '').join('');

  return {
    latencyMs,
    text: fullText,
    textLength: fullText.length,
    hasClips: fullText.includes('{{clip:'),
    tools: toolCallEvents.map(e => e.data.tool),
    rounds: doneEvent?.data?.rounds || 0,
    cost: doneEvent?.data?.cost || {},
    tokens: doneEvent?.data?.tokens || {},
    model: doneEvent?.data?.model || agentModel,
  };
}

async function runConversation(convo, { compactOff }) {
  const label = compactOff ? 'OFF' : 'ON';
  console.log(`\n  Running with compaction ${label}...`);

  const history = [];
  const turnResults = [];

  for (let i = 0; i < convo.turns.length; i++) {
    const msg = convo.turns[i];
    process.stdout.write(`    Turn ${i + 1}/${convo.turns.length}: "${msg.substring(0, 60)}${msg.length > 60 ? '...' : ''}" `);

    const result = await runTurn(msg, history, { compactOff });
    turnResults.push(result);

    // Build history for next turn (mimics frontend behavior)
    history.push({ role: 'user', content: msg });
    history.push({ role: 'assistant', content: result.text });

    console.log(`→ ${result.rounds}r, ${result.tokens.input}in/${result.tokens.output}out, $${(result.cost.total || 0).toFixed(4)}, ${result.latencyMs}ms`);
  }

  const totalCost = turnResults.reduce((s, r) => s + (r.cost.total || 0), 0);
  const totalInput = turnResults.reduce((s, r) => s + (r.tokens.input || 0), 0);
  const totalOutput = turnResults.reduce((s, r) => s + (r.tokens.output || 0), 0);
  const totalLatency = turnResults.reduce((s, r) => s + r.latencyMs, 0);

  return { turnResults, totalCost, totalInput, totalOutput, totalLatency };
}

async function main() {
  const args = process.argv.slice(2);
  const setIndex = args.includes('--set')
    ? parseInt(args[args.indexOf('--set') + 1], 10) - 1
    : null;
  const compactOff = args.includes('--compact-off');

  const convos = setIndex !== null ? [CONVERSATION_SETS[setIndex]] : CONVERSATION_SETS;

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║          Multi-Turn Agent Benchmark                     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Mode: ${compactOff ? 'compaction OFF' : 'compaction ON (default)'}`);
  console.log(`  Conversations: ${convos.length}`);
  console.log();

  const allResults = [];

  for (const convo of convos) {
    console.log(`━━━ ${convo.name} ━━━`);
    console.log(`  ${convo.description}`);

    const result = await runConversation(convo, { compactOff });
    allResults.push({ convo, result });

    console.log(`\n  TOTALS: $${result.totalCost.toFixed(4)} | ${result.totalInput}in/${result.totalOutput}out | ${result.totalLatency}ms`);

    // Per-turn summary table
    console.log('\n  ┌──────┬───────────┬───────────┬──────────┬────────┬─────────┐');
    console.log('  │ Turn │ Input tok │ Output tk │ Cost     │ Rounds │ Clips   │');
    console.log('  ├──────┼───────────┼───────────┼──────────┼────────┼─────────┤');
    for (let i = 0; i < result.turnResults.length; i++) {
      const t = result.turnResults[i];
      console.log(`  │ ${pad(i + 1, 4)} │ ${pad(t.tokens.input || 0, 9)} │ ${pad(t.tokens.output || 0, 9)} │ $${pad((t.cost.total || 0).toFixed(4), 7)} │ ${pad(t.rounds, 6)} │ ${pad(t.hasClips ? 'Yes' : 'No', 7)} │`);
    }
    console.log('  └──────┴───────────┴───────────┴──────────┴────────┴─────────┘');

    // Show quality excerpts for each turn
    console.log('\n  Quality excerpts:');
    for (let i = 0; i < result.turnResults.length; i++) {
      const t = result.turnResults[i];
      const preview = t.text.substring(0, 150).replace(/\n/g, ' ');
      console.log(`    T${i + 1} (${t.textLength} chars): ${preview}...`);
    }
    console.log();
  }

  // Grand summary
  if (allResults.length > 1) {
    console.log('═══ GRAND SUMMARY ═══');
    const grandCost = allResults.reduce((s, r) => s + r.result.totalCost, 0);
    const grandInput = allResults.reduce((s, r) => s + r.result.totalInput, 0);
    const grandTurns = allResults.reduce((s, r) => s + r.convo.turns.length, 0);
    console.log(`  Total queries: ${grandTurns}`);
    console.log(`  Total cost: $${grandCost.toFixed(4)}`);
    console.log(`  Avg cost/turn: $${(grandCost / grandTurns).toFixed(4)}`);
    console.log(`  Total input tokens: ${grandInput}`);
    console.log(`  Avg input tokens/turn: ${Math.round(grandInput / grandTurns)}`);
    console.log();
  }
}

function pad(val, len) {
  const s = String(val);
  return s.length > len ? s.substring(0, len - 1) + '…' : s.padEnd(len);
}

main().catch(err => {
  console.error('Multi-turn test failed:', err);
  process.exit(1);
});
