#!/usr/bin/env node
/**
 * One-shot Nostr mention reply worker.
 *
 *   node scripts/nostr-process-mentions.js
 *
 * Connects to Mongo, runs a single NostrBotReplyService.tick(),
 * prints a summary, then exits. Useful as a smoke test (test gate
 * 12) and for manually flushing pending mentions.
 *
 * Required env: JAMIE_BOT_NSEC_BECH32, JAMIE_BOT_LN_ADDRESS,
 * MONGO_URI (or MONGO_DEBUG_URI when DEBUG_MODE=true), plus the
 * provider keys the agent loop uses (ANTHROPIC_API_KEY etc).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const NostrBotReplyService = require('../utils/NostrBotReplyService');

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true'
    ? process.env.MONGO_DEBUG_URI
    : process.env.MONGO_URI;
  if (!mongoURI) {
    console.error('Missing MONGO_URI (or MONGO_DEBUG_URI when DEBUG_MODE=true). Set it in .env');
    process.exit(1);
  }

  await mongoose.connect(mongoURI);

  const worker = new NostrBotReplyService();
  const summary = await worker.tick();

  console.log('\n--- summary ---');
  console.log(JSON.stringify(summary, null, 2));

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
