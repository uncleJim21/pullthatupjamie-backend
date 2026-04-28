#!/usr/bin/env node
/**
 * Match agent logs to TEST_QUERIES tasks (newest log per task by mtime) and print
 * cohort-level + aggregate tables: analyzer severity, quality proxies, UX sentiment.
 *
 * Usage:
 *   node tests/cohort-stats-report.js
 *
 * Sentiment buckets (heuristic, for bench regression — not user telemetry):
 *   energized — CLEAN, substantive (>=900 chars or clips), no trust-breaking codes
 *   decent    — recovered (MEDIUM), or only LOW caps, or HIGH truncation on still-long text
 *   meh       — short, weak openers, or thin HIGH without much body
 *   awful     — CRITICAL, truncated_clip, or empty-looking failure
 */

const fs = require('fs');
const path = require('path');
const { TEST_QUERIES } = require('./agent-comparison');
const { classify, severityRank } = require('./analyze-regression');

const COHORTS = ['cohort1', 'cohort2', 'cohort3', 'cohort4', 'cohort5', 'cohort6', 'cohort7', 'cohort8', 'cohort9'];

function severityOrder(sev) {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, CLEAN: 4 }[sev] ?? 5;
}

function worstIssue(issues) {
  if (!issues.length) return { severity: 'CLEAN', code: '-' };
  const sorted = [...issues].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return sorted[0];
}

function hasClipTokens(text) {
  return typeof text === 'string' && text.includes('{{clip:');
}

/**
 * Deterministic UX bucket from log + classify() issues (benchmark-only).
 */
function uxSentiment(log, issues) {
  const text = log.finalText || '';
  const len = text.trim().length;
  const clips = hasClipTokens(text);
  const w = worstIssue(issues);

  if (w.severity === 'CRITICAL') return 'awful';
  if (issues.some((i) => i.code === 'truncated_clip')) return 'awful';
  if (w.code === 'empty') return 'awful';

  if (w.severity === 'HIGH') {
    if (w.code === 'truncated_prose' && len >= 2400) return 'decent';
    if (w.code === 'truncated_prose') return 'meh';
    if (w.code === 'narration_prefix') return 'meh';
    return 'meh';
  }

  if (w.severity === 'MEDIUM') {
    if (w.code === 'narration_prefix_substantive' && len >= 2000 && clips) return 'energized';
    return 'decent';
  }

  if (w.severity === 'LOW') {
    if (len >= 900 && clips) return 'energized';
    if (len >= 500) return 'decent';
    return 'meh';
  }

  // CLEAN
  if (len >= 1200 && clips) return 'energized';
  if (len >= 600) return 'decent';
  return 'meh';
}

function loadLatestLogPerTask() {
  const dir = path.join(__dirname, '..', 'logs', 'agent');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  /** @type {Map<string, { mtime: number, log: object, file: string }>} */
  const best = new Map();

  for (const f of files) {
    const fp = path.join(dir, f);
    let log;
    try {
      log = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
      continue;
    }
    if (!log.summary) continue;
    const q = (log.query || log.userMessage || '').trim();
    if (!q) continue;
    const st = fs.statSync(fp);
    const prev = best.get(q);
    if (!prev || st.mtimeMs > prev.mtime) {
      best.set(q, { mtime: st.mtimeMs, log, file: f });
    }
  }
  return best;
}

function pct(n, d) {
  if (!d) return '0.0';
  return ((100 * n) / d).toFixed(1);
}

