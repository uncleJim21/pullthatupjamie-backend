#!/usr/bin/env node
/**
 * Manual / test runner for the Read-In cache warmer.
 *
 *   node scripts/warm-readins.js --dry-run            # list what would be warmed (no DB, no LLM)
 *   node scripts/warm-readins.js --only NVDA,TSLA     # warm just these (cheap smoke test)
 *   node scripts/warm-readins.js --limit 5            # warm the top 5 of the generic order
 *   node scripts/warm-readins.js                      # full run (respects $/ticker caps)
 *
 * NOTE: a standalone run warms THIS process's in-memory cache and then exits — only
 * a server with REDIS_URL set shares that cache. For the in-memory production server
 * the warm runs IN-PROCESS via the daily cron (server.js); this CLI is for testing
 * the logic, measuring cost, and Redis deployments.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const OpenAI = require('openai');
const { warmReadins, effectiveLimit, getWarmTickers } = require('../services/tape/warmReadins');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const optStr = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const optInt = (f) => { const v = optStr(f); return v != null ? parseInt(v, 10) : undefined; };

(async () => {
  if (has('--dry-run')) {
    const all = getWarmTickers();
    const n = Math.min(effectiveLimit(), all.length);
    console.log(`[dry-run] generic order has ${all.length} carded tickers; would warm top ${n}:`);
    console.log('  ' + all.slice(0, n).join(', '));
    return;
  }

  if (!process.env.MONGO_URI) { console.error('MONGO_URI not set.'); process.exit(1); }
  await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const only = optStr('--only') ? optStr('--only').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const res = await warmReadins({ openai, log: (m) => console.log(m), limit: optInt('--limit'), only });
  console.log(JSON.stringify(res, null, 2));
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
