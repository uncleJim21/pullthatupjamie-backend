const mongoose = require('mongoose');

/**
 * NostrZapReceipt
 *
 * One document per validated NIP-57 kind:9735 zap receipt that
 * credits the bot's pubkey. Insertion is atomic and idempotent —
 * `receiptId` (the zap-receipt event id) is unique, and `bolt11` is
 * unique sparse, so even if two relays serve the same receipt with
 * different ids we won't double-credit the same invoice.
 *
 * The watcher inserts a row first (with `processed: false`), then
 * atomically `$inc`s the npub's `Entitlement.maxUsage`. If the
 * second step fails we keep the row with `processed: false` for
 * retry. If the row insert fails with E11000 we know we've already
 * credited and skip the rest.
 *
 * `senderNpubHex` is the *zapper's* identity (the user who sent the
 * payment). For NIP-57 receipts that's `description.pubkey` — the
 * pubkey of the kind:9734 zap request. We key entitlements by this
 * value.
 */
const nostrZapReceiptSchema = new mongoose.Schema(
  {
    receiptId: { type: String, required: true, unique: true, index: true }, // 9735 event.id
    bolt11: { type: String, required: true, unique: true, sparse: true }, // BOLT11 invoice string
    senderNpubHex: { type: String, required: true, index: true },
    recipientNpubHex: { type: String, required: true, index: true }, // bot pubkey
    amountMsat: { type: Number, required: true }, // millisats from invoice (or zap-request amount tag)
    amountSats: { type: Number, required: true },
    amountUsdMicro: { type: Number, required: true }, // microUSD credited to entitlement
    btcUsdRate: { type: Number, required: true },
    zapRequestEventId: { type: String, default: null }, // sha256 of canonical 9734
    zapperServicePubkey: { type: String, required: true }, // hex pubkey of zapper service
    receiptCreatedAt: { type: Number, required: true, index: true }, // unix seconds
    rawReceipt: { type: mongoose.Schema.Types.Mixed, required: true },
    rawZapRequest: { type: mongoose.Schema.Types.Mixed, default: null },
    processed: { type: Boolean, default: false, index: true },
    processedAt: { type: Date, default: null },
    notes: { type: String, default: null }, // human-readable trace if anything weird happened
  },
  { timestamps: true },
);

// TTL after 90 days based on receiptCreatedAt — bounded retention while
// still leaving plenty of time for triage. Convert seconds → ms when
// reading; expireAfterSeconds works on Date fields, so we use createdAt
// (Date) instead of receiptCreatedAt (number).
nostrZapReceiptSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 90 * 24 * 3600,
    name: 'createdAt_ttl_90d',
  },
);

const NostrZapReceipt = mongoose.model('NostrZapReceipt', nostrZapReceiptSchema);

module.exports = { NostrZapReceipt };
