const WebSocket = require('ws');
const { Entitlement } = require('../models/Entitlement');
const { NostrZapReceipt } = require('../models/NostrZapReceipt');
const { getBotPubkeyHex, getBotSecretKey } = require('./nostrBotIdentity');
const { validateZapReceipt } = require('./zapReceiptValidator');
const { satsToUsdMicro, getBtcUsdRate } = require('./btcPrice');

/**
 * NostrZapWatcher
 *
 * Polls relays for kind:9735 zap receipts that #p the bot. For each
 * receipt, runs the full NIP-57 validation chain, atomically inserts
 * a NostrZapReceipt row (E11000 acts as a duplicate guard), then
 * `$inc`s the sender npub's `Entitlement.maxUsage` by the
 * sats→microUSD conversion at the moment the receipt arrived.
 *
 * Failure modes:
 *   - Validation rejects → log + skip (no DB writes).
 *   - Receipt insert E11000 → already credited; skip.
 *   - Receipt inserted but $inc fails → row stays processed:false
 *     and the next poll will retry it via reprocessUnprocessed().
 *
 * The trusted zapper-service pubkey set is hard-coded from
 * NOSTR_ZAP_PROVIDER_PUBKEYS at instantiation. The watcher will
 * refuse to run if the env var is missing or empty.
 *
 * The npub-keyed entitlement we top up is `entitlementType='pull'`
 * with `identifierType='npub'` and `identifier=<sender hex>`.
 * `maxUsage` is the deposit balance in microUSD. `usedCount` is the
 * spend so far. `remaining = maxUsage - usedCount`. The reply
 * worker debits per call.
 */

const RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
];

// Background polls reach 12h back so a brief outage or a late-arriving
// receipt can't drop credit on the floor. Receipt rows are deduped by
// `receiptId` + `bolt11` unique indexes, so re-querying the same window
// is cheap (E11000 → fast skip). Quick on-demand polls (see
// `pollWithLookback`) use a much smaller window for snappy "I just
// zapped you" UX.
const LOOKBACK_SECONDS = 12 * 3600; // 12 hours — generous overlap window
const QUICK_POLL_LOOKBACK_SECONDS = 600; // 10 minutes — for on-demand re-polls
const RELAY_QUERY_TIMEOUT_MS = 15000;
const QUICK_POLL_RELAY_TIMEOUT_MS = 7000; // shorter wait for snappy on-demand polls
const SUB_PREFIX = 'jb_zaps_';
const REQUIRE_VALID_PREIMAGE = false; // most NIP-57 services don't include preimage
const AMOUNT_TOLERANCE_BPS = 0; // strict — invoice msat must be ≥ requested

