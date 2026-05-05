const { NostrMention } = require('../models/NostrMention');
const { Entitlement } = require('../models/Entitlement');
const { runPull } = require('../services/agentPullService');
const NostrService = require('./NostrService');
const NostrZapWatcher = require('./NostrZapWatcher');
const { buildReplyEvent, buildInsufficientBalanceReply } = require('./nostrReplyBuilder');
const { getBotPubkeyHex, getBotLnAddress } = require('./nostrBotIdentity');
const { getAgentCostMicroUsd } = require('../constants/agentPricing');
const { ENTITLEMENT_TYPES } = require('../constants/entitlementTypes');

/**
 * NostrBotReplyService
 *
 * Per-tick: scans `pending` NostrMention rows, atomically claims
 * one (status → processing), checks the author's npub-keyed pull
 * entitlement balance, and either:
 *
 *   (a) Runs the agent (`runPull`), debits the entitlement,
 *       publishes a NIP-10 reply, and marks the mention `replied`.
 *   (b) Posts a short "insufficient balance, zap to top up" reply
 *       and marks the mention `insufficient_balance`.
 *
 * Failures during runPull or relay publish bump `attemptCount` and
 * leave the mention in `failed` state for triage. Replies that
 * already published successfully are NOT re-attempted because the
 * status transition is the gate.
 *
 * Concurrency: the atomic findOneAndUpdate "claim" pattern
 * guarantees no two workers process the same mention. Designed to
 * be safe to run from multiple instances if we ever scale out.
 */

const DEFAULT_BATCH_SIZE = 10;
const MAX_ATTEMPTS_PER_MENTION = 3;
const MENTION_AGE_LIMIT_SECONDS = 24 * 3600; // ignore mentions older than 24h on first ingest
const RATE_LIMIT_WINDOW_SECONDS = 3600;        // 1h sliding window
const RATE_LIMIT_MAX_REPLIES_PER_NPUB = 30;    // per author per window
// Fast on-demand zap re-poll window (seconds). When the worker sees
// `balance < cost`, before sending the "you have no balance" reply
// we fire one short relay query for any zap receipts in the last
// FAST_ZAP_POLL_LOOKBACK_SECONDS to absorb the inevitable gap
// between "user zapped" and "background zap watcher noticed". 10
// minutes is generous for clock skew + relay propagation while
// keeping the on-demand poll cheap.
const FAST_ZAP_POLL_LOOKBACK_SECONDS = 600;

class NostrBotReplyService {
  constructor(options = {}) {
    this.batchSize = Number.isFinite(options.batchSize) ? options.batchSize : DEFAULT_BATCH_SIZE;
    this.nostrService = options.nostrService || new NostrService();
    // Lazy zap watcher used only for on-demand re-polls (not for
    // background polling). Configured the same way as the
    // background instance so it picks up NOSTR_ZAP_PROVIDER_PUBKEYS.
    this.zapWatcher = options.zapWatcher || new NostrZapWatcher();
  }

  /**
   * Run a single tick. Safe for cron.
   */
  async tick() {
    const summary = {
      claimed: 0,
      replied: 0,
      insufficientBalance: 0,
      ignored: 0,
      failed: 0,
    };

    for (let i = 0; i < this.batchSize; i++) {
      const mention = await this._claimNext();
      if (!mention) break;
      summary.claimed++;
      try {
        const outcome = await this._processOne(mention);
        if (outcome === 'replied') summary.replied++;
        else if (outcome === 'insufficient_balance') summary.insufficientBalance++;
        else if (outcome === 'ignored') summary.ignored++;
        else summary.failed++;
      } catch (err) {
        console.error('[NostrBotReply] tick error for', mention.eventId, err);
        await this._markFailed(mention, err.message || 'unknown');
        summary.failed++;
      }
    }

    if (summary.claimed > 0) {
      // Single structured log line for ops grep / log aggregation.
      console.log(
        `[NostrBotReply.metrics] claimed=${summary.claimed} replied=${summary.replied} insufficient=${summary.insufficientBalance} ignored=${summary.ignored} failed=${summary.failed}`,
      );
    }
    return summary;
  }

  /**
   * Atomically transition one pending mention to processing and
   * return it. Returns null if there are none left.
   */
  async _claimNext() {
    const cutoff = Math.floor(Date.now() / 1000) - MENTION_AGE_LIMIT_SECONDS;
    return NostrMention.findOneAndUpdate(
      { status: 'pending', createdAt: { $gte: cutoff } },
      { $set: { status: 'processing' }, $inc: { attemptCount: 1 } },
      { sort: { createdAt: 1 }, new: true },
    );
  }

