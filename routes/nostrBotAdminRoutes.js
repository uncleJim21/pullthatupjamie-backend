/**
 * Nostr Bot Admin Routes (HMAC-protected)
 *
 * Mounted at /api/admin/nostr-bot via serviceHmac with scope
 * `nostr-bot:admin`. All endpoints require a valid HMAC signature
 * from a trusted client (no public access). Use these for ops
 * triage, manual recovery, and balance lookups.
 *
 *   GET  /status                       — bot identity + queue counts + cron flags
 *   GET  /balance/:npubHex             — npub-keyed pull entitlement
 *   POST /reprocess/zap-receipts       — re-credit any processed:false receipts
 *   POST /requeue/:eventId             — bump a failed mention back to pending
 *   GET  /mentions/recent              — last 25 mentions across all statuses
 *   POST /credit-orphan-zap            — manually move credit from a misattributed
 *                                        zap receipt to a target npub (rescue path
 *                                        for receipts that were credited to an
 *                                        ephemeral key before private-zap support
 *                                        landed, or for any future debugging case)
 *
 * The bot's identity is loaded lazily so missing env vars fail
 * loudly only when the endpoint is hit (not at server start).
 */

const express = require('express');
const { NostrMention } = require('../models/NostrMention');
const { NostrZapReceipt } = require('../models/NostrZapReceipt');
const { Entitlement } = require('../models/Entitlement');

const HEX64 = /^[0-9a-f]{64}$/i;

