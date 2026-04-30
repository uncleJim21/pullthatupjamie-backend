const WebSocket = require('ws');
const { NostrMention } = require('../models/NostrMention');
const { getBotPubkeyHex } = require('./nostrBotIdentity');

/**
 * NostrMentionWatcher
 *
 * Polls a fixed set of relays for kind:1 short-text-notes that #p-tag
 * the bot's pubkey. New events are persisted to MongoDB as
 * `NostrMention` rows in `pending` status. The reply worker picks them
 * up from there.
 *
 * Idempotency: insertion races on `eventId` are absorbed via the
 * unique index — duplicates trigger E11000 which we treat as
 * "already seen".
 *
 * Cutoff strategy: on the first poll (or any poll where the DB has no
 * mentions yet), we ask for events from `now - LOOKBACK_SECONDS`.
 * Subsequent polls use `max(latest_mention.createdAt, now - LOOKBACK)`
 * so a brief outage doesn't silently miss mentions while still
 * bounding the work the relay has to do.
 *
 * The watcher ignores events authored by the bot itself.
 */

const RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
];

const LOOKBACK_SECONDS = 600; // 10 minutes — overlap window between polls
const RELAY_QUERY_TIMEOUT_MS = 12000; // wait at most this long for EOSE
const SUB_PREFIX = 'jb_mentions_';

class NostrMentionWatcher {
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
  }

  /**
   * Single poll cycle. Safe to call from cron.
   * Returns: { newCount, duplicateCount, totalUnique, since, relays }
   */
  async poll() {
    const botPubkey = getBotPubkeyHex();
    const now = Math.floor(Date.now() / 1000);
    const since = await this._computeSince(botPubkey, now);

    console.log(
      `[NostrMentionWatcher] Polling ${this.relays.length} relays for kind:1 mentions of ${botPubkey.substring(0, 12)}... since ${new Date(since * 1000).toISOString()} (${now - since}s window)`,
    );

    const results = await Promise.allSettled(
      this.relays.map((url) => this._queryRelay(url, botPubkey, since)),
    );

    // Dedupe by event id across relays
    const eventMap = new Map();
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        for (const ev of r.value) {
          if (!eventMap.has(ev.id)) eventMap.set(ev.id, ev);
        }
      }
    }
    const events = Array.from(eventMap.values());

    let newCount = 0;
    let duplicateCount = 0;
    let skippedSelf = 0;
    let invalid = 0;

    for (const ev of events) {
      if (!this._isPlausibleMentionEvent(ev, botPubkey)) {
        invalid++;
        continue;
      }
      if (ev.pubkey === botPubkey) {
        skippedSelf++;
        continue;
      }
      const inserted = await this._persistMention(ev);
      if (inserted === 'inserted') newCount++;
      else if (inserted === 'duplicate') duplicateCount++;
      else invalid++;
    }

    const summary = {
      newCount,
      duplicateCount,
      skippedSelf,
      invalid,
      totalUnique: events.length,
      since,
      relays: this.relays.length,
    };
    console.log(
      `[NostrMentionWatcher.metrics] new=${newCount} dup=${duplicateCount} self=${skippedSelf} invalid=${invalid} total=${events.length} relays=${this.relays.length}`,
    );
    return summary;
  }

  async _computeSince(botPubkey, now) {
    const latest = await NostrMention.findOne({})
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();

    const fallback = now - this.lookbackSeconds;
    if (!latest) return fallback;

    // Always overlap by lookback so a late-arriving event isn't lost.
    const overlap = now - this.lookbackSeconds;
    return Math.min(latest.createdAt, overlap);
  }

  /**
   * Quick structural validation. Full signature verification is
   * skipped here on purpose — the reply worker only acts on events
   * we've already persisted, and we've already filtered by pubkey at
   * relay-query time. If a malicious relay forges an event with a bad
   * sig we'll attempt to reply to a real npub which is not a security
   * issue (it just costs the bot one balance check).
   */
  _isPlausibleMentionEvent(ev, botPubkey) {
    if (!ev || typeof ev !== 'object') return false;
    if (ev.kind !== 1) return false;
    if (typeof ev.id !== 'string' || !/^[0-9a-f]{64}$/.test(ev.id)) return false;
    if (typeof ev.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(ev.pubkey)) return false;
    if (typeof ev.created_at !== 'number') return false;
    if (typeof ev.content !== 'string') return false;
    if (!Array.isArray(ev.tags)) return false;
    const pTags = ev.tags.filter((t) => Array.isArray(t) && t[0] === 'p');
    return pTags.some((t) => t[1] === botPubkey);
  }

  async _persistMention(ev) {
    try {
      await NostrMention.create({
        eventId: ev.id,
        authorPubkey: ev.pubkey,
        content: ev.content,
        createdAt: ev.created_at,
        raw: ev,
        status: 'pending',
      });
      return 'inserted';
    } catch (err) {
      if (err && err.code === 11000) return 'duplicate';
      console.error(`[NostrMentionWatcher] Failed to persist event ${ev.id}:`, err.message);
      return 'error';
    }
  }

  /**
   * Open a single relay, send REQ filter, collect EVENTs until EOSE
   * (or timeout), then close.
   */
  _queryRelay(relayUrl, botPubkey, since) {
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
          `[NostrMentionWatcher] Timeout querying ${relayUrl}, returning ${events.length} events`,
        );
        finish();
      }, this.queryTimeoutMs);

      try {
        socket = new WebSocket(relayUrl);
      } catch (err) {
        console.error(`[NostrMentionWatcher] Failed to construct WS for ${relayUrl}:`, err.message);
        return finish();
      }

      socket.onopen = () => {
        const subId = SUB_PREFIX + Math.random().toString(36).substring(2, 10);
        const filter = {
          kinds: [1],
          '#p': [botPubkey],
          since,
        };
        try {
          socket.send(JSON.stringify(['REQ', subId, filter]));
        } catch (err) {
          console.error(`[NostrMentionWatcher] Failed to send REQ to ${relayUrl}:`, err.message);
          finish();
        }
      };

      socket.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (!Array.isArray(data)) return;
          if (data[0] === 'EVENT' && data[2]) {
            events.push(data[2]);
          } else if (data[0] === 'EOSE') {
            finish();
          } else if (data[0] === 'NOTICE') {
            // Some relays NOTICE us on bad subs; ignore.
          } else if (data[0] === 'CLOSED') {
            finish();
          }
        } catch (_) {
          // ignore parse errors
        }
      };

      socket.onerror = () => finish();
      socket.onclose = () => finish();
    });
  }
}

module.exports = NostrMentionWatcher;
module.exports.NOSTR_BOT_RELAYS = RELAYS;
