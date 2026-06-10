#!/usr/bin/env node
/**
 * Manually arm the in-process Read-In cache warm via the /api/tape/warm route.
 * Use this to rebuild the live cache on demand (e.g. after a deploy or to shift
 * the warm to off-hours) WITHOUT restarting — a restart would wipe the in-memory
 * cache. Authenticates with the shared TAPE_WARM_SECRET.
 *
 *   node scripts/arm-warm.js --dry-run                 # auth + list planned tickers, NO synthesis (free)
 *   node scripts/arm-warm.js --only NVDA,TSLA --wait   # warm just these, wait for the summary
 *   node scripts/arm-warm.js --limit 5                 # warm top 5 (background)
 *   node scripts/arm-warm.js                           # full warm (background, ~30 min)
 *
 * Targets:
 *   default        staging (STAGING_URL below)
 *   --local        http://localhost:4150
 *   TAPE_WARM_BASE_URL=<url>   explicit override (wins over both)
 * Env:
 *   SHARED_HMAC_SECRET  shared secret (must match the server's SHARED_HMAC_SECRET)
 */

require('dotenv').config();

const STAGING_URL = 'https://pullthatupjamie-explore-alpha-xns9k.ondigitalocean.app';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };

const BASE = process.env.TAPE_WARM_BASE_URL || (has('--local') ? 'http://localhost:4150' : STAGING_URL);
const SECRET = process.env.SHARED_HMAC_SECRET || '';

const body = {};
if (has('--dry-run')) body.dryRun = true;
if (has('--wait')) body.wait = true;
if (opt('--only')) body.only = opt('--only').split(',').map((s) => s.trim()).filter(Boolean);
if (opt('--limit')) body.limit = parseInt(opt('--limit'), 10);

(async () => {
  if (!SECRET) { console.error('TAPE_WARM_SECRET not set in env.'); process.exit(1); }
  const url = `${BASE.replace(/\/$/, '')}/api/tape/warm`;
  console.log(`POST ${url}  body=${JSON.stringify(body)}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  console.log(`HTTP ${res.status}`);
  console.log(typeof json === 'string' ? json : JSON.stringify(json, null, 2));
  process.exit(res.ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