  async _processOne(mention) {
    const botPubkey = getBotPubkeyHex();
    if (mention.authorPubkey === botPubkey) {
      // We never reply to ourselves. Defensive — the watcher already
      // skips these, but if one slipped in, ignore it cleanly.
      mention.status = 'ignored';
      mention.processedAt = new Date();
      mention.errorMessage = 'self-mention';
      await mention.save();
      return 'ignored';
    }

    // Per-npub rate limit. We count successful + insufficient replies
    // in the last RATE_LIMIT_WINDOW_SECONDS for this author. Failed
    // replies don't count (we don't penalize transient errors).
    const rlCutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_SECONDS * 1000);
    const recentCount = await NostrMention.countDocuments({
      authorPubkey: mention.authorPubkey,
      status: { $in: ['replied', 'insufficient_balance'] },
      processedAt: { $gte: rlCutoff },
    });
    if (recentCount >= RATE_LIMIT_MAX_REPLIES_PER_NPUB) {
      mention.status = 'ignored';
      mention.processedAt = new Date();
      mention.errorMessage = `rate-limited: ${recentCount} replies in ${RATE_LIMIT_WINDOW_SECONDS}s`;
      await mention.save();
      console.warn(
        `[NostrBotReply] rate-limited author ${mention.authorPubkey.substring(0, 12)}... (${recentCount} replies in last ${RATE_LIMIT_WINDOW_SECONDS}s)`,
      );
      return 'ignored';
    }

    const costMicroUsd = getAgentCostMicroUsd(ENTITLEMENT_TYPES.PULL);
    if (!Number.isFinite(costMicroUsd) || costMicroUsd <= 0) {
      throw new Error(`pull cost is misconfigured: ${costMicroUsd}`);
    }

    // Look up balance
    let entitlement = await Entitlement.findOne({
      identifier: mention.authorPubkey,
      identifierType: 'npub',
      entitlementType: 'pull',
    });

    let balance = entitlement ? entitlement.maxUsage - entitlement.usedCount : 0;

    // If the balance looks short, fire one fast on-demand zap poll
    // before giving up — the user may have just zapped and the
    // background watcher hasn't noticed yet. This kills the race
    // condition where "user zaps then immediately mentions" looks
    // like "no balance".
    if (balance < costMicroUsd) {
      console.log(
        `[NostrBotReply] balance short for ${mention.authorPubkey.substring(0, 12)}... — running fast on-demand zap poll`,
      );
      try {
        await this.zapWatcher.pollWithLookback(FAST_ZAP_POLL_LOOKBACK_SECONDS);
      } catch (err) {
        console.warn('[NostrBotReply] fast zap poll failed (continuing):', err.message);
      }
      entitlement = await Entitlement.findOne({
        identifier: mention.authorPubkey,
        identifierType: 'npub',
        entitlementType: 'pull',
      });
      balance = entitlement ? entitlement.maxUsage - entitlement.usedCount : 0;
    }

    if (balance < costMicroUsd) {
      return this._replyInsufficientBalance(mention, costMicroUsd, balance);
    }

    // Atomic debit. We do this BEFORE running the agent so a long
    // agent + a duplicate watcher tick can't double-spend.
    const debited = await Entitlement.findOneAndUpdate(
      {
        _id: entitlement._id,
        $expr: { $gte: [{ $subtract: ['$maxUsage', '$usedCount'] }, costMicroUsd] },
      },
      {
        $inc: { usedCount: costMicroUsd },
        $set: { lastUsed: new Date() },
      },
      { new: true },
    );
    if (!debited) {
      // Race lost — the balance dropped below cost between read and
      // write. Treat as insufficient balance.
      return this._replyInsufficientBalance(mention, costMicroUsd, balance);
    }

    // Run the agent. If it fails or times out, refund the debit and
    // mark failed so the user isn't charged.
    const userQuery = this._extractQueryText(mention);
    let result;
    try {
      result = await runPull({
        message: userQuery,
        identity: {
          tier: 'subscriber',
          identifier: mention.authorPubkey,
          identifierType: 'npub',
          user: null,
          provider: 'nostr',
          email: null,
        },
      });
    } catch (err) {
      await this._refund(entitlement._id, costMicroUsd);
      throw err;
    }

    if (!result || !result.ok) {
      await this._refund(entitlement._id, costMicroUsd);
      const errMsg = result && result.error ? result.error : 'agent failed';
      console.warn('[NostrBotReply] agent failed for', mention.eventId, errMsg);
      mention.status = 'failed';
      mention.processedAt = new Date();
      mention.errorMessage = errMsg;
      await mention.save();
      return 'failed';
    }

