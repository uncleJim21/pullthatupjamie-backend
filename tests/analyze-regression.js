#!/usr/bin/env node
/**
 * Surface worst-performing queries from a regression run.
 * Reads the most recent N agent logs and classifies each by failure mode.
 *
 * Usage: node tests/analyze-regression.js [--last N] [--since "ISO-timestamp"]
 */

const fs = require('fs');
const path = require('path');
const { hasToolCallMarkup } = require('../utils/agent/sanitizeOutput');

const NARRATION_PREFIX_RE = /^\s*(let me\b|i'?ll\b|i'?m going to\b|now let me\b|first,? let me\b|let'?s grab\b|let'?s see\b|let'?s )/i;
const TRUNCATED_CLIP_RE = /\{\{clip:[^}]*$/;
// Mid-sentence: text doesn't end with terminal punctuation/quote/bracket
const MID_SENTENCE_RE = /[a-zA-Z0-9,;:\-—]\s*$/;

function classify(log) {
  const text = log.finalText || '';
  const recovery = log.synthesisRecovery;
  const issues = [];
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    issues.push({ severity: 'CRITICAL', code: 'empty', detail: 'no finalText emitted' });
    return issues;
  }
  if (hasToolCallMarkup(text)) {
    issues.push({ severity: 'CRITICAL', code: 'dsml_leak', detail: 'tool-call markup in finalText' });
  }
  if (recovery?.tier3) {
    issues.push({ severity: 'CRITICAL', code: 'tier3_fired', detail: 'all recovery tiers failed, hardcoded message used' });
  }
  if (TRUNCATED_CLIP_RE.test(trimmed)) {
    issues.push({ severity: 'HIGH', code: 'truncated_clip', detail: `ends mid-clip-token: "...${trimmed.slice(-40)}"` });
  }
  if (MID_SENTENCE_RE.test(trimmed) && !TRUNCATED_CLIP_RE.test(trimmed)) {
    issues.push({ severity: 'HIGH', code: 'truncated_prose', detail: `ends mid-sentence: "...${trimmed.slice(-50)}"` });
  }
  if (NARRATION_PREFIX_RE.test(trimmed.slice(0, 200)) && trimmed.length < 800) {
    issues.push({ severity: 'HIGH', code: 'narration_prefix', detail: `opens with: "${trimmed.slice(0, 80)}..."` });
  } else if (NARRATION_PREFIX_RE.test(trimmed.slice(0, 200))) {
    issues.push({ severity: 'MEDIUM', code: 'narration_prefix_substantive', detail: `opens with: "${trimmed.slice(0, 80)}..."` });
  }
  if (recovery && !recovery.tier3) {
    const tier = recovery.tier2?.ok ? 'tier2' : recovery.tier1?.ok ? 'tier1' : 'unknown';
    issues.push({ severity: 'MEDIUM', code: `recovered_${tier}`, detail: `primary trigger=${recovery.primary?.trigger}; recovered via ${tier}` });
  }
  if (log.summary?.naturalCompletion === false && log.summary?.synthesisExitReason && !recovery) {
    issues.push({ severity: 'LOW', code: 'forced_synthesis', detail: `synthesis fired (${log.summary.synthesisExitReason}); cleaned without recovery` });
  }
  if (text.length < 400 && !recovery) {
    issues.push({ severity: 'LOW', code: 'short_response', detail: `${text.length} chars` });
  }

  return issues;
}

function severityRank(s) {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[s] ?? 4;
}

function main() {
  const args = process.argv.slice(2);
  const lastIdx = args.indexOf('--last');
  const sinceIdx = args.indexOf('--since');
  const N = lastIdx >= 0 ? parseInt(args[lastIdx + 1], 10) : 41;
  const since = sinceIdx >= 0 ? new Date(args[sinceIdx + 1]) : null;

  const dir = path.join(__dirname, '..', 'logs', 'agent');
  let files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtime }));
  if (since) files = files.filter(x => x.mtime >= since);
  files = files.sort((a, b) => b.mtime - a.mtime).slice(0, N).map(x => x.f);

  const records = [];
  for (const f of files) {
    try {
      const log = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!log.summary) continue;
      const issues = classify(log);
      issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
      const worst = issues[0];
      records.push({
        file: f,
        question: log.query || log.userMessage || '(no query)',
        textLen: (log.finalText || '').length,
        rounds: log.summary.rounds,
        natural: log.summary.naturalCompletion,
        synthesisReason: log.summary.synthesisExitReason,
        latencyMs: log.summary.latencyMs,
        cost: log.summary.cost?.total,
        recoveryTier: log.synthesisRecovery
          ? (log.synthesisRecovery.tier3 ? 'tier3' : log.synthesisRecovery.tier2?.ok ? 'tier2' : log.synthesisRecovery.tier1?.ok ? 'tier1' : 'recovery_failed')
          : 'primary',
        issues,
        worstSeverity: worst?.severity || 'CLEAN',
        worstCode: worst?.code || '-',
      });
    } catch (e) {}
  }

  records.sort((a, b) => severityRank(a.worstSeverity) - severityRank(b.worstSeverity)
    || (a.worstCode > b.worstCode ? 1 : a.worstCode < b.worstCode ? -1 : 0));

  const groups = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [], CLEAN: [] };
  for (const r of records) groups[r.worstSeverity].push(r);

  console.log('==========================================================');
  console.log(`REGRESSION ANALYSIS — ${records.length} queries`);
  console.log('==========================================================\n');

  console.log('Severity distribution:');
  for (const s of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'CLEAN']) {
    console.log(`  ${s.padEnd(9)} ${groups[s].length}`);
  }
  console.log();

  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM']) {
    if (groups[sev].length === 0) continue;
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`${sev}  (${groups[sev].length} queries)`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    for (const r of groups[sev]) {
      console.log(`Q: ${r.question.slice(0, 100)}`);
      console.log(`   ${r.rounds}r | nat=${r.natural ? 'T' : 'F'} | synth=${r.synthesisReason || '-'} | ${(r.latencyMs/1000).toFixed(1)}s | ${r.textLen}c | $${r.cost?.toFixed(4)} | recov=${r.recoveryTier}`);
      for (const issue of r.issues) {
        console.log(`   [${issue.severity}/${issue.code}] ${issue.detail}`);
      }
      console.log(`   log: ${r.file}`);
      console.log();
    }
  }

  if (groups.LOW.length > 0) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`LOW  (${groups.LOW.length} queries — minor / informational)`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    for (const r of groups.LOW) {
      console.log(`  ${r.question.slice(0, 80).padEnd(80)} ${r.worstCode}`);
    }
  }

  console.log(`\nCLEAN: ${groups.CLEAN.length} queries with no flagged issues`);
  if (groups.CLEAN.length > 0 && groups.CLEAN.length <= 25) {
    for (const r of groups.CLEAN) console.log(`  ${r.question.slice(0, 80)}`);
  }
}

main();