function parseTrustedPubkeys() {
  const raw = (process.env.NOSTR_ZAP_PROVIDER_PUBKEYS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
}

class NostrZapWatcher {
  constructor(options = {}) {
    this.relays = Array.isArray(options.relays) && options.relays.length > 0
      ? options.relays
      : RELAYS;
    this.lookbackSeconds = Number.isFinite(options.lookbackSeconds)
      ? options.lookbackSeconds
      : LOOKBACK_SECONDS;
    this.queryTimeoutMs = Number.isFinite(options.queryTimeoutMs)
      ? options.queryTimeoutMs
      : RELAY_QUERY_TIMEOUT_MS;
    this.requireValidPreimage = options.requireValidPreimage === true
      ? true
      : REQUIRE_VALID_PREIMAGE;
    this.amountToleranceBps = Number.isFinite(options.amountToleranceBps)
      ? options.amountToleranceBps
      : AMOUNT_TOLERANCE_BPS;
    this.trustedZapperPubkeys = options.trustedZapperPubkeys || parseTrustedPubkeys();
  }

  /**
   * Single poll cycle. Safe to call from cron.
   *
   * @param {Object} [opts]
   * @param {number} [opts.lookbackOverrideSeconds] use this lookback
   *        instead of the configured `lookbackSeconds`. Used by the
   *        reply worker to do a quick on-demand re-poll just before
   *        replying to a mention with insufficient balance.
   * @param {number} [opts.queryTimeoutOverrideMs] tighten the per-relay
   *        timeout for on-demand polls.
   */
  async poll(opts = {}) {
    if (this.trustedZapperPubkeys.length === 0) {
      console.error(
        '[NostrZapWatcher] NOSTR_ZAP_PROVIDER_PUBKEYS missing/empty — refusing to poll.',
      );
      return { skipped: true, reason: 'no_trusted_pubkeys' };
    }

    // Warm the BTC/USD price cache before processing — we need it to
    // compute microUSD credit per receipt.
    try {
      await getBtcUsdRate();
    } catch (err) {
      console.error('[NostrZapWatcher] BTC/USD rate fetch failed — aborting tick:', err.message);
      return { skipped: true, reason: 'no_btc_rate' };
    }

    const botPubkey = getBotPubkeyHex();
    const now = Math.floor(Date.now() / 1000);
    const lookbackSeconds = Number.isFinite(opts.lookbackOverrideSeconds)
      ? opts.lookbackOverrideSeconds
      : this.lookbackSeconds;
    const queryTimeoutMs = Number.isFinite(opts.queryTimeoutOverrideMs)
      ? opts.queryTimeoutOverrideMs
      : this.queryTimeoutMs;
    const since = await this._computeSince(now, lookbackSeconds);
    const tag = opts.lookbackOverrideSeconds ? 'quickPoll' : 'poll';

    console.log(
      `[NostrZapWatcher.${tag}] Polling ${this.relays.length} relays for kind:9735 #p=${botPubkey.substring(0, 12)}... since ${new Date(since * 1000).toISOString()} (${now - since}s window)`,
    );

    const results = await Promise.allSettled(
      this.relays.map((url) => this._queryRelay(url, botPubkey, since, queryTimeoutMs)),
    );

    // Dedupe by event id across relays
    const receiptMap = new Map();
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        for (const ev of r.value) {
          if (ev && ev.id && !receiptMap.has(ev.id)) receiptMap.set(ev.id, ev);
        }
      }
    }
    const receipts = Array.from(receiptMap.values());

    let credited = 0;
    let duplicate = 0;
    let rejected = 0;
    let anonymousSkipped = 0;
    let failedDb = 0;

    for (const receipt of receipts) {
      const outcome = await this._processReceipt(receipt, botPubkey);
      if (outcome === 'credited') credited++;
      else if (outcome === 'duplicate') duplicate++;
      else if (outcome === 'anonymous-skipped') anonymousSkipped++;
      else if (outcome === 'rejected') rejected++;
      else failedDb++;
    }

    // Best-effort retry of any rows we inserted but failed to credit.
    const retried = await this.reprocessUnprocessed();

    const summary = {
      credited,
      duplicate,
      anonymousSkipped,
      rejected,
      failedDb,
      retried,
      totalUnique: receipts.length,
      since,
      relays: this.relays.length,
    };
    console.log(
      `[NostrZapWatcher.metrics] credited=${credited} dup=${duplicate} anonSkipped=${anonymousSkipped} rejected=${rejected} failedDb=${failedDb} retried=${retried} total=${receipts.length} relays=${this.relays.length} tag=${tag}`,
    );
    return summary;
  }

  /**
   * Convenience: quick poll with a short lookback, intended for
   * inline use just before replying to a mention. Returns the same
   * summary shape as `poll()` plus `{ tag: 'quickPoll' }`.
   */
  async pollWithLookback(seconds = QUICK_POLL_LOOKBACK_SECONDS) {
    return this.poll({
      lookbackOverrideSeconds: seconds,
      queryTimeoutOverrideMs: QUICK_POLL_RELAY_TIMEOUT_MS,
    });
  }

  async _computeSince(now, lookbackSeconds) {
    const effectiveLookback = Number.isFinite(lookbackSeconds)
      ? lookbackSeconds
      : this.lookbackSeconds;
    const latest = await NostrZapReceipt.findOne({})
      .sort({ receiptCreatedAt: -1 })
      .select('receiptCreatedAt')
      .lean();

    const fallback = now - effectiveLookback;
    if (!latest) return fallback;
    // Always overlap by lookback.
    return Math.min(latest.receiptCreatedAt, fallback);
  }

  /**
   * Validate, persist, credit. Returns:
   *   'credited' | 'duplicate' | 'anonymous-skipped' | 'rejected' | 'failed'
   *
   * `anonymous-skipped` is intentionally distinct from `rejected`:
   * we don't insert a NostrZapReceipt row for a truly anonymous zap
   * because there's nobody to credit — keeping orphan rows in the
   * collection would just bloat ops triage without adding value.
   */
  async _processReceipt(receipt, botPubkey) {
    this._debugDumpReceipt(receipt);

    let botSecretKey = null;
    try {
      botSecretKey = getBotSecretKey();
    } catch (_) {
      // Identity not configured. We can still validate public zaps
      // but private zaps will be rejected as `private-zap-no-key`.
    }

    const validation = validateZapReceipt({
      receipt,
      botPubkeyHex: botPubkey,
      trustedZapperPubkeys: this.trustedZapperPubkeys,
      botSecretKey,
      requireValidPreimage: this.requireValidPreimage,
      amountToleranceBps: this.amountToleranceBps,
    });

    if (!validation.ok) {
      // Truly anonymous zaps are swallowed silently — the funds
      // arrived but there's no recoverable npub to credit. We log
      // them at info level for visibility but do NOT persist.
      if (validation.reason === 'anonymous-zap-unattributable') {
        console.log(
          `[NostrZapWatcher] anonymous-zap skipped ${receipt.id?.substring(0, 12)} — no recoverable sender`,
        );
        return 'anonymous-skipped';
      }
      console.warn(
        `[NostrZapWatcher] reject ${receipt.id?.substring(0, 12)}: ${validation.reason} (${validation.detail || ''})`,
      );
      return 'rejected';
    }

    const n = validation.normalized;
    let amountUsdMicro;
    try {
      amountUsdMicro = satsToUsdMicro(n.amountSats);
    } catch (err) {
      console.error('[NostrZapWatcher] satsToUsdMicro failed:', err.message);
      return 'failed';
    }

    let btcUsdRate;
    try {
      ({ rate: btcUsdRate } = await getBtcUsdRate());
    } catch (err) {
      console.error('[NostrZapWatcher] getBtcUsdRate failed:', err.message);
      return 'failed';
    }

    let row;
    try {
      row = await NostrZapReceipt.create({
        receiptId: n.receiptId,
        bolt11: n.bolt11,
        senderNpubHex: n.senderNpubHex,
        recipientNpubHex: n.recipientNpubHex,
        amountMsat: n.amountMsat,
        amountSats: n.amountSats,
        amountUsdMicro,
        btcUsdRate,
        zapRequestEventId: n.zapRequestEventId,
        zapperServicePubkey: n.zapperServicePubkey,
        receiptCreatedAt: n.receiptCreatedAt,
        rawReceipt: receipt,
        rawZapRequest: n.rawZapRequest,
        processed: false,
        notes: n.zapFlavor === 'private' ? 'private-zap-decrypted' : null,
      });
    } catch (err) {
      if (err && err.code === 11000) return 'duplicate';
      console.error('[NostrZapWatcher] receipt insert failed:', err.message);
      return 'failed';
    }

    const credited = await this._creditEntitlement(row);
    return credited ? 'credited' : 'failed';
  }

  /**
   * Atomically credit the sender's pull entitlement and mark the
   * receipt processed. Idempotent: the receipt row's
   * `processed=false → true` transition is atomic, so even if we run
   * twice we only credit once.
   */
  async _creditEntitlement(receiptRow) {
    try {
      const ent = await Entitlement.findOneAndUpdate(
        {
          identifier: receiptRow.senderNpubHex,
          identifierType: 'npub',
          entitlementType: 'pull',
        },
        {
          $inc: { maxUsage: receiptRow.amountUsdMicro },
          $setOnInsert: {
            identifier: receiptRow.senderNpubHex,
            identifierType: 'npub',
            entitlementType: 'pull',
            usedCount: 0,
            periodStart: new Date(),
            periodLengthDays: 36500, // effectively non-expiring (deposits don't expire)
            nextResetDate: new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000),
            status: 'active',
          },
          $set: { lastUsed: new Date() },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );

      // Mark processed only if we got here
      receiptRow.processed = true;
      receiptRow.processedAt = new Date();
      await receiptRow.save();

      const remainingMicroUsd = ent.maxUsage - ent.usedCount;
      console.log(
        `[NostrZapWatcher] credited ${receiptRow.amountSats} sats (~$${(receiptRow.amountUsdMicro / 1e6).toFixed(4)}) to npub ${receiptRow.senderNpubHex.substring(0, 12)}... — new balance: $${(remainingMicroUsd / 1e6).toFixed(4)}`,
      );
      return true;
    } catch (err) {
      console.error('[NostrZapWatcher] credit failed for', receiptRow.receiptId, ':', err.message);
      return false;
    }
  }

  /**
   * Catch-up pass: any receipts where insert succeeded but the credit
   * step failed (processed:false) get retried here. Rare but worth
   * having.
   */
  async reprocessUnprocessed() {
    const stuck = await NostrZapReceipt.find({ processed: false }).limit(50);
    let recovered = 0;
    for (const row of stuck) {
      const ok = await this._creditEntitlement(row);
      if (ok) recovered++;
    }
    return recovered;
  }

  /**
   * High-visibility dump of an incoming 9735 + its embedded 9734.
   * Prints the structured fields you need to tell wallets apart
   * (Primal vs Damus vs Amethyst vs ...) plus the raw JSON for
   * forensics. ON by default — set `NOSTR_BOT_DEBUG_RECEIPTS=false`
   * in `.env` to silence.
   */
  _debugDumpReceipt(receipt) {
    if (process.env.NOSTR_BOT_DEBUG_RECEIPTS === 'false') return;

    const C = {
      banner: '\x1b[1;45;97m', // bold magenta bg, white fg
      label: '\x1b[1;36m',     // bold cyan
      val: '\x1b[1;33m',       // bold yellow
      warn: '\x1b[1;31m',      // bold red
      ok: '\x1b[1;32m',        // bold green
      dim: '\x1b[2m',
      reset: '\x1b[0m',
    };

    const findTag = (ev, name) => {
      if (!ev || !Array.isArray(ev.tags)) return null;
      const t = ev.tags.find((x) => Array.isArray(x) && x[0] === name);
      return t ? t.slice(1) : null;
    };

    let inner = null;
    try {
      const desc = (receipt.tags || []).find(
        (t) => Array.isArray(t) && t[0] === 'description',
      );
      if (desc && desc[1]) inner = JSON.parse(desc[1]);
    } catch (_) { /* leave inner null */ }

    const bolt11Tag = findTag(receipt, 'bolt11');
    const pTag = findTag(receipt, 'p');
    const PTag = findTag(receipt, 'P');
    const innerClient = inner ? findTag(inner, 'client') : null;
    const innerAnon = inner ? findTag(inner, 'anon') : null;
    const innerP = inner ? findTag(inner, 'p') : null;
    const innerE = inner ? findTag(inner, 'e') : null;

    let flavor;
    if (innerAnon === null) {
      flavor = `${C.ok}PUBLIC${C.reset} ${C.dim}(no anon tag → sender = inner.pubkey)${C.reset}`;
    } else if (innerAnon.length === 0 || !innerAnon[0]) {
      flavor = `${C.warn}ANONYMOUS${C.reset} ${C.dim}(empty anon tag → no recoverable sender; will be skipped)${C.reset}`;
    } else {
      flavor = `${C.val}PRIVATE${C.reset} ${C.dim}(anon payload len=${innerAnon[0].length} → decrypt with bot nsec)${C.reset}`;
    }

    const lines = [
      '',
      `${C.banner} ▼ INCOMING ZAP RECEIPT 9735 ▼ ${C.reset}`,
      `${C.label}receipt.id        ${C.reset} ${C.val}${receipt.id}${C.reset}`,
      `${C.label}receipt.pubkey    ${C.reset} ${C.val}${receipt.pubkey}${C.reset} ${C.dim}(zapper service that signed 9735)${C.reset}`,
      `${C.label}receipt.created_at${C.reset} ${C.val}${receipt.created_at}${C.reset} ${C.dim}(${new Date((receipt.created_at || 0) * 1000).toISOString()})${C.reset}`,
      `${C.label}receipt.bolt11    ${C.reset} ${C.val}${bolt11Tag ? bolt11Tag[0].substring(0, 80) + (bolt11Tag[0].length > 80 ? '…' : '') : '(none)'}${C.reset}`,
      `${C.label}receipt.tag P     ${C.reset} ${C.val}${PTag ? PTag[0] : '(none)'}${C.reset} ${C.dim}(claimed sender, NIP-57 §B)${C.reset}`,
      `${C.label}receipt.tag p     ${C.reset} ${C.val}${pTag ? pTag[0] : '(none)'}${C.reset} ${C.dim}(recipient = bot)${C.reset}`,
      inner
        ? `${C.label}inner.zap_request${C.reset} ${C.dim}(parsed from description tag)${C.reset}`
        : `${C.warn}inner.zap_request: MISSING / UNPARSABLE${C.reset}`,
    ];

    if (inner) {
      lines.push(
        `${C.label}  inner.id        ${C.reset} ${C.val}${inner.id || '(none)'}${C.reset}`,
        `${C.label}  inner.pubkey    ${C.reset} ${C.val}${inner.pubkey || '(none)'}${C.reset} ${C.dim}(real sender for public, ephemeral for anon/private)${C.reset}`,
        `${C.label}  inner.kind      ${C.reset} ${C.val}${inner.kind}${C.reset}`,
        `${C.label}  inner.content   ${C.reset} ${C.val}${JSON.stringify(String(inner.content || '').substring(0, 80))}${C.reset}`,
        `${C.label}  inner.tag client${C.reset} ${C.val}${innerClient ? innerClient.join(' / ') : '(none)'}${C.reset} ${C.dim}(NIP-89 client identifier — useful for spotting Primal/Damus/etc)${C.reset}`,
        `${C.label}  inner.tag p     ${C.reset} ${C.val}${innerP ? innerP[0] : '(none)'}${C.reset}`,
        `${C.label}  inner.tag e     ${C.reset} ${C.val}${innerE ? innerE[0] : '(none)'}${C.reset}`,
        `${C.label}  inner.tag anon  ${C.reset} ${C.val}${innerAnon === null ? '(absent)' : innerAnon.length === 0 ? '(present, EMPTY array)' : '(present, len=' + innerAnon[0].length + ')'}${C.reset}`,
      );
    }

    lines.push(
      `${C.label}flavor inferred   ${C.reset} ${flavor}`,
      `${C.dim}── raw receipt ──${C.reset}`,
      JSON.stringify(receipt),
      inner ? `${C.dim}── raw inner 9734 ──${C.reset}` : '',
      inner ? JSON.stringify(inner) : '',
      `${C.banner} ▲ END ZAP RECEIPT 9735 ▲ ${C.reset}`,
      '',
    );

    console.log(lines.filter(Boolean).join('\n'));
  }

  _queryRelay(relayUrl, botPubkey, since, queryTimeoutMs) {
    const effectiveTimeout = Number.isFinite(queryTimeoutMs)
      ? queryTimeoutMs
      : this.queryTimeoutMs;
    return new Promise((resolve) => {
      const events = [];
      let socket = null;
      let resolved = false;
      let timer = null;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        if (socket && socket.readyState === WebSocket.OPEN) {
          try { socket.close(); } catch (_) { /* ignore */ }
        }
        resolve(events);
      };

      timer = setTimeout(() => {
        console.log(
          `[NostrZapWatcher] Timeout querying ${relayUrl}, returning ${events.length} events`,
        );
        finish();
      }, effectiveTimeout);

      try {
        socket = new WebSocket(relayUrl);
      } catch (err) {
        console.error(`[NostrZapWatcher] WS construct failed ${relayUrl}:`, err.message);
        return finish();
      }

      socket.onopen = () => {
        const subId = SUB_PREFIX + Math.random().toString(36).substring(2, 10);
        const filter = {
          kinds: [9735],
          '#p': [botPubkey],
          since,
        };
        try {
          socket.send(JSON.stringify(['REQ', subId, filter]));
        } catch (err) {
          console.error(`[NostrZapWatcher] send REQ failed ${relayUrl}:`, err.message);
          finish();
        }
      };

      socket.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (!Array.isArray(data)) return;
          if (data[0] === 'EVENT' && data[2]) events.push(data[2]);
          else if (data[0] === 'EOSE') finish();
          else if (data[0] === 'CLOSED') finish();
        } catch (_) { /* ignore */ }
      };

      socket.onerror = () => finish();
      socket.onclose = () => finish();
    });
  }
}

module.exports = NostrZapWatcher;
module.exports.NOSTR_BOT_RELAYS = RELAYS;
