#!/usr/bin/env node
/**
 * One-shot Nostr zap-receipt watcher.
 *
 *   node scripts/nostr-watch-zaps.js
 *
 * Connects to Mongo, runs a single NostrZapWatcher poll, prints a
 * summary, then exits. Useful as a smoke test (test gate 8) and for
 * debugging when production cron isn't crediting balances.
 *
 * Required env: JAMIE_BOT_NSEC_BECH32, NOSTR_ZAP_PROVIDER_PUBKEYS,
 * MONGO_URI (or MONGO_DEBUG_URI when DEBUG_MODE=true), and the
 * Lightning price-cache prerequisites (so satsToUsdMicro works).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const NostrZapWatcher = require('../utils/NostrZapWatcher');

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true'
    ? process.env.MONGO_DEBUG_URI
    : process.env.MONGO_URI;
  if (!mongoURI) {
    console.error('Missing MONGO_URI (or MONGO_DEBUG_URI when DEBUG_MODE=true). Set it in .env');
    process.exit(1);
  }

  await mongoose.connect(mongoURI);

  const watcher = new NostrZapWatcher();
  const summary = await watcher.poll();

  console.log('\n--- summary ---');
  console.log(JSON.stringify(summary, null, 2));

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
