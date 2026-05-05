#!/usr/bin/env node
/**
 * One-shot Nostr mention watcher.
 *
 *   node scripts/nostr-watch-mentions.js
 *
 * Connects to Mongo, runs a single NostrMentionWatcher poll, prints a
 * summary, then exits. Useful as a smoke test (test gate 4) and for
 * debugging when production cron isn't catching something.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const NostrMentionWatcher = require('../utils/NostrMentionWatcher');

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true'
    ? process.env.MONGO_DEBUG_URI
    : process.env.MONGO_URI;
  if (!mongoURI) {
    console.error('Missing MONGO_URI (or MONGO_DEBUG_URI when DEBUG_MODE=true). Set it in .env');
    process.exit(1);
  }

  await mongoose.connect(mongoURI);

  const watcher = new NostrMentionWatcher();
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
