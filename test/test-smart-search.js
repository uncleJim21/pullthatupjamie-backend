#!/usr/bin/env node
/**
 * Smart Search Triage — Comparison Test Script
 *
 * Compares search results and timing between:
 *   - Local server (with smartMode)   vs  Remote server (without smartMode)
 *   - Local server (with smartMode)   vs  Local server (without smartMode)
 *
 * Usage:
 *   node test/test-smart-search.js
 *   node test/test-smart-search.js --local-only      # skip remote
 *   node test/test-smart-search.js --query "custom query here"
 */

const LOCAL_BASE = 'http://localhost:4132';
const REMOTE_BASE = 'https://pullthatupjamie-nsh57.ondigitalocean.app';

const TEST_QUERIES = [
  {
    label: 'Descriptive (show + guest + topic)',
    query: 'that funny story Steve O told Joe Rogan about doing dangerous stunts',
    expectedSignals: ['feed', 'guest']
  },
  {
    label: 'Descriptive (guest only)',
    query: 'when Elon Musk talked about going to Mars',
    expectedSignals: ['guest']
  },
  {
    label: 'Topical (no entities)',
    query: 'Bitcoin price prediction and inflation',
    expectedSignals: []
  },
  {
    label: 'Direct quote',
    query: 'the answer to life the universe and everything is 42',
    expectedSignals: []
  },
  {
    label: 'Descriptive (show reference)',
    query: 'that episode of JRE where they discussed psychedelics',
    expectedSignals: ['feed']
  }
];

