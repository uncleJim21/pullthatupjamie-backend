#!/usr/bin/env node
/**
 * Asserts that the npm supply-chain quarantine window is actually in effect.
 *
 * This exists because the protection is easy to lose silently: deleting .npmrc,
 * editing the value, running npm from outside the repo root, or a Dockerfile
 * that forgets to COPY .npmrc all disable it with no visible symptom. Installs
 * keep succeeding — they just stop being protected.
 *
 * Run locally, in CI, and before any dependency change.
 * Exits non-zero if the gate is missing or set to the wrong window.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REQUIRED_DAYS = 7;
const REPO_ROOT = path.resolve(__dirname, '..');
const NPMRC = path.join(REPO_ROOT, '.npmrc');

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

// 1. The .npmrc must exist and declare the window we expect.
if (!fs.existsSync(NPMRC)) {
  fail(`.npmrc is missing from ${REPO_ROOT}. The quarantine window is not in effect.`);
} else {
  const declared = fs
    .readFileSync(NPMRC, 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith('min-release-age'));

  if (!declared) {
    fail('.npmrc does not set min-release-age.');
  } else {
    const value = Number(declared.split('=')[1]?.trim());
    if (value !== REQUIRED_DAYS) {
      fail(`.npmrc sets min-release-age=${value}, expected ${REQUIRED_DAYS} (the unit is DAYS).`);
    }
  }
}

// 2. npm must actually honor it. npm normalizes min-release-age into `before`
//    and does NOT echo it back via `npm config get min-release-age` (always
//    null), so the resolved cutoff date is the only trustworthy signal.
let before;
try {
  before = execFileSync('npm', ['config', 'get', 'before'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
} catch (err) {
  fail(`could not read npm config: ${err.message}`);
}

if (!before || before === 'null' || before === 'undefined') {
  fail(
    'npm reports no `before` cutoff. Requires npm >= 11.10 — ' +
      `this environment has ${execFileSync('npm', ['-v'], { encoding: 'utf8' }).trim()}.`
  );
} else {
  const cutoff = new Date(before);
  if (Number.isNaN(cutoff.getTime())) {
    fail(`npm returned an unparseable cutoff: ${before}`);
  } else {
    const actualDays = (Date.now() - cutoff.getTime()) / 86_400_000;
    // Allow a day of slack: npm recomputes the cutoff at call time.
    if (Math.abs(actualDays - REQUIRED_DAYS) > 1) {
      fail(
        `cutoff is ${actualDays.toFixed(1)} days back, expected ~${REQUIRED_DAYS}. ` +
          `Resolved cutoff: ${cutoff.toISOString()}`
      );
    } else if (!process.exitCode) {
      console.log(
        `OK: npm ignores anything published after ${cutoff.toISOString()} ` +
          `(~${REQUIRED_DAYS}-day quarantine window).`
      );
    }
  }
}

if (process.exitCode) {
  console.error(
    '\nThe Shai-Hulud npm worm propagates by publishing malicious versions that\n' +
      'spread within minutes. The quarantine window is the control that stops it.\n' +
      'Restore .npmrc with `min-release-age=7` before installing anything.'
  );
}