    // Build + sign + publish the reply
    let signedReply;
    try {
      signedReply = buildReplyEvent({
        mentionEvent: mention.raw,
        text: result.text,
      });
    } catch (err) {
      // Empty text after normalization, etc. Refund and fail.
      await this._refund(entitlement._id, costMicroUsd);
      mention.status = 'failed';
      mention.processedAt = new Date();
      mention.errorMessage = `build-reply: ${err.message}`;
      await mention.save();
      return 'failed';
    }

    const publish = await this.nostrService.postToNostr({ signedEvent: signedReply });
    if (!publish || !publish.success) {
      // Don't refund on publish failure — the agent did the work.
      // The reply was signed but no relay accepted it. Track for triage.
      const failMsg = publish && Array.isArray(publish.failedRelays) && publish.failedRelays.length > 0
        ? publish.failedRelays.map((f) => `${f.relay}:${f.error}`).join('; ')
        : 'unknown publish failure';
      mention.status = 'failed';
      mention.processedAt = new Date();
      mention.errorMessage = `publish-failed: ${failMsg.substring(0, 500)}`;
      mention.replyEventId = signedReply.id;
      await mention.save();
      console.error('[NostrBotReply] publish failed for', mention.eventId, failMsg);
      return 'failed';
    }

    mention.status = 'replied';
    mention.processedAt = new Date();
    mention.replyEventId = signedReply.id;
    await mention.save();
    console.log(
      `[NostrBotReply] replied to ${mention.eventId.substring(0, 12)}... → ${signedReply.id.substring(0, 12)}... published to ${publish.publishedRelays?.length || 0} relays`,
    );
    return 'replied';
  }

  async _replyInsufficientBalance(mention, costMicroUsd, balanceMicroUsd) {
    const lnAddress = getBotLnAddress();
    const costUsd = costMicroUsd / 1e6;
    const balanceUsd = balanceMicroUsd / 1e6;

    let signed;
    try {
      signed = buildInsufficientBalanceReply({
        mentionEvent: mention.raw,
        lnAddress,
        costUsd,
        balanceUsd,
      });
    } catch (err) {
      mention.status = 'failed';
      mention.processedAt = new Date();
      mention.errorMessage = `build-insufficient: ${err.message}`;
      await mention.save();
      return 'failed';
    }

    const publish = await this.nostrService.postToNostr({ signedEvent: signed });
    if (!publish || !publish.success) {
      mention.status = 'failed';
      mention.processedAt = new Date();
      mention.errorMessage = 'insufficient-balance reply failed to publish';
      mention.replyEventId = signed.id;
      await mention.save();
      return 'failed';
    }

    mention.status = 'insufficient_balance';
    mention.processedAt = new Date();
    mention.replyEventId = signed.id;
    await mention.save();
    console.log(
      `[NostrBotReply] insufficient-balance notice for ${mention.eventId.substring(0, 12)}... (balance=$${balanceUsd.toFixed(4)} < cost=$${costUsd.toFixed(2)})`,
    );
    return 'insufficient_balance';
  }

  async _refund(entitlementId, microUsd) {
    try {
      await Entitlement.findByIdAndUpdate(entitlementId, {
        $inc: { usedCount: -microUsd },
        $set: { lastUsed: new Date() },
      });
    } catch (err) {
      console.error('[NostrBotReply] refund failed:', err.message);
    }
  }

  async _markFailed(mention, errMsg) {
    try {
      mention.status = 'failed';
      mention.processedAt = new Date();
      mention.errorMessage = String(errMsg || '').substring(0, 500);
      await mention.save();
    } catch (err) {
      console.error('[NostrBotReply] _markFailed save error:', err.message);
    }
  }

  /**
   * Extract the user's query from the mention content. NIP-08-style
   * client-side mentions (`@npub1...`, `nostr:npub1...`) are
   * collapsed to just the bot's name placeholder so the agent
   * doesn't receive raw npub strings as part of its query.
   */
  _extractQueryText(mention) {
    let text = String(mention.content || '');
    // Strip nostr: URI mentions
    text = text.replace(/nostr:(npub|nprofile|nevent|note)1[a-z0-9]+/gi, ' ');
    // Strip `@npub1...`-style raw mentions
    text = text.replace(/@npub1[a-z0-9]+/gi, ' ');
    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) text = 'Hi Jamie!';
    return text;
  }
}

module.exports = NostrBotReplyService;
module.exports.MAX_ATTEMPTS_PER_MENTION = MAX_ATTEMPTS_PER_MENTION;
module.exports.RATE_LIMIT_WINDOW_SECONDS = RATE_LIMIT_WINDOW_SECONDS;
module.exports.RATE_LIMIT_MAX_REPLIES_PER_NPUB = RATE_LIMIT_MAX_REPLIES_PER_NPUB;