async function searchQuotes(baseUrl, query, smartMode = false, limit = 5) {
  const start = Date.now();
  const res = await fetch(`${baseUrl}/api/search-quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit, smartMode })
  });
  const elapsed = Date.now() - start;
  const data = await res.json();
  return { data, elapsed, status: res.status };
}

function summarizeResults(results) {
  if (!results || !results.length) return '(no results)';
  return results.slice(0, 3).map((r, i) =>
    `  ${i + 1}. [${r.similarity?.combined?.toFixed(3) || '?'}] "${(r.quote || '').substring(0, 80)}..." — ${r.episode || 'unknown'} (${r.creator || ''})`
  ).join('\n');
}

function printDivider(char = '=', width = 80) {
  console.log(char.repeat(width));
}

function printTriageInfo(triage) {
  if (!triage) {
    console.log('  Triage: N/A (smartMode off or not available)');
    return;
  }
  console.log(`  Intent: ${triage.intent} (confidence: ${triage.confidence})`);
  if (triage.show_hint) console.log(`  Show hint: ${triage.show_hint}`);
  if (triage.person_hint) console.log(`  Person hint: ${triage.person_hint}`);
  if (triage.topic_keywords?.length) console.log(`  Topic keywords: ${triage.topic_keywords.join(', ')}`);
  if (triage.rewrittenQuery) console.log(`  Rewritten query: "${triage.rewrittenQuery}"`);
  console.log(`  Triage latency: ${triage.latencyMs}ms (classify: ${triage.classificationLatencyMs}ms, resolve: ${triage.resolutionLatencyMs}ms)`);

  const signals = triage.resolvedSignals || {};
  const matched = Object.entries(signals).filter(([, v]) => v.matched);
  if (matched.length > 0) {
    console.log(`  Resolved signals:`);
    for (const [name, info] of matched) {
      if (name === 'feed') console.log(`    - Feed: ${info.title} (${info.feedId})`);
      if (name === 'guest') console.log(`    - Guest: ${info.episodeCount} episodes found`);
      if (name === 'keywords') console.log(`    - Keywords: ${info.chapterCount} chapters, matched: ${info.matchedKeywords?.slice(0, 5).join(', ')}`);
    }
  } else {
    console.log(`  Resolved signals: none`);
  }
}

async function runComparison(testCase, localOnly = false) {
  const { label, query } = testCase;

  printDivider();
  console.log(`TEST: ${label}`);
  console.log(`QUERY: "${query}"`);
  printDivider('-');

  // Local WITHOUT smartMode
  console.log('\n[LOCAL — smartMode: OFF]');
  let localOff;
  try {
    localOff = await searchQuotes(LOCAL_BASE, query, false);
    console.log(`  Status: ${localOff.status}, Results: ${localOff.data.total}, Time: ${localOff.elapsed}ms`);
    console.log(summarizeResults(localOff.data.results));
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    localOff = null;
  }

  // Local WITH smartMode
  console.log('\n[LOCAL — smartMode: ON]');
  let localOn;
  try {
    localOn = await searchQuotes(LOCAL_BASE, query, true);
    console.log(`  Status: ${localOn.status}, Results: ${localOn.data.total}, Time: ${localOn.elapsed}ms`);
    if (localOn.data.originalQuery && localOn.data.originalQuery !== localOn.data.query) {
      console.log(`  Query rewritten: "${localOn.data.originalQuery}" -> "${localOn.data.query}"`);
    }
    printTriageInfo(localOn.data.triage);
    console.log('\n  Top results:');
    console.log(summarizeResults(localOn.data.results));
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    localOn = null;
  }

  // Remote (no smartMode — baseline comparison)
  if (!localOnly) {
    console.log('\n[REMOTE — smartMode: OFF (production baseline)]');
    let remote;
    try {
      remote = await searchQuotes(REMOTE_BASE, query, false);
      console.log(`  Status: ${remote.status}, Results: ${remote.data.total}, Time: ${remote.elapsed}ms`);
      console.log(summarizeResults(remote.data.results));
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      remote = null;
    }

    // Comparison summary
    if (localOn && remote) {
      console.log('\n[COMPARISON SUMMARY]');
      console.log(`  Latency: local+smart=${localOn.elapsed}ms vs remote=${remote.elapsed}ms (delta: ${localOn.elapsed - remote.elapsed}ms)`);

      const localTopScore = localOn.data.results?.[0]?.similarity?.combined || 0;
      const remoteTopScore = remote.data.results?.[0]?.similarity?.combined || 0;
      console.log(`  Top score: local+smart=${localTopScore.toFixed(4)} vs remote=${remoteTopScore.toFixed(4)} (delta: ${(localTopScore - remoteTopScore).toFixed(4)})`);

      const localEps = new Set(localOn.data.results?.map(r => r.episode) || []);
      const remoteEps = new Set(remote.data.results?.map(r => r.episode) || []);
      const overlap = [...localEps].filter(e => remoteEps.has(e)).length;
      console.log(`  Episode overlap: ${overlap}/${Math.max(localEps.size, remoteEps.size)} episodes in common`);
    }
  }

  // Local comparison (smart vs not)
  if (localOn && localOff) {
    console.log('\n[LOCAL SMART vs LOCAL STANDARD]');
    console.log(`  Latency: smart=${localOn.elapsed}ms vs standard=${localOff.elapsed}ms (overhead: +${localOn.elapsed - localOff.elapsed}ms)`);

    const smartTopScore = localOn.data.results?.[0]?.similarity?.combined || 0;
    const stdTopScore = localOff.data.results?.[0]?.similarity?.combined || 0;
    console.log(`  Top score: smart=${smartTopScore.toFixed(4)} vs standard=${stdTopScore.toFixed(4)} (delta: ${(smartTopScore - stdTopScore).toFixed(4)})`);

    const smartEps = new Set(localOn.data.results?.map(r => r.episode) || []);
    const stdEps = new Set(localOff.data.results?.map(r => r.episode) || []);
    const overlap = [...smartEps].filter(e => stdEps.has(e)).length;
    console.log(`  Episode overlap: ${overlap}/${Math.max(smartEps.size, stdEps.size)} episodes in common`);
    console.log(`  Smart search found different results: ${overlap < Math.max(smartEps.size, stdEps.size) ? 'YES' : 'NO'}`);
  }

  console.log('');
  return { localOff, localOn };
}

async function main() {
  const args = process.argv.slice(2);
  const localOnly = args.includes('--local-only');
  const customQueryIdx = args.indexOf('--query');
  const customQuery = customQueryIdx !== -1 ? args[customQueryIdx + 1] : null;

  console.log('\n');
  printDivider('=');
  console.log('  SMART SEARCH TRIAGE — COMPARISON TEST');
  console.log(`  Local:  ${LOCAL_BASE}`);
  if (!localOnly) console.log(`  Remote: ${REMOTE_BASE}`);
  console.log(`  Time:   ${new Date().toISOString()}`);
  printDivider('=');

  const queries = customQuery
    ? [{ label: 'Custom query', query: customQuery, expectedSignals: [] }]
    : TEST_QUERIES;

  const allResults = [];
  for (const testCase of queries) {
    const result = await runComparison(testCase, localOnly);
    allResults.push({ testCase, ...result });
  }

  // Overall summary
  printDivider('=');
  console.log('  OVERALL SUMMARY');
  printDivider('-');

  const smartTimes = allResults.filter(r => r.localOn).map(r => r.localOn.elapsed);
  const stdTimes = allResults.filter(r => r.localOff).map(r => r.localOff.elapsed);

  if (smartTimes.length > 0) {
    const avgSmart = Math.round(smartTimes.reduce((a, b) => a + b, 0) / smartTimes.length);
    const avgStd = Math.round(stdTimes.reduce((a, b) => a + b, 0) / stdTimes.length);
    console.log(`  Avg latency: smart=${avgSmart}ms, standard=${avgStd}ms, overhead=+${avgSmart - avgStd}ms`);
  }

  const triageIntents = allResults
    .filter(r => r.localOn?.data?.triage)
    .map(r => `${r.testCase.label}: ${r.localOn.data.triage.intent}`);
  console.log(`  Intent classifications:`);
  triageIntents.forEach(t => console.log(`    - ${t}`));

  printDivider('=');
  console.log('');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
