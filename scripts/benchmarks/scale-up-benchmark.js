/**
 * scale-up-benchmark.js
 *
 * Runs a fixed query suite against /api/pull in production. For each query:
 *   1. Sends a signed (HMAC + JWT) POST so the server includes its `metrics`
 *      payload in the JSON response.
 *   2. Runs heuristic gates (response length, expected keywords).
 *   3. Calls a gpt-4o-mini judge to grade semantic quality.
 *   4. Records per-query timing breakdown + tool-call latencies.
 *
 * Writes a Markdown report to tmp/benchmark-<timestamp>.md so you can run
 * this at each episode-count milestone during staging ramp and diff results.
 *
 * Required env:
 *   - BENCHMARK_BASE_URL      (e.g. https://api.pullthatupjamie.ai)
 *   - JWT_TEST_TOKEN          (auth — exists in your .env)
 *   - BENCHMARK_HMAC_SECRET   (the openssl rand -hex 32 value; same in server .env)
 *   - OPENAI_API_KEY          (for the judge — already in your env)
 *
 * Usage:
 *   node scripts/benchmarks/scale-up-benchmark.js
 *   node scripts/benchmarks/scale-up-benchmark.js --no-judge     # skip grading
 *   node scripts/benchmarks/scale-up-benchmark.js --repeats 3    # run each query N times
 *   node scripts/benchmarks/scale-up-benchmark.js --filter compound  # only matching IDs
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { signRequest } = require('./signRequest');
const { judgeResponse } = require('./judge');
const queriesFile = require('./benchmark-queries.json');

// ─── Config ───────────────────────────────────────────────────────────────

const BASE_URL = process.env.BENCHMARK_BASE_URL;
const JWT = process.env.JWT_TEST_TOKEN;
const HMAC_SECRET = process.env.BENCHMARK_HMAC_SECRET;

const REQUEST_TIMEOUT_MS = 90000; // /api/pull can be slow under load
const PER_QUERY_PAUSE_MS = 200;   // tiny inter-query breather, optional

// ─── Arg parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const noJudge = args.includes('--no-judge');
const repeatArgIdx = args.indexOf('--repeats');
const repeats = repeatArgIdx > -1 ? Math.max(1, parseInt(args[repeatArgIdx + 1], 10) || 1) : 2;
const filterArgIdx = args.indexOf('--filter');
const filter = filterArgIdx > -1 ? args[filterArgIdx + 1] : null;

// ─── Corpus stats fetch ───────────────────────────────────────────────────

async function fetchCorpusStats() {
  // Public endpoint, no auth needed. Counts episodes / paragraphs / chapters /
  // feeds. Stamped into the report header so milestone reports are directly
  // comparable as the corpus grows.
  try {
    const resp = await fetch(`${BASE_URL}/api/corpus-stats`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!resp.ok) {
      return { error: `HTTP ${resp.status}`, episodes: null, paragraphs: null };
    }
    const stats = await resp.json();
    return stats;
  } catch (err) {
    return { error: err.message, episodes: null, paragraphs: null };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fmtMs(ms) {
  if (ms == null) return '   —';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function pct(num, total) {
  if (!total) return '0%';
  return `${Math.round((100 * num) / total)}%`;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function checkResponseShouldMention(text, expected) {
  if (!expected || !Array.isArray(expected.responseShouldMention) || expected.responseShouldMention.length === 0) {
    return { skipped: true };
  }
  const lower = (text || '').toLowerCase();
  const matched = expected.responseShouldMention.filter(needle => lower.includes(needle.toLowerCase()));
  const requiresAny = expected.responseShouldMentionAny === true;
  const pass = requiresAny ? matched.length > 0 : matched.length === expected.responseShouldMention.length;
  return {
    pass,
    matched,
    expected: expected.responseShouldMention,
    mode: requiresAny ? 'any' : 'all',
  };
}

// Shared HTTP POST helper. The HMAC headers are unused by /api/search-quotes
// at the route level (entitlement middleware gates it), but they're cheap to
// include and futureproof if we ever want metrics on that path too.
async function callJson({ path, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const url = `${BASE_URL}${path}`;
  const rawBody = JSON.stringify(body);

  const hmacHeaders = signRequest({ method: 'POST', path, rawBody, secret: HMAC_SECRET });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  let response, parsed, networkErr;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${JWT}`,
        ...hmacHeaders,
      },
      body: rawBody,
      signal: controller.signal,
    });
    const text = await response.text();
    try { parsed = JSON.parse(text); }
    catch { parsed = { _rawText: text }; }
  } catch (err) {
    networkErr = err.message;
  } finally {
    clearTimeout(timeout);
  }
  const wallClockMs = Date.now() - startedAt;

  return {
    httpStatus: response?.status ?? null,
    wallClockMs,
    body: parsed,
    networkErr,
  };
}

async function callPull({ query }) {
  return callJson({
    path: '/api/pull',
    body: {
      message: query.prompt,
      stream: false,
      includeMetrics: false, // we want the SCOPED-via-HMAC metrics, not the env one
    },
  });
}

// Direct retrieval probe — bypasses the agent loop entirely. Tests the
// embedding + Pinecone + Atlas Search + Mongo enrichment path on its own.
// Faster than /api/pull (no orchestration LLM) and the latency that gates
// the upper bound on /api/pull responsiveness.
async function callSearchQuotes({ query }) {
  return callJson({
    path: '/api/search-quotes',
    body: {
      query: query.prompt,
      limit: 5,
    },
    timeoutMs: 30000, // search-quotes is faster; tight timeout catches degradation
  });
}

function evaluateQueryResult(query, result) {
  const gates = [];
  if (result.networkErr) gates.push({ name: 'network', pass: false, detail: result.networkErr });
  if (result.httpStatus && result.httpStatus !== 200) {
    // Surface the actual error body so 401/403/etc are visible at a glance
    // without having to grep into the markdown report. First 200 chars is
    // usually enough to tell auth-failure from quota-exhaustion from
    // server-error.
    const errSnippet = result.body?.error
      || result.body?._rawText
      || JSON.stringify(result.body || {}).slice(0, 200);
    gates.push({ name: 'http', pass: false, detail: `status ${result.httpStatus}: ${errSnippet.slice(0, 200)}` });
  }

  const text = result.body?.text || '';
  const minChars = query.expected?.responseMinChars || 0;
  if (minChars > 0) {
    gates.push({
      name: 'minChars',
      pass: text.length >= minChars,
      detail: `${text.length}/${minChars} chars`,
    });
  }

  const minResults = query.expected?.minResultsInToolCalls || 0;
  if (minResults > 0) {
    // metrics.toolCalls only exists when the server enabled benchmark mode
    // (valid HMAC signature). If metrics is entirely absent, we can't
    // evaluate result counts — skip the gate rather than fail it (a missed
    // env-var setup would otherwise look like a quality regression).
    const hasMetrics = !!result.body?.metrics;
    if (!hasMetrics) {
      gates.push({
        name: 'minResults',
        pass: true,
        detail: 'skipped — server did not return metrics (BENCHMARK_HMAC_SECRET likely not set on server, or server not restarted with the env)',
      });
    } else {
      const totalResultCount = (result.body.metrics.toolCalls || [])
        .reduce((acc, tc) => acc + (tc.resultCount || 0), 0);
      gates.push({
        name: 'minResults',
        pass: totalResultCount >= minResults,
        detail: `${totalResultCount}/${minResults} results across tool calls`,
      });
    }
  }

  const mentionCheck = checkResponseShouldMention(text, query.expected);
  if (!mentionCheck.skipped) {
    gates.push({
      name: 'mention',
      pass: mentionCheck.pass,
      detail: `${mentionCheck.mode}: matched [${mentionCheck.matched.join(', ')}] of [${mentionCheck.expected.join(', ')}]`,
    });
  }

  const passedAllGates = gates.length > 0 && gates.every(g => g.pass);
  return { gates, passedAllGates };
}

function aggregateTimings(allRuns) {
  const wallTimes = allRuns.map(r => r.result.wallClockMs).sort((a, b) => a - b);
  const llmTotals = allRuns.map(r => r.result.body?.metrics?.latencyMs).filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  const totalToolMs = allRuns.map(r => {
    const tc = r.result.body?.metrics?.toolCalls || [];
    return tc.reduce((acc, t) => acc + (t.latencyMs || 0), 0);
  }).sort((a, b) => a - b);

  // /api/search-quotes (direct retrieval) — its own latency profile.
  const sqWallTimes = allRuns
    .filter(r => r.searchResult && !r.searchResult.networkErr && r.searchResult.httpStatus === 200)
    .map(r => r.searchResult.wallClockMs)
    .sort((a, b) => a - b);
  const sqResultCounts = allRuns
    .filter(r => r.searchResult?.httpStatus === 200)
    .map(r => (r.searchResult.body?.results || []).length);
  const sqOkCount = sqWallTimes.length;
  const sqFailCount = allRuns.length - sqOkCount;
  const sqAvgResults = sqResultCounts.length
    ? sqResultCounts.reduce((a, b) => a + b, 0) / sqResultCounts.length
    : 0;

  return {
    wallClock: { p50: percentile(wallTimes, 50), p95: percentile(wallTimes, 95), p99: percentile(wallTimes, 99) },
    serverLatency: { p50: percentile(llmTotals, 50), p95: percentile(llmTotals, 95), p99: percentile(llmTotals, 99) },
    toolTime: { p50: percentile(totalToolMs, 50), p95: percentile(totalToolMs, 95), p99: percentile(totalToolMs, 99) },
    searchQuotes: {
      p50: percentile(sqWallTimes, 50),
      p95: percentile(sqWallTimes, 95),
      p99: percentile(sqWallTimes, 99),
      okCount: sqOkCount,
      failCount: sqFailCount,
      avgResults: sqAvgResults,
    },
  };
}

function toolNameBreakdown(allRuns) {
  const acc = new Map();
  for (const { result } of allRuns) {
    const tcs = result.body?.metrics?.toolCalls || [];
    for (const tc of tcs) {
      const name = tc.name || 'unknown';
      if (!acc.has(name)) acc.set(name, { count: 0, totalMs: 0 });
      const e = acc.get(name);
      e.count++;
      e.totalMs += tc.latencyMs || 0;
    }
  }
  return Array.from(acc.entries()).map(([name, { count, totalMs }]) => ({
    name, count, totalMs, avgMs: count ? Math.round(totalMs / count) : 0,
  })).sort((a, b) => b.totalMs - a.totalMs);
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  if (!BASE_URL) { console.error('BENCHMARK_BASE_URL not set'); process.exit(1); }
  if (!JWT) { console.error('JWT_TEST_TOKEN not set'); process.exit(1); }
  if (!HMAC_SECRET) { console.error('BENCHMARK_HMAC_SECRET not set'); process.exit(1); }

  const allQueries = queriesFile.queries.filter(q => !filter || q.id.includes(filter));
  if (allQueries.length === 0) {
    console.error(`No queries matched filter "${filter}"`);
    process.exit(1);
  }

  // Fetch corpus size first so it's stamped into the report header.
  // Done before any benchmark queries fire so the snapshot represents the
  // corpus state at the START of the run, not after.
  process.stdout.write('Fetching corpus stats... ');
  const corpusStats = await fetchCorpusStats();
  if (corpusStats.error) {
    console.log(`failed (${corpusStats.error}) — proceeding without stats`);
  } else {
    console.log(`${corpusStats.episodes?.toLocaleString()} episodes / ${corpusStats.paragraphs?.toLocaleString()} paragraphs`);
  }

  console.log(`\nScale-up benchmark`);
  console.log(`  target:   ${BASE_URL}`);
  console.log(`  queries:  ${allQueries.length} × ${repeats} repeats = ${allQueries.length * repeats} requests`);
  console.log(`  judge:    ${noJudge ? 'disabled' : 'gpt-4o-mini'}\n`);

  const runs = [];
  const startedAt = Date.now();

  for (let r = 0; r < repeats; r++) {
    for (const query of allQueries) {
      const tag = `[${query.id}#${r + 1}]`;
      process.stdout.write(`${tag} `.padEnd(48));

      // Fire /api/pull (agent loop) and /api/search-quotes (raw retrieval)
      // in parallel for the same prompt. They share no state on the server
      // side beyond the embedding cache (which is per-query, not shared),
      // so this is safe and roughly halves total wall-clock time.
      const [pullResult, searchResult] = await Promise.all([
        callPull({ query }),
        callSearchQuotes({ query }),
      ]);
      const gateResult = evaluateQueryResult(query, pullResult);

      let judgeResult = null;
      if (!noJudge && !pullResult.networkErr && pullResult.httpStatus === 200 && query.judgeCriteria) {
        judgeResult = await judgeResponse({
          question: query.prompt,
          response: pullResult.body?.text || '',
          criteria: query.judgeCriteria,
        });
      }

      const overallPass = gateResult.passedAllGates && (judgeResult?.pass !== false);
      const statusMark = overallPass ? '✓' : '✘';
      const judgeMark = judgeResult == null ? '—' : (judgeResult.pass === true ? '✓' : (judgeResult.pass === false ? '✘' : '?'));
      const sqStatus = searchResult.networkErr || searchResult.httpStatus !== 200 ? '✘' : '✓';
      console.log(`${statusMark} pull:${fmtMs(pullResult.wallClockMs).padStart(7)}  sq:${sqStatus}${fmtMs(searchResult.wallClockMs).padStart(7)}  gates:${gateResult.passedAllGates ? '✓' : '✘'}  judge:${judgeMark}`);
      // On gate failures, also log the first failing gate detail so the
      // operator doesn't have to open the markdown to find out why.
      if (!gateResult.passedAllGates) {
        const failed = gateResult.gates.find(g => !g.pass);
        if (failed) console.log(`              ↳ ${failed.name}: ${failed.detail}`);
      }
      if (searchResult.httpStatus && searchResult.httpStatus !== 200) {
        const errSnippet = searchResult.body?.error || searchResult.body?._rawText || JSON.stringify(searchResult.body || {}).slice(0, 120);
        console.log(`              ↳ search-quotes ${searchResult.httpStatus}: ${errSnippet.slice(0, 120)}`);
      }

      runs.push({ query, result: pullResult, searchResult, gateResult, judgeResult });

      if (PER_QUERY_PAUSE_MS) await new Promise(r => setTimeout(r, PER_QUERY_PAUSE_MS));
    }
  }

  const wallMs = Date.now() - startedAt;
  const passCount = runs.filter(r => r.gateResult.passedAllGates && (r.judgeResult?.pass !== false)).length;
  const failCount = runs.length - passCount;
  const timings = aggregateTimings(runs);
  const toolBreakdown = toolNameBreakdown(runs);

  // ─── Markdown report ───
  const reportLines = [];
  const r = (s) => reportLines.push(s);

  r(`# Scale-up Benchmark — ${new Date().toISOString()}`);
  r('');
  if (corpusStats && !corpusStats.error) {
    r(`## Corpus snapshot`);
    r('');
    r(`- **Episodes:** ${corpusStats.episodes?.toLocaleString()}`);
    r(`- **Paragraphs:** ${corpusStats.paragraphs?.toLocaleString()}`);
    r(`- **Chapters:** ${corpusStats.chapters?.toLocaleString()}`);
    r(`- **Feeds:** ${corpusStats.feeds?.toLocaleString()}`);
    r(`- Captured at: \`${corpusStats.capturedAt}\``);
    r('');
  } else if (corpusStats?.error) {
    r(`## Corpus snapshot`);
    r('');
    r(`- ⚠️  Failed to fetch corpus stats: ${corpusStats.error}`);
    r('');
  }
  r(`## Run config`);
  r('');
  r(`- Target: \`${BASE_URL}\``);
  r(`- Queries: ${allQueries.length} × ${repeats} repeats = ${runs.length} requests`);
  r(`- Total wall time: ${fmtMs(wallMs)}`);
  r(`- Judge: ${noJudge ? 'disabled' : 'gpt-4o-mini'}`);
  r('');
  r(`## Summary`);
  r(`- **Pass:** ${passCount}/${runs.length} (${pct(passCount, runs.length)})`);
  r(`- **Fail:** ${failCount}/${runs.length}`);
  r('');
  r(`### /api/pull — wall-clock latency (client-side, full agent loop)`);
  r(`- p50: ${fmtMs(timings.wallClock.p50)}`);
  r(`- p95: ${fmtMs(timings.wallClock.p95)}`);
  r(`- p99: ${fmtMs(timings.wallClock.p99)}`);
  r('');
  r(`### /api/pull — server-reported latency (\`metrics.latencyMs\`)`);
  r(`- p50: ${fmtMs(timings.serverLatency.p50)}`);
  r(`- p95: ${fmtMs(timings.serverLatency.p95)}`);
  r(`- p99: ${fmtMs(timings.serverLatency.p99)}`);
  r('');
  r(`### /api/pull — tool-call time (sum across rounds, server-reported)`);
  r(`- p50: ${fmtMs(timings.toolTime.p50)}`);
  r(`- p95: ${fmtMs(timings.toolTime.p95)}`);
  r(`- p99: ${fmtMs(timings.toolTime.p99)}`);
  r('');
  r(`### /api/search-quotes — direct retrieval (embedding + Pinecone + Atlas + Mongo)`);
  r(`- p50: ${fmtMs(timings.searchQuotes.p50)}`);
  r(`- p95: ${fmtMs(timings.searchQuotes.p95)}`);
  r(`- p99: ${fmtMs(timings.searchQuotes.p99)}`);
  r(`- Success: ${timings.searchQuotes.okCount} / Failed: ${timings.searchQuotes.failCount}`);
  r(`- Avg results returned: ${timings.searchQuotes.avgResults.toFixed(1)}`);
  r('');
  r(`### Tool breakdown (aggregate across all runs)`);
  r('');
  r(`| Tool | Calls | Total ms | Avg ms/call |`);
  r(`|---|---|---|---|`);
  for (const t of toolBreakdown) {
    r(`| \`${t.name}\` | ${t.count} | ${t.totalMs} | ${t.avgMs} |`);
  }
  r('');
  r(`## Per-query results`);
  r('');
  r(`| Query | Status | Pull wall | Pull server | SearchQ | Gates | Judge | Notes |`);
  r(`|---|---|---|---|---|---|---|---|`);
  for (const run of runs) {
    const q = run.query;
    const result = run.result;
    const sq = run.searchResult;
    const overallPass = run.gateResult.passedAllGates && (run.judgeResult?.pass !== false);
    const gateBlurb = run.gateResult.gates.map(g => `${g.name}:${g.pass ? '✓' : '✘'}`).join(' ');
    const judgeBlurb = run.judgeResult == null
      ? '—'
      : (run.judgeResult.pass === true ? '✓' : (run.judgeResult.pass === false ? '✘' : '?'));
    const notes = (run.judgeResult?.reason || '').slice(0, 100).replace(/\|/g, '\\|');
    const sqCell = sq?.networkErr
      ? `err`
      : (sq?.httpStatus === 200 ? fmtMs(sq.wallClockMs) : `${sq?.httpStatus}`);
    r(`| ${q.id} | ${overallPass ? '✓' : '✘'} | ${fmtMs(result.wallClockMs)} | ${fmtMs(result.body?.metrics?.latencyMs)} | ${sqCell} | ${gateBlurb} | ${judgeBlurb} | ${notes} |`);
  }
  r('');
  r(`## Notes`);
  r('');
  r(`Run with \`--repeats N\` to tighten p95/p99 numbers. Run with \`--no-judge\` to skip semantic grading (saves ~$0.05 in OpenAI tokens). Run with \`--filter <id-substring>\` to narrow to a subset.`);

  const outDir = path.join(__dirname, '..', '..', 'tmp');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `benchmark-${ts}.md`);
  fs.writeFileSync(outFile, reportLines.join('\n'));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Summary: ${passCount}/${runs.length} pass, ${failCount} fail`);
  console.log(`/api/pull          wall p50=${fmtMs(timings.wallClock.p50)} p95=${fmtMs(timings.wallClock.p95)} p99=${fmtMs(timings.wallClock.p99)}`);
  console.log(`/api/search-quotes wall p50=${fmtMs(timings.searchQuotes.p50)} p95=${fmtMs(timings.searchQuotes.p95)} p99=${fmtMs(timings.searchQuotes.p99)} (${timings.searchQuotes.okCount}ok / ${timings.searchQuotes.failCount}fail, avg ${timings.searchQuotes.avgResults.toFixed(1)} results)`);

  // Detect the most common operator confusion: harness sends signed
  // requests but server didn't return metrics. Usually means the server's
  // BENCHMARK_HMAC_SECRET isn't set, or the server was started before the
  // env var was added.
  const runsWithMetrics = runs.filter(r => r.result.body?.metrics).length;
  if (runsWithMetrics === 0 && runs.length > 0) {
    console.log('');
    console.log('⚠️  NO responses contained the `metrics` field.');
    console.log('   The server did not enable benchmark mode for any request.');
    console.log('   Likely causes:');
    console.log('     1. BENCHMARK_HMAC_SECRET is not set in the SERVER process env');
    console.log('     2. The server was started before BENCHMARK_HMAC_SECRET was added — restart it');
    console.log('     3. The harness and server have different secrets (.env mismatch)');
    console.log('   Without metrics, latency breakdowns and tool counts are unavailable.');
  } else if (runsWithMetrics < runs.length) {
    console.log('');
    console.log(`⚠️  Only ${runsWithMetrics}/${runs.length} responses had a metrics field. Partial benchmark visibility.`);
  }

  console.log(`Report written to: ${outFile}`);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
