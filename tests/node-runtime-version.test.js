#!/usr/bin/env node
/**
 * Regression guard: the process must run on a Node.js release that contains the
 * October 21, 2026 security fixes.
 *
 * Why this exists: the app auto-decodes Brotli responses from third-party hosts
 * (RSS cover art, research-session preview images, quote providers) via global
 * fetch / node-fetch / axios, so CVE-2026-111497 (OOB write in the Brotli
 * decoder, RCE) and the TLS hostname-check bypasses (CVE-2026-106069,
 * CVE-2026-105483, CVE-2026-106072) are reachable from attacker-controlled
 * servers. The only fix is the runtime itself. Minimum patched versions per
 * line come from https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
 *
 * Run: node tests/node-runtime-version.test.js
 * Also runnable inside the built image to verify the container, not just the
 * Dockerfile text:  docker run --rm <image> node tests/node-runtime-version.test.js
 */

const MIN_PATCHED = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };

function parse(v) {
  return v.replace(/^v/, '').split('.').map(Number);
}

function gte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

function check(version) {
  const v = parse(version);
  const min = MIN_PATCHED[v[0]];
  if (!min) {
    if (v[0] > 26) return { ok: true, reason: `Node ${version} is newer than every line in the advisory` };
    return { ok: false, reason: `Node ${version} is on an end-of-life line with no fix for the October 2026 CVEs` };
  }
  return gte(v, min)
    ? { ok: true, reason: `Node ${version} >= ${min.join('.')}` }
    : { ok: false, reason: `Node ${version} < ${min.join('.')} (unpatched for the October 2026 CVEs)` };
}

// Self-test of the comparator against known-good and known-bad versions.
const fixtures = [
  ['v20.19.6', false], ['v20.20.2', false], ['v22.23.3', false], ['v22.23.4', true],
  ['v24.22.0', false], ['v24.22.1', true], ['v26.12.0', false], ['v26.12.1', true], ['v28.0.0', true],
];
for (const [ver, expected] of fixtures) {
  const r = check(ver);
  if (r.ok !== expected) {
    console.error(`FAIL: comparator wrong for ${ver}: expected ${expected}, got ${r.ok} (${r.reason})`);
    process.exit(1);
  }
}

const result = check(process.version);
if (!result.ok) {
  console.error(`FAIL: ${result.reason}`);
  process.exit(1);
}
console.log(`OK: ${result.reason}`);
