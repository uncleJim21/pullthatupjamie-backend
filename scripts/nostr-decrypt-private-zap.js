#!/usr/bin/env node
/**
 * Private-Zap Decryption Smoke Test
 *
 *   node scripts/nostr-decrypt-private-zap.js <receiptId-64hex>
 *
 * Loads a stored NostrZapReceipt by id from MongoDB, attempts to
 * decrypt its `anon` tag (Damus bech32 OR canonical NIP-04 wire),
 * and prints the recovered real sender's npub. This is the one-step
 * empirical confirmation that private-zap decryption works against
 * a real production receipt before flipping NOSTR_BOT_ENABLED on.
 *
 * Reads JAMIE_BOT_NSEC_BECH32 from .env. Mongo connection string
 * comes from MONGO_URI (same as the rest of the app). Nothing is
 * written to the DB.
 *
 * Exits non-zero on any failure so this can be wired into a smoke
 * suite later if desired.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const { NostrZapReceipt } = require('../models/NostrZapReceipt');
const { getBotSecretKey, getBotPubkeyHex } = require('../utils/nostrBotIdentity');
const { classifyAnonTag, decryptPrivateZap } = require('../utils/privateZapDecoder');

const HEX64 = /^[0-9a-f]{64}$/i;

async function main() {
  const arg = (process.argv[2] || '').toLowerCase().trim();
  if (!HEX64.test(arg)) {
    console.error('Usage: node scripts/nostr-decrypt-private-zap.js <receiptId-64hex>');
    process.exit(2);
  }

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGO_URI (or MONGODB_URI) is required in .env');
    process.exit(2);
  }

  let botSk;
  try {
    botSk = getBotSecretKey();
    console.log(`[smoke] bot pubkey = ${getBotPubkeyHex()}`);
  } catch (err) {
    console.error('[smoke] bot identity unavailable:', err.message);
    process.exit(2);
  }

  await mongoose.connect(mongoUri);
  console.log('[smoke] connected to mongo');

  try {
    const row = await NostrZapReceipt.findOne({ receiptId: arg }).lean();
    if (!row) {
      console.error('[smoke] no NostrZapReceipt with that id');
      process.exit(1);
    }
    const outer = row.rawZapRequest;
    if (!outer) {
      console.error('[smoke] receipt has no rawZapRequest stored — nothing to decrypt');
      process.exit(1);
    }

    console.log(`[smoke] receipt amountSats = ${row.amountSats}`);
    console.log(`[smoke] receipt currentSenderNpub = ${row.senderNpubHex}`);
    console.log(`[smoke] outer zap request pubkey (ephemeral) = ${outer.pubkey}`);

    const anonClass = classifyAnonTag(outer);
    console.log(`[smoke] anon tag classification = ${anonClass.kind}`);

    if (anonClass.kind === 'none') {
      console.log('[smoke] no anon tag — public zap, no decryption needed');
      console.log(`[smoke] expected real sender = ${outer.pubkey} (already credited correctly)`);
      process.exit(0);
    }
    if (anonClass.kind === 'anonymous') {
      console.log('[smoke] truly anonymous (anon tag with no value) — unrecoverable');
      process.exit(0);
    }

    console.log(`[smoke] anon value (first 60 chars) = ${anonClass.value.substring(0, 60)}...`);
    console.log(`[smoke] anon value length = ${anonClass.value.length}`);

    const result = decryptPrivateZap({
      anonValue: anonClass.value,
      botSecretKey: botSk,
      outerZapRequest: outer,
    });

    if (!result.ok) {
      console.error(`[smoke] DECRYPT FAILED: ${result.reason} (${result.detail || ''})`);
      process.exit(1);
    }

    console.log('');
    console.log('[smoke] ✓ DECRYPT SUCCESS');
    console.log(`[smoke] real sender npub  = ${result.realSenderHex}`);
    console.log(`[smoke] inner event kind  = ${result.innerEvent.kind}`);
    console.log(`[smoke] inner event id    = ${result.innerEvent.id}`);
    if (result.innerEvent.content) {
      console.log(`[smoke] inner content     = ${result.innerEvent.content.substring(0, 200)}`);
    }
    console.log('');
    console.log('To rescue this credit to the real sender, hit:');
    console.log(`  POST /api/admin/nostr-bot/credit-orphan-zap`);
    console.log(`  body: { receiptId: "${row.receiptId}", targetNpubHex: "${result.realSenderHex}" }`);
    console.log('  (set dryRun: true first to preview)');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('[smoke] uncaught error:', err);
  process.exit(1);
});
