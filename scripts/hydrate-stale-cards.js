#!/usr/bin/env node
/**
 * Hydrate stale company cards — keeps config/tape-company-cards.yaml fresh out of
 * band so request-time lookups stay zippy (always in-memory, never a live API).
 *
 *   node scripts/hydrate-stale-cards.js                 # rebuild cards older than 30d
 *   node scripts/hydrate-stale-cards.js --max-age-days 14
 *   node scripts/hydrate-stale-cards.js --dry-run       # just list what's stale
 *   node scripts/hydrate-stale-cards.js --limit 40      # cap per run (Finnhub rate)
 *
 * Staleness = builtAt older than max-age (or missing builtAt). Re-builds the stale
 * subset by shelling out to build-company-cards.js --only <stale> --force, so all
 * the Finnhub+LLM logic lives in one place. Intended to be run on a schedule (cron
 * or node-cron); a single run is rate-limit-friendly via --limit.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { spawn } = require('child_process');

const CARDS = path.join(__dirname, '..', 'config', 'tape-company-cards.yaml');
const BUILDER = path.join(__dirname, 'build-company-cards.js');
const argv = process.argv.slice(2);
const optN = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) : d; };
const has = (f) => argv.includes(f);

const MAX_AGE_DAYS = optN('--max-age-days', parseInt(process.env.TAPE_CARD_MAX_AGE_DAYS || '30', 10));
const LIMIT = optN('--limit', parseInt(process.env.TAPE_CARD_HYDRATE_BATCH || '60', 10)); // Finnhub ~60/min
const DRY = has('--dry-run');
const DAY_MS = 86_400_000;

function staleTickers(cards, now) {
  const out = [];
  for (const [ticker, c] of Object.entries(cards)) {
    const built = c && c.builtAt ? Date.parse(c.builtAt) : NaN;
    const ageDays = Number.isFinite(built) ? (now - built) / DAY_MS : Infinity; // missing builtAt = stale
    if (ageDays > MAX_AGE_DAYS) out.push({ ticker, ageDays });
  }
  // Oldest first, so a capped run refreshes the most-stale.
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

function main() {
  if (!fs.existsSync(CARDS)) { console.error('No cards file at', CARDS); process.exit(2); }
  const now = Date.now();
  const cards = yaml.load(fs.readFileSync(CARDS, 'utf8')) || {};
  const total = Object.keys(cards).length;
  let stale = staleTickers(cards, now);
  console.log(`${total} cards; ${stale.length} stale (> ${MAX_AGE_DAYS}d).`);
  if (!stale.length) { console.log('Nothing to hydrate.'); return; }

  if (stale.length > LIMIT) {
    console.log(`Capping to ${LIMIT} most-stale this run (rerun for the rest).`);
    stale = stale.slice(0, LIMIT);
  }
  const tickers = stale.map((s) => s.ticker);
  console.log(`${DRY ? '[dry-run] would rebuild' : 'rebuilding'}: ${tickers.join(', ')}`);
  if (DRY) return;

  const child = spawn('node', [BUILDER, '--only', tickers.join(','), '--force'], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
}

main();