function buildRouter() {
  const router = express.Router();

  router.get('/status', async (req, res) => {
    try {
      const { getBotPubkeyHex, getBotNpub, getBotLnAddress, isBotEnabled } = require('../utils/nostrBotIdentity');
      const counts = await NostrMention.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      const byStatus = {};
      for (const c of counts) byStatus[c._id] = c.count;
      const totalReceipts = await NostrZapReceipt.estimatedDocumentCount();
      const unprocessed = await NostrZapReceipt.countDocuments({ processed: false });
      const totalEntitlements = await Entitlement.countDocuments({ identifierType: 'npub', entitlementType: 'pull' });
      res.json({
        enabled: isBotEnabled(),
        npub: getBotNpub(),
        pubkeyHex: getBotPubkeyHex(),
        lnAddress: getBotLnAddress(),
        mentions: byStatus,
        zapReceipts: { total: totalReceipts, unprocessed },
        npubEntitlements: totalEntitlements,
        trustedZapperPubkeys: (process.env.NOSTR_ZAP_PROVIDER_PUBKEYS || '').split(',').filter(Boolean).length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/balance/:npubHex', async (req, res) => {
    const npubHex = String(req.params.npubHex || '').toLowerCase().trim();
    if (!HEX64.test(npubHex)) {
      return res.status(400).json({ error: 'npubHex must be 64-char hex' });
    }
    try {
      const ent = await Entitlement.findOne({
        identifier: npubHex,
        identifierType: 'npub',
        entitlementType: 'pull',
      }).lean();
      if (!ent) return res.json({ npubHex, balance: { microUsd: 0, usd: 0 }, totalDeposited: { microUsd: 0, usd: 0 }, totalSpent: { microUsd: 0, usd: 0 } });
      const remaining = ent.maxUsage - ent.usedCount;
      res.json({
        npubHex,
        balance: { microUsd: remaining, usd: remaining / 1e6 },
        totalDeposited: { microUsd: ent.maxUsage, usd: ent.maxUsage / 1e6 },
        totalSpent: { microUsd: ent.usedCount, usd: ent.usedCount / 1e6 },
        lastUsed: ent.lastUsed,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/reprocess/zap-receipts', async (req, res) => {
    try {
      const NostrZapWatcher = require('../utils/NostrZapWatcher');
      const w = new NostrZapWatcher();
      const recovered = await w.reprocessUnprocessed();
      res.json({ recovered });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/requeue/:eventId', async (req, res) => {
    const eventId = String(req.params.eventId || '').toLowerCase().trim();
    if (!HEX64.test(eventId)) {
      return res.status(400).json({ error: 'eventId must be 64-char hex' });
    }
    try {
      const m = await NostrMention.findOneAndUpdate(
        { eventId, status: { $in: ['failed', 'ignored'] } },
        { $set: { status: 'pending', errorMessage: null, processedAt: null }, $inc: { attemptCount: 0 } },
        { new: true },
      );
      if (!m) return res.status(404).json({ error: 'no failed/ignored mention with that id' });
      res.json({ ok: true, mention: { id: m._id, status: m.status } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /credit-orphan-zap
   * body: { receiptId: '<64-hex>', targetNpubHex: '<64-hex>', dryRun?: boolean }
   *
   * Rescues a zap receipt whose credit landed on the wrong npub
   * (e.g., an ephemeral key from a private zap predating
   * private-zap-decrypt support, or any other misattribution we
   * uncover during ops triage).
   *
   * Mechanics, atomic where possible:
   *   1. Look up the receipt by id. Reject if missing OR processed=false
   *      (an unprocessed row should be retried via the normal
   *      reprocess endpoint, not rescued).
   *   2. Debit the original sender's pull entitlement by
   *      `amountUsdMicro` (capped at their current balance to avoid
   *      negative balances if they've already spent some of it).
   *   3. Credit the target npub's pull entitlement by the same amount,
   *      upserting if the entitlement doesn't exist yet.
   *   4. Stamp the receipt's `senderNpubHex` to the new target and
   *      append a note describing the rescue.
   *
   * `dryRun: true` returns the planned changes without applying them.
   */
  router.post('/credit-orphan-zap', async (req, res) => {
    const body = req.body || {};
    const receiptId = String(body.receiptId || '').toLowerCase().trim();
    const targetNpubHex = String(body.targetNpubHex || '').toLowerCase().trim();
    const dryRun = body.dryRun === true;

    if (!HEX64.test(receiptId)) {
      return res.status(400).json({ error: 'receiptId must be 64-char hex' });
    }
    if (!HEX64.test(targetNpubHex)) {
      return res.status(400).json({ error: 'targetNpubHex must be 64-char hex' });
    }

    try {
      const receipt = await NostrZapReceipt.findOne({ receiptId });
      if (!receipt) {
        return res.status(404).json({ error: 'no zap receipt with that id' });
      }
      if (!receipt.processed) {
        return res.status(409).json({
          error: 'receipt is not yet credited; use POST /reprocess/zap-receipts instead',
        });
      }
      if (receipt.senderNpubHex.toLowerCase() === targetNpubHex) {
        return res.status(409).json({
          error: 'receipt already credited to that npub — no rescue needed',
        });
      }
      const amountMicroUsd = receipt.amountUsdMicro;
      if (!Number.isFinite(amountMicroUsd) || amountMicroUsd <= 0) {
        return res.status(409).json({
          error: `receipt has invalid amountUsdMicro: ${amountMicroUsd}`,
        });
      }

      // Look at original sender's current balance to compute a
      // safe debit. We never let usedCount exceed maxUsage (would
      // produce a negative balance), so cap the debit if the user
      // has already spent some of it.
      const fromEnt = await Entitlement.findOne({
        identifier: receipt.senderNpubHex,
        identifierType: 'npub',
        entitlementType: 'pull',
      });
      const fromAvailable = fromEnt ? Math.max(0, fromEnt.maxUsage - fromEnt.usedCount) : 0;
      const debitAmount = Math.min(amountMicroUsd, fromAvailable);

      const plan = {
        receiptId,
        from: {
          npubHex: receipt.senderNpubHex,
          beforeBalanceMicroUsd: fromAvailable,
          plannedDebitMicroUsd: debitAmount,
        },
        to: {
          npubHex: targetNpubHex,
          plannedCreditMicroUsd: amountMicroUsd,
        },
        amountSats: receipt.amountSats,
        dryRun,
      };

      if (dryRun) {
        return res.json({ ok: true, dryRun: true, plan });
      }

      // 1. Debit the original sender (decrement maxUsage instead of
      //    incrementing usedCount — keeps "totalDeposited" semantics
      //    of maxUsage clean: it represents "what they have on
      //    deposit", not "what they've ever deposited minus
      //    transfers out").
      if (fromEnt && debitAmount > 0) {
        await Entitlement.findByIdAndUpdate(fromEnt._id, {
          $inc: { maxUsage: -debitAmount },
          $set: { lastUsed: new Date() },
        });
      }

      // 2. Credit the target.
      const toEnt = await Entitlement.findOneAndUpdate(
        {
          identifier: targetNpubHex,
          identifierType: 'npub',
          entitlementType: 'pull',
        },
        {
          $inc: { maxUsage: amountMicroUsd },
          $setOnInsert: {
            identifier: targetNpubHex,
            identifierType: 'npub',
            entitlementType: 'pull',
            usedCount: 0,
            periodStart: new Date(),
            periodLengthDays: 36500,
            nextResetDate: new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000),
            status: 'active',
          },
          $set: { lastUsed: new Date() },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );

      // 3. Stamp the receipt for audit trail.
      const noteFragment = `rescued ${(amountMicroUsd / 1e6).toFixed(4)} USD: ${receipt.senderNpubHex.substring(0, 12)}... → ${targetNpubHex.substring(0, 12)}...`;
      const newNotes = receipt.notes ? `${receipt.notes}; ${noteFragment}` : noteFragment;
      receipt.notes = newNotes.substring(0, 500);
      receipt.senderNpubHex = targetNpubHex;
      await receipt.save();

      const newBalance = toEnt ? toEnt.maxUsage - toEnt.usedCount : 0;
      console.log(
        `[NostrBotAdmin] credit-orphan-zap rescued $${(amountMicroUsd / 1e6).toFixed(4)} from ${plan.from.npubHex.substring(0, 12)}... to ${targetNpubHex.substring(0, 12)}... (new balance: $${(newBalance / 1e6).toFixed(4)})`,
      );

      res.json({
        ok: true,
        dryRun: false,
        plan,
        result: {
          targetBalanceMicroUsd: newBalance,
          targetBalanceUsd: newBalance / 1e6,
        },
      });
    } catch (err) {
      console.error('[NostrBotAdmin] credit-orphan-zap error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/mentions/recent', async (req, res) => {
    try {
      const docs = await NostrMention.find({})
        .sort({ createdAt: -1 })
        .limit(25)
        .lean();
      res.json(docs.map((d) => ({
        eventId: d.eventId,
        author: d.authorPubkey,
        content: (d.content || '').substring(0, 140),
        createdAt: d.createdAt,
        status: d.status,
        replyEventId: d.replyEventId,
        errorMessage: d.errorMessage,
        attemptCount: d.attemptCount,
        processedAt: d.processedAt,
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = buildRouter;