function main() {
  const byTask = loadLatestLogPerTask();
  const rows = [];

  for (const spec of TEST_QUERIES) {
    const task = (spec.task || '').trim();
    const hit = byTask.get(task);
    if (!hit) {
      rows.push({
        cohort: spec.cohort,
        name: spec.name,
        task,
        missing: true,
      });
      continue;
    }
    const { log, file } = hit;
    const issues = classify(log);
    issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    const worst = issues[0];
    const worstSev = worst?.severity || 'CLEAN';
    const worstCode = worst?.code || '-';
    const text = log.finalText || '';
    rows.push({
      cohort: spec.cohort,
      name: spec.name,
      task,
      missing: false,
      file,
      issues,
      worstSev,
      worstCode,
      textLen: text.length,
      hasClips: hasClipTokens(text),
      natural: log.summary?.naturalCompletion,
      synthExit: log.summary?.synthesisExitReason || '-',
      latencyMs: log.summary?.latencyMs,
      cost: log.summary?.cost?.total,
      ux: uxSentiment(log, issues),
    });
  }

  // --- Per-cohort ---
  console.log('\n=== Cohort benchmark report (newest agent log per TEST_QUERIES task) ===\n');

  for (const cohort of COHORTS) {
    const sub = rows.filter((r) => r.cohort === cohort);
    const n = sub.length;
    const miss = sub.filter((r) => r.missing).length;
    const ok = sub.filter((r) => !r.missing);

    const sev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, CLEAN: 0 };
    const uxAgg = { energized: 0, decent: 0, meh: 0, awful: 0 };
    let sumCost = 0;
    let sumLat = 0;
    let clips = 0;
    let longOk = 0;

    for (const r of ok) {
      sev[r.worstSev]++;
      uxAgg[r.ux]++;
      if (r.cost != null) sumCost += r.cost;
      if (r.latencyMs) sumLat += r.latencyMs;
      if (r.hasClips) clips++;
      if (r.textLen > 50) longOk++;
    }

    const denom = ok.length || 1;
    console.log(`--- ${cohort} (${n} tasks, ${miss} missing log match) ---`);
    console.log('| Analyzer worst | Count | % |');
    console.log('|---|---:|---:|');
    for (const s of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'CLEAN']) {
      console.log(`| ${s} | ${sev[s]} | ${pct(sev[s], ok.length)} |`);
    }
    console.log('| UX (heuristic) | Count | % |');
    console.log('|---|---:|---:|');
    for (const u of ['energized', 'decent', 'meh', 'awful']) {
      console.log(`| ${u} | ${uxAgg[u]} | ${pct(uxAgg[u], ok.length)} |`);
    }
    console.log('| Quality proxy | Value |');
    console.log('|---|---|');
    console.log(`| With {{clip:}} | ${clips}/${ok.length} (${pct(clips, ok.length)}%) |`);
    console.log(`| Summary >50 chars | ${longOk}/${ok.length} (${pct(longOk, ok.length)}%) |`);
    console.log(`| Mean cost (known) | $${(sumCost / denom).toFixed(4)} |`);
    console.log(`| Mean latency | ${Math.round(sumLat / denom)}ms |`);
    console.log('');
  }

  // --- All cohorts aggregate ---
  const okAll = rows.filter((r) => !r.missing);
  const missAll = rows.filter((r) => r.missing).length;
  const sev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, CLEAN: 0 };
  const uxAgg = { energized: 0, decent: 0, meh: 0, awful: 0 };
  let sumCost = 0;
  let sumLat = 0;
  let clips = 0;
  let longOk = 0;

  for (const r of okAll) {
    sev[r.worstSev]++;
    uxAgg[r.ux]++;
    if (r.cost != null) sumCost += r.cost;
    if (r.latencyMs) sumLat += r.latencyMs;
    if (r.hasClips) clips++;
    if (r.textLen > 50) longOk++;
  }

  const N = okAll.length;
  const D = N || 1;
  console.log('=== ALL COHORTS (matched logs only) ===\n');
  console.log(`Tasks in suite: ${rows.length} | Matched: ${N} | Missing log for task string: ${missAll}\n`);
  console.log('| Analyzer worst | Count | % |');
  console.log('|---|---:|---:|');
  for (const s of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'CLEAN']) {
    console.log(`| ${s} | ${sev[s]} | ${pct(sev[s], N)} |`);
  }
  console.log('\n| UX (heuristic) | Count | % |');
  console.log('|---|---:|---:|');
  for (const u of ['energized', 'decent', 'meh', 'awful']) {
    console.log(`| ${u} | ${uxAgg[u]} | ${pct(uxAgg[u], N)} |`);
  }
  console.log('\n| Quality / cost | Value |');
  console.log('|---|---|');
  console.log(`| With {{clip:}} | ${clips}/${N} (${pct(clips, N)}%) |`);
  console.log(`| Summary >50 chars | ${longOk}/${N} (${pct(longOk, N)}%) |`);
  console.log(`| Mean cost | $${(sumCost / D).toFixed(4)} |`);
  console.log(`| Mean latency | ${Math.round(sumLat / D)}ms |`);

  if (missAll) {
    console.log('\nMissing tasks (no log with exact matching query string):');
    for (const r of rows.filter((x) => x.missing)) {
      console.log(`  [${r.cohort}] ${r.name}: ${r.task.slice(0, 70)}…`);
    }
  }
  console.log('');
}

main();
