const mongoose = require('mongoose');

/**
 * NostrMention
 *
 * One document per kind:1 Nostr event that #p-tags the bot's pubkey.
 * The mention watcher inserts these as `pending`; the reply worker
 * claims and processes them, transitioning to `processing` then to
 * `replied` / `insufficient_balance` / `failed` / `ignored`.
 *
 * Idempotency: `eventId` is the Nostr event id (64-char hex). Unique
 * across all relays since the event id is the sha256 hash of the
 * canonical event serialization.
 *
 * TTL: replied/insufficient_balance/ignored docs are evicted 30 days
 * after `processedAt` to keep the collection bounded. Failed docs are
 * kept indefinitely for triage.
 */
const STATUSES = [
  'pending',
  'processing',
  'replied',
  'insufficient_balance',
  'failed',
  'ignored',
];

const nostrMentionSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    authorPubkey: { type: String, required: true, index: true }, // hex
    content: { type: String, required: true },
    createdAt: { type: Number, required: true, index: true }, // unix seconds (Nostr created_at)
    raw: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: STATUSES,
      default: 'pending',
      index: true,
    },
    replyEventId: { type: String, default: null },
    errorMessage: { type: String, default: null },
    attemptCount: { type: Number, default: 0 },
    processedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

// Bound the collection: clean up resolved docs 30 days after they finished.
// Failed docs intentionally have no TTL so we can review them.
nostrMentionSchema.index(
  { processedAt: 1 },
  {
    expireAfterSeconds: 30 * 24 * 3600,
    partialFilterExpression: {
      status: { $in: ['replied', 'insufficient_balance', 'ignored'] },
    },
    name: 'processedAt_ttl_resolved_only',
  },
);

const NostrMention = mongoose.model('NostrMention', nostrMentionSchema);

module.exports = { NostrMention, NOSTR_MENTION_STATUSES: STATUSES };
