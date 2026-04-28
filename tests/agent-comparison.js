#!/usr/bin/env node

/**
 * Agent Benchmark Test
 *
 * Sends queries to the Claude agent at POST /api/pull and measures
 * quality, tool ordering, cost, and latency.
 *
 * NOTE 2026-04-27: previously hit /api/chat/workflow, which was removed
 * (unauthenticated public mount). /api/pull is the sole public entry
 * point now and is gated by serviceHmac + L402/JWT/free-tier. This
 * benchmark sends X-Free-Tier: true so it works against a local server
 * with no auth setup. We also send `stream: true` in the body because
 * /api/pull defaults to a single JSON response — the parseSSE pipeline
 * below assumes SSE.
 *
 * Prerequisites:
 *   - Jamie API running on :4132 (nodemon server.js)
 *   - No separate gateway needed (inlined)
 *
 * Usage:
 *   node tests/agent-comparison.js [--query N] [--queries N,M,P] [--cohort cohortN] [--save] [--provider anthropic|tinfoil|all] [--model key] [--models key1,key2] [--profile default|deep-turns] ["custom query 1" ...]
 *   node tests/cohort-stats-report.js   # aggregate tables: newest log per TEST_QUERIES task, all cohorts
 *
 * --save           writes full output to tests/output/<timestamp>.md (gitignored)
 * --cohort cohortN only run queries from the specified cohort (cohort1–cohort8)
 * --query N        run a single query by 1-based index
 * --queries N,M,P  run a specific subset of queries by 1-based indices
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

  // --- Cohort 4: Host detection / split search strategy ---
  { name: 'Host: Marty Bent on AI',          cohort: 'cohort4', task: 'What did Marty Bent say about AI?' },
  { name: 'Host: Rogan on Mushrooms',        cohort: 'cohort4', task: 'What has Joe Rogan said about psychedelics on his own show?' },
  { name: 'Host+Guest Split',                cohort: 'cohort4', task: 'What has Lex Fridman said about consciousness?' },
  { name: 'Panel Show Host',                 cohort: 'cohort4', task: 'What have Matt Odell and Marty Bent discussed about privacy on Rabbit Hole Recap?' },
  { name: 'Host by Last Name Only',          cohort: 'cohort4', task: 'What did McCormack say about the UK economy?' },
  { name: 'Host Scoped to Feed',             cohort: 'cohort4', task: 'Find Peter McCormack discussing El Salvador on What Bitcoin Did' },
  { name: 'Guest Not Host',                  cohort: 'cohort4', task: 'What did Michael Saylor say on TFTC?' },
  { name: 'Multi-Feed Host',                 cohort: 'cohort4', task: 'What has Marty Bent said about mining across all his shows?' },

  // --- Cohort 5: Prompt/execution flaw regressions ---
  { name: 'Entity Resolution (Company)',    cohort: 'cohort5', task: 'what are people saying about zaprite' },
  { name: 'Entity Resolution (Org)',        cohort: 'cohort5', task: 'what has the IMF said about bitcoin on podcasts' },
  { name: 'Sensitive/Provocative Topic',    cohort: 'cohort5', task: 'fraud from Somalians and Armenians' },
  { name: 'No Clarifying Questions',        cohort: 'cohort5', task: 'cutting weight' },
  { name: 'Thin Results Escalation',        cohort: 'cohort5', task: 'what has anyone said about nostr on podcasts' },
  { name: 'Multi-Person Company Query',     cohort: 'cohort5', task: 'what have people from Strike said about Lightning adoption' },
  { name: 'Budget Panic Prevention',        cohort: 'cohort5', task: 'What have PayPal mafia members like Peter Thiel and David Sacks said about startups on podcasts?' },
  { name: 'find_person Fallback',           cohort: 'cohort5', task: 'Roland from Alby talking about self custody' },
  { name: 'Never Dead-End',                 cohort: 'cohort5', task: 'what did Satoshi Nakamoto say on Joe Rogan' },
  { name: 'Research Session Quality',       cohort: 'cohort5', task: 'Make me a research session about Huberman on hormones and weight loss', mode: 'fast' },

  // --- Cohort 6: Proper-noun adversarial / LLM expansion validation ---
  // Validates PROPER_NOUN_LLM_EXPANSION_ENABLED. First two are ASR-phonetic-mismatch
  // targets (lncurl.lol → "ellen curl"). Last three are control queries that should
  // NOT regress when expansion is on (zaprite, nostr) and a numeric-suffix coined
  // term where the gate currently does NOT fire (x402 — flagged in WIP.md F2).
  { name: 'Proper-noun: lncurl.lol',         cohort: 'cohort6', task: 'what is lncurl.lol and what is it used for?' },
  { name: 'Proper-noun: ellen curl homophone', cohort: 'cohort6', task: 'tell me about ellen curl' },
  { name: 'Proper-noun: x402 (numeric)',     cohort: 'cohort6', task: 'what is x402 used for?' },
  { name: 'Proper-noun: zaprite control',    cohort: 'cohort6', task: 'what has been said about zaprite' },
  { name: 'Proper-noun: nostr control',      cohort: 'cohort6', task: 'what about nostr on podcasts' },

  // --- Cohort 7: Latency / synthesis-budget stress regressions ---
  // Empires query observed 2026-04-28: 5 rounds of get_adjacent_paragraphs
  // (windowSize 8/10/12/8) burned the 40s budget; synthesis ran on 15s and
  // truncated mid-sentence at "...spending balloons during an". Validates
  // the time-budget header (always-on per-round) + adaptive synthesis
  // length guidance (short/lean answer when remaining budget is tight).
  // Add new latency-stress cases here as they're discovered in the wild.
  { name: 'Empires Patterns (synth-budget stress)', cohort: 'cohort7', task: 'What patterns repeat in the fall of great empires across history?' },

  // --- Cohort 8: Stress on prior weak spots (cross-show, VC/macro, long narrative,
  // impossible guest-host, broad synthesis, thin corpus, research session) ---
  { name: 'C8 Cross: Pool vs Shapiro immigration', cohort: 'cohort8', task: 'Compare what Tim Pool and Ben Shapiro have said about immigration policy in the last year on their shows.' },
  { name: 'C8 Cross: DW vs All-In China', cohort: 'cohort8', task: 'Compare DW News and All-In on China tech decoupling and supply chains.' },
  { name: 'C8 Cross: Pivot vs Prof G layoffs', cohort: 'cohort8', task: 'Compare Pivot and Prof G on tech layoffs, hiring, and the job market for engineers.' },
  { name: 'C8 Cross: Lex vs Huberman dopamine', cohort: 'cohort8', task: 'Compare Lex Fridman and Andrew Huberman on dopamine, motivation, and digital distraction.' },
  { name: 'C8 Cross: Rogan vs Lex UFOs', cohort: 'cohort8', task: 'Compare Joe Rogan and Lex Fridman on UFO disclosure, whistleblowers, and government transparency.' },
  { name: 'C8 Cross: WBD vs TFTC Lightning', cohort: 'cohort8', task: 'Compare What Bitcoin Did and TFTC on Lightning routing reliability and failures.' },
  { name: 'C8 Cross: Today Explained vs Daily SCOTUS', cohort: 'cohort8', task: 'Compare Today Explained and The Daily on the Supreme Court term and major cases.' },
  { name: 'C8 Cross: Hard Fork vs Pivot Meta', cohort: 'cohort8', task: 'Compare Hard Fork and Pivot on Meta, social media, and antitrust.' },
  { name: 'C8 VC: Sacks JCal AI regulation', cohort: 'cohort8', task: 'What have David Sacks and Jason Calacanis said about AI regulation across All-In episodes?' },
  { name: 'C8 VC: Founders Fund defense tech', cohort: 'cohort8', task: 'What have Founders Fund–affiliated voices said about defense tech, drones, and Anduril on podcasts?' },
  { name: 'C8 VC: Thiel vs a16z elites', cohort: 'cohort8', task: 'Contrast Peter Thiel and Marc Andreessen on democracy, elites, and technocracy using podcast clips.' },
  { name: 'C8 VC: YC valuations 2025–26', cohort: 'cohort8', task: 'What are Y Combinator partners saying about startup valuations in 2025 and 2026 on podcasts?' },

  { name: 'C8 Narrative: 2008 crisis weekend', cohort: 'cohort8', task: 'Find a detailed narrative of the 2008 financial crisis weekend (Lehman, AIG, Fed) from podcasts.' },
  { name: 'C8 Narrative: D-Day', cohort: 'cohort8', task: 'Find a detailed retelling of D-Day from history podcasts with specific moments and decisions.' },
  { name: 'C8 Narrative: Chernobyl', cohort: 'cohort8', task: 'Chernobyl meltdown explained in narrative depth: timeline, mistakes, and aftermath on podcasts.' },
  { name: 'C8 Narrative: Constantinople 1453', cohort: 'cohort8', task: 'Fall of Constantinople in 1453 — detailed expert narrative from history podcasts.' },
  { name: 'C8 Narrative: Prohibition', cohort: 'cohort8', task: 'Prohibition-era bootlegging and organized crime told as a long narrative on podcasts.' },
  { name: 'C8 Narrative: Tet Offensive', cohort: 'cohort8', task: 'Tet Offensive explained in depth: strategy, surprise, and media impact on history podcasts.' },
  { name: 'C8 Narrative: Spanish Civil War', cohort: 'cohort8', task: 'Spanish Civil War overview from expert podcasts: factions, foreign intervention, outcome.' },
  { name: 'C8 Narrative: Partition of India', cohort: 'cohort8', task: 'Partition of India in 1947 — detailed retelling from podcasts covering violence and migration.' },
  { name: 'C8 Narrative: Bronze Age collapse', cohort: 'cohort8', task: 'Bronze Age collapse theories and evidence across history podcasts.' },
  { name: 'C8 Narrative: Peloponnesian War', cohort: 'cohort8', task: 'Peloponnesian War: causes, Pericles, Sicilian expedition — synthesis from history podcasts.' },

  { name: 'C8 Impossible: Musk on Acquired', cohort: 'cohort8', task: 'What did Elon Musk say on the Acquired podcast as a guest? Quote him.' },
  { name: 'C8 Impossible: Naval on All-In', cohort: 'cohort8', task: 'What did Naval Ravikant say on All-In this year? Pull his clips.' },
  { name: 'C8 Impossible: Swift on Rogan', cohort: 'cohort8', task: 'What did Taylor Swift say on Joe Rogan about her music and politics?' },
  { name: 'C8 Impossible: Satoshi on Bankless', cohort: 'cohort8', task: 'What did Satoshi Nakamoto say on Bankless about Ethereum?' },
  { name: 'C8 Impossible: Dimon on WBD', cohort: 'cohort8', task: 'What did Jamie Dimon say about Bitcoin on What Bitcoin Did with Peter McCormack?' },
  { name: 'C8 Impossible: Jobs on Lex AI', cohort: 'cohort8', task: 'What did Steve Jobs say on Lex Fridman about artificial intelligence?' },

  { name: 'C8 Synth: curiosity before decline', cohort: 'cohort8', task: 'Why do civilizations lose intellectual curiosity before decline? Synthesize arguments from history podcasts.' },
  { name: 'C8 Synth: nuclear war rational', cohort: 'cohort8', task: 'Is nuclear war ever rational? Summarize the strongest for and against from podcast debates.' },
  { name: 'C8 Synth: debt jubilee vs austerity', cohort: 'cohort8', task: 'Debt jubilees versus austerity across ancient and modern empires — what do podcast historians and economists argue?' },
  { name: 'C8 Synth: hyperinflation compare', cohort: 'cohort8', task: 'Compare hyperinflation in Venezuela, Zimbabwe, and Weimar Germany as explained on podcasts.' },
  { name: 'C8 Synth: coastal vs heartland', cohort: 'cohort8', task: 'Coastal elite versus heartland economy narratives across political and culture podcasts.' },
  { name: 'C8 Synth: AI replacing CEOs', cohort: 'cohort8', task: 'Predictions about AI replacing CEOs — synthesize across business and tech podcasts.' },
  { name: 'C8 Synth: UBI pro and con', cohort: 'cohort8', task: 'Universal basic income: strongest pro and strongest con from podcasters, with clips.' },
  { name: 'C8 Synth: Fed independence', cohort: 'cohort8', task: 'Federal Reserve independence versus political pressure — compare takes across macro and news podcasts.' },
  { name: 'C8 Synth: Ukraine peace 2025–26', cohort: 'cohort8', task: 'Ukraine war peace talks and endgame scenarios in 2025–2026 — what are podcasts saying?' },
  { name: 'C8 Synth: Ozempic society', cohort: 'cohort8', task: 'Ozempic and GLP-1 drugs — societal effects on health, beauty, and inequality across podcasts.' },
  { name: 'C8 Synth: remote work dead', cohort: 'cohort8', task: 'Remote work is dead versus here to stay — cross-show synthesis with named podcasts.' },
  { name: 'C8 Synth: EA after FTX', cohort: 'cohort8', task: 'Effective altruism after FTX — reckoning and reform arguments on podcasts.' },

  { name: 'C8 Thin: German Bitcoin pods', cohort: 'cohort8', task: 'Find German-language podcast episodes about Bitcoin in our corpus, if any.' },
  { name: 'C8 Thin: Antarctic economics', cohort: 'cohort8', task: 'Economics of Antarctic research stations — anything on EconTalk or similar?' },
  { name: 'C8 Thin: Faraday EMP', cohort: 'cohort8', task: 'Faraday cages and EMP preparedness — niche podcast coverage.' },
  { name: 'C8 Thin: curling strategy', cohort: 'cohort8', task: 'Deep dive on curling strategy and analytics on any podcast.' },
  { name: 'C8 Thin: marble racing', cohort: 'cohort8', task: 'Competitive marble racing commentary or fandom on podcasts.' },
  { name: 'C8 Thin: FDA reform', cohort: 'cohort8', task: 'Reforming the FDA and drug approval timelines — podcast arguments.' },
  { name: 'C8 Thin: quantum winter', cohort: 'cohort8', task: 'Quantum computing winter versus hype — podcast takes from physicists and VCs.' },
  { name: 'C8 Thin: college worth it', cohort: 'cohort8', task: 'Is college still worth it? Strongest podcast arguments on both sides.' },

  { name: 'C8 Research: carbon capture', cohort: 'cohort8', task: 'Make a research session about carbon capture and climate tech debates on podcasts.', mode: 'fast' },
  { name: 'C8 Research: consciousness quantum', cohort: 'cohort8', task: 'Make a research session on Lex Fridman guests discussing consciousness versus quantum mysticism.', mode: 'fast' },

  { name: 'C8 Stress: Levchin Hoffman AI', cohort: 'cohort8', task: 'What have Max Levchin and Reid Hoffman said about AI on podcasts?' },
  { name: 'C8 Stress: tariffs BP Tim Dillon', cohort: 'cohort8', task: 'Compare Breaking Points and Tim Dillon on tariffs and trade policy.' },
  { name: 'C8 Stress: NATO 1990s promises', cohort: 'cohort8', task: 'NATO expansion and 1990s verbal promises to Russia — podcast synthesis of competing narratives.' },
  { name: 'C8 Stress: Lightning jamming', cohort: 'cohort8', task: 'Lightning network jamming attacks and routing failures — what did major Bitcoin podcasts explain?' },
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

function parseCsv(input) {
  if (!input || typeof input !== 'string') return [];
  return input.split(',').map(s => s.trim()).filter(Boolean);
}

function defaultModelsForProvider(provider) {
  if (provider === 'anthropic') return ['fast'];
  if (provider === 'tinfoil') return ['gemma'];
  if (provider === 'all') return ['fast', 'gemma'];
  return [];
}

async function runAgentQuery(task, { model, provider, executionProfile } = {}) {
  const start = Date.now();

  const agentModel = model || process.env.AGENT_MODEL || 'fast';

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
  if (JWT) headers['Authorization'] = `Bearer ${JWT}`;
  else headers['X-Free-Tier'] = 'true';

  const payload = { message: task, model: agentModel, includeMetrics: true, stream: true };
  if (provider) payload.provider = provider;
  if (executionProfile) payload.executionProfile = executionProfile;

  const resp = await fetch(`${JAMIE_URL}/api/pull`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const raw = await resp.text();
  const latencyMs = Date.now() - start;
  let parsedJson = null;
  try { parsedJson = JSON.parse(raw); } catch {}

  if (!resp.ok) {
    const msg = parsedJson?.error || parsedJson?.message || raw.substring(0, 200);
    throw new Error(`HTTP ${resp.status}: ${msg}`);
  }

  const events = parseSSE(raw);

  // Fallback for JSON mode or non-SSE responses.
  if (events.length === 0 && parsedJson && typeof parsedJson === 'object') {
    return {
      engine: `agent (${parsedJson?.metrics?.model || agentModel})`,
      modelKey: parsedJson?.metrics?.modelKey || agentModel,
      provider: parsedJson?.metrics?.provider || provider || 'unknown',
      executionProfile: parsedJson?.metrics?.executionProfile || executionProfile || 'default',
      latencyMs,
      summary: parsedJson?.text || '',
      fullSummaryLength: (parsedJson?.text || '').length,
      toolOrder: (parsedJson?.metrics?.toolCalls || []).map(tc => `${tc.name}(${tc.resultCount ?? '?'} results)`),
      rounds: parsedJson?.metrics?.rounds || 0,
      cost: parsedJson?.metrics?.cost || {},
      tokens: parsedJson?.metrics?.tokens || {},
      hasClipTokens: (parsedJson?.text || '').includes('{{clip:'),
      error: parsedJson?.error || null,
    };
  }

  const textDoneEvent = events.find(e => e.event === 'text_done');
  const textDeltaEvents = events.filter(e => e.event === 'text_delta');
  const toolCallEvents = events.filter(e => e.event === 'tool_call');
  const toolResultEvents = events.filter(e => e.event === 'tool_result');
  const doneEvent = events.find(e => e.event === 'done');
  const errorEvent = events.find(e => e.event === 'error');

  const fullText = textDoneEvent?.data?.text || textDeltaEvents.map(e => e.data?.text || '').join('');
  const modelLabel = doneEvent?.data?.model || agentModel;
  const modelKey = doneEvent?.data?.modelKey || agentModel;
  const providerLabel = doneEvent?.data?.provider || provider || 'unknown';
  const profile = doneEvent?.data?.executionProfile || executionProfile || 'default';
  const toolOrder = toolCallEvents.map(e => {
    const matchingResult = toolResultEvents.find(r => r.data?.tool === e.data?.tool && r.data?.round === e.data?.round);
    return `${e.data.tool}(${matchingResult?.data?.resultCount ?? '?'} results)`;
  });

  return {
    engine: `agent (${modelLabel})`,
    modelKey,
    provider: providerLabel,
    executionProfile: profile,
    latencyMs,
    summary: fullText,
    fullSummaryLength: fullText.length,
    toolOrder,
    rounds: doneEvent?.data?.rounds || 0,
    cost: doneEvent?.data?.cost || {},
    tokens: doneEvent?.data?.tokens || {},
    hasClipTokens: fullText.includes('{{clip:'),
    error: errorEvent?.data?.error || null,
  };
}

// ===== Main =====

async function main() {
  const args = process.argv.slice(2);
  const shouldSave = args.includes('--save');
  const getFlagValue = (flag) => {
    const idx = args.indexOf(flag);
    if (idx === -1) return null;
    return args[idx + 1] || null;
  };

  const cohortFilter = getFlagValue('--cohort');
  const providerFilter = getFlagValue('--provider');
  const modelFilter = getFlagValue('--model');
  const modelsFilter = parseCsv(getFlagValue('--models'));
  const executionProfile = getFlagValue('--profile');

  const queryIndexRaw = getFlagValue('--query');
  const queryIndex = queryIndexRaw ? parseInt(queryIndexRaw, 10) - 1 : null;
  const queriesFlagRaw = getFlagValue('--queries');
  const queriesIndices = queriesFlagRaw
    ? parseCsv(queriesFlagRaw)
        .map(s => parseInt(s, 10))
        .filter(n => Number.isInteger(n) && n >= 1 && n <= TEST_QUERIES.length)
        .map(n => n - 1)
    : [];

  const valueFlags = new Set(['--query', '--queries', '--cohort', '--provider', '--model', '--models', '--profile']);
  const positionalQueries = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--save') continue;
    if (valueFlags.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('--')) positionalQueries.push(arg);
  }
  
  let queries;
  if (positionalQueries.length > 0) {
    queries = positionalQueries.map((q, i) => ({ name: `Custom #${i + 1}`, cohort: 'custom', task: q }));
  } else if (queriesIndices.length > 0) {
    queries = queriesIndices.map(i => TEST_QUERIES[i]);
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
  if (providerFilter) console.log(`  Provider filter: \x1b[33m${providerFilter}\x1b[0m`);
  if (modelFilter || modelsFilter.length > 0) console.log(`  Model filter: \x1b[33m${[modelFilter, ...modelsFilter].filter(Boolean).join(', ')}\x1b[0m`);
  if (executionProfile) console.log(`  Execution profile: \x1b[33m${executionProfile}\x1b[0m`);
  if (shouldSave) console.log('  Saving full output to tests/output/');
  console.log();

  for (const q of queries) {
    console.log(`━━━ ${q.name} ━━━`);
    console.log(`Query: "${q.task}"\n`);

    const requestedModels = modelsFilter.length > 0
      ? modelsFilter
      : modelFilter
        ? [modelFilter]
        : providerFilter
          ? defaultModelsForProvider(providerFilter)
          : [q.mode || process.env.AGENT_MODEL || 'fast'];
    const runTargets = requestedModels.length > 0 ? requestedModels : ['fast'];
    const forcedProvider = providerFilter && providerFilter !== 'all' ? providerFilter : null;

    for (const modelKey of runTargets) {
      const ag = await runAgentQuery(q.task, {
        model: modelKey,
        provider: forcedProvider,
        executionProfile,
      }).catch(err => ({
        engine: `agent (${modelKey})`,
        modelKey,
        provider: forcedProvider || 'unknown',
        executionProfile: executionProfile || 'default',
        error: err.message,
      }));

      const agentLabel = ag.engine || 'Agent';
      const agLlmCost = ag.cost?.claude;
      const agToolCost = ag.cost?.tools;
      const agLlmDetail = ag.tokens?.input ? `${ag.tokens.input}in/${ag.tokens.output}out` : '?';

      console.log(`Model target: ${modelKey} | Provider: ${ag.provider || '?'} | Profile: ${ag.executionProfile || 'default'}`);
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
        const agModelName = ag.engine?.replace('agent (', '').replace(')', '') || modelKey;
        console.log(`\n  LLM: ${agModelName} — ${ag.tokens.input}in/${ag.tokens.output}out — $${(ag.cost?.claude || 0).toFixed(6)}`);
      }

      console.log('\n--- Summary (first 300 chars) ---');
      console.log((ag.summary || ag.error || '(none)').substring(0, 300));

      if (ag.error) console.log(`\nERROR: ${ag.error}`);
      console.log('\n');

      allResults.push({ query: q, ag, run: { modelKey, provider: forcedProvider || ag.provider, executionProfile: executionProfile || ag.executionProfile } });
    }
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
    md += `**Primary run label:** ${agModel}\n`;
    md += `**Endpoint:** POST /api/pull\n\n`;

    for (const { query, ag, run } of allResults) {
      md += `---\n\n## ${query.name}${query.cohort ? ` [${query.cohort}]` : ''}\n\n`;
      md += `**Query:** "${query.task}"\n\n`;
      md += `**Run target:** model=${run?.modelKey || ag.modelKey || 'unknown'}, provider=${run?.provider || ag.provider || 'unknown'}, profile=${run?.executionProfile || ag.executionProfile || 'default'}\n\n`;

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

    const grouped = new Map();
    for (const r of allResults) {
      const key = `${r.run?.provider || r.ag.provider || 'unknown'}|${r.run?.modelKey || r.ag.modelKey || 'unknown'}|${r.run?.executionProfile || r.ag.executionProfile || 'default'}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }

    md += `\n### By Model/Profile\n\n`;
    md += `| Provider | Model | Profile | Runs | Mean Cost | Mean Latency |\n|---|---|---:|---:|---:|---:|\n`;
    for (const [key, rows] of grouped.entries()) {
      const [provider, model, profile] = key.split('|');
      const costs = rows.map(r => r.ag.cost?.total).filter(c => c != null && c > 0);
      const latencies = rows.map(r => r.ag.latencyMs).filter(Boolean);
      md += `| ${provider} | ${model} | ${profile} | ${rows.length} | $${avg(costs).toFixed(5)} | ${avg(latencies).toFixed(0)}ms |\n`;
    }

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

module.exports = { TEST_QUERIES };

if (require.main === module) {
  main().catch(err => {
    console.error('Comparison test failed:', err);
    process.exit(1);
  });
}
