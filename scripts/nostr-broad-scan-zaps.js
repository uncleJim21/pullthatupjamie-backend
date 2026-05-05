#!/usr/bin/env node
/**
 * Broad-scan many relays for kind:9735 zap receipts targeting the bot.
 *
 *   node scripts/nostr-broad-scan-zaps.js              # last 1 hour
 *   node scripts/nostr-broad-scan-zaps.js 6            # last 6 hours
 *   node scripts/nostr-broad-scan-zaps.js 1 016b0d...  # explicit bot pubkey
 *
 * Diagnoses "I sent a zap but it never showed up in the watcher debug
 * dump" by querying a much wider relay set than the in-process watcher
 * polls. The output tells you, per relay, how many receipts were
 * advertised in the lookback window, and at the bottom which relays
 * each unique receipt was found on.
 *
 * Read the SUMMARY block:
 *   - 0 receipts on any relay  → payment never produced a receipt
 *     (LNURL/NWC/wallet bug). Check the wallet's transaction history.
 *   - Receipts on relays we ALREADY poll (relay.primal.net etc.)
 *     → watcher should have caught it; investigate filter/timing.
 *   - Receipts on relays we DON'T poll → relay-set mismatch. Add
 *     those relays to `RELAYS` in `utils/NostrZapWatcher.js`.
 */

require('dotenv').config();
const WebSocket = require('ws');
const bolt11 = require('bolt11');
const crypto = require('crypto');

const POLLED_BY_WATCHER = new Set([
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
]);

const SCAN_RELAYS = [
  ...POLLED_BY_WATCHER,
  'wss://nostr.land',
  'wss://offchain.pub',
  'wss://nostrue.com',
  'wss://relay.snort.social',
  'wss://nostr.mom',
  'wss://relay.nostrplebs.com',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.bg',
  'wss://nostr.bitcoiner.social',
  'wss://relay.current.fyi',
  'wss://purplerelay.com',
  'wss://relay.nostr.com.au',
];

const RELAY_TIMEOUT_MS = 12000;

function getBotPubkey() {
  const fromArg = process.argv[3];
  if (fromArg && /^[0-9a-f]{64}$/i.test(fromArg)) return fromArg.toLowerCase();
  try {
    const { getBotPubkeyHex } = require('../utils/nostrBotIdentity');
    return getBotPubkeyHex();
  } catch (err) {
    console.error('Could not derive bot pubkey from JAMIE_BOT_NSEC_BECH32:', err.message);
    console.error('Pass the bot pubkey as 2nd CLI arg instead.');
    process.exit(1);
  }
}

function queryRelay(url, botPubkey, since) {
  return new Promise((resolve) => {
    const events = [];
    let resolved = false;
    let socket;
    let timer;

    const finish = (status) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      try { if (socket && socket.readyState === WebSocket.OPEN) socket.close(); } catch (_) { /* ignore */ }
      resolve({ url, status, events });
    };

    timer = setTimeout(() => finish('TIMEOUT'), RELAY_TIMEOUT_MS);

    try {
      socket = new WebSocket(url);
    } catch (err) {
      return finish('CONNECT_ERROR');
    }

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify(['REQ', 'probe', { kinds: [9735], '#p': [botPubkey], since }]));
      } catch (_) { finish('SEND_ERROR'); }
    };

    socket.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (!Array.isArray(data)) return;
        if (data[0] === 'EVENT' && data[2]) events.push(data[2]);
        else if (data[0] === 'EOSE') finish('OK');
        else if (data[0] === 'CLOSED') finish('CLOSED');
      } catch (_) { /* ignore */ }
    };

    socket.onerror = () => finish('WS_ERROR');
    socket.onclose = () => finish('OK');
  });
}

function findTag(ev, name) {
  if (!ev || !Array.isArray(ev.tags)) return null;
  const t = ev.tags.find((x) => Array.isArray(x) && x[0] === name);
  return t ? t.slice(1) : null;
}

function shortBolt11(b11) {
  if (typeof b11 !== 'string') return '(none)';
  if (b11.length <= 60) return b11;
  return b11.substring(0, 35) + '…' + b11.substring(b11.length - 20);
}

function describeReceipt(receipt) {
  const out = {
    amountSats: null,
    amountMsat: null,
    senderP: null,
    innerPubkey: null,
    comment: '',
    clientTag: null,
    flavor: 'UNKNOWN',
    binding: 'UNKNOWN',
    bolt11Short: '(none)',
    paymentHash: null,
  };

  const PTag = findTag(receipt, 'P');
  out.senderP = PTag ? PTag[0] : null;

  const bolt11Tag = findTag(receipt, 'bolt11');
  if (bolt11Tag && bolt11Tag[0]) {
    out.bolt11Short = shortBolt11(bolt11Tag[0]);
    try {
      const dec = bolt11.decode(bolt11Tag[0]);
      if (dec.millisatoshis) {
        out.amountMsat = parseInt(dec.millisatoshis, 10);
        out.amountSats = Math.floor(out.amountMsat / 1000);
      } else if (typeof dec.satoshis === 'number') {
        out.amountSats = dec.satoshis;
        out.amountMsat = dec.satoshis * 1000;
      }
      const phTag = (dec.tags || []).find((t) => t.tagName === 'payment_hash');
      if (phTag) {
        out.paymentHash = Buffer.isBuffer(phTag.data) ? phTag.data.toString('hex') : phTag.data;
      }
      const dh = (dec.tags || []).find(
        (t) => t.tagName === 'purpose_commit_hash' || t.tagName === 'description_hash',
      );
      const desc = (dec.tags || []).find((t) => t.tagName === 'description');
      const descTagArr = findTag(receipt, 'description');
      const descTagStr = descTagArr && typeof descTagArr[0] === 'string' ? descTagArr[0] : null;
      if (dh) {
        const dhVal = Buffer.isBuffer(dh.data) ? dh.data.toString('hex') : dh.data;
        const expected = descTagStr
          ? crypto.createHash('sha256').update(descTagStr, 'utf8').digest('hex')
          : null;
        out.binding = (expected && dhVal && dhVal.toLowerCase() === expected.toLowerCase())
          ? 'description_hash MATCH ✓'
          : `description_hash MISMATCH (invoice=${dhVal && dhVal.substring(0, 16)}…, expected=${expected ? expected.substring(0, 16) + '…' : 'no-desc-tag'})`;
      } else if (desc && descTagStr && desc.data === descTagStr) {
        out.binding = 'description literal match ✓';
      } else if (desc) {
        out.binding = `bolt11.description="${String(desc.data).substring(0, 40)}" (NO description_hash, NO literal match)`;
      } else {
        out.binding = 'NO description_hash AND NO description on invoice';
      }
    } catch (err) {
      out.bolt11Short = `(decode error: ${err.message})`;
    }
  }

  const descTag = findTag(receipt, 'description');
  if (descTag && descTag[0]) {
    try {
      const inner = JSON.parse(descTag[0]);
      out.innerPubkey = inner.pubkey || null;
      out.comment = inner.content || '';
      const clientT = findTag(inner, 'client');
      if (clientT) out.clientTag = clientT.join(' / ');
      const anonT = findTag(inner, 'anon');
      if (anonT === null) out.flavor = 'PUBLIC';
      else if (anonT.length === 0 || !anonT[0]) out.flavor = 'ANONYMOUS (empty anon tag)';
      else out.flavor = `PRIVATE (anon payload len=${anonT[0].length})`;
    } catch (_) { /* leave defaults */ }
  }

  return out;
}

async function main() {
  const lookbackHours = parseFloat(process.argv[2] || '1');
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    console.error('lookback hours must be a positive number');
    process.exit(1);
  }
  const since = Math.floor(Date.now() / 1000) - Math.floor(lookbackHours * 3600);
  const botPubkey = getBotPubkey();

  console.log(`bot pubkey: ${botPubkey}`);
  console.log(`since:      ${new Date(since * 1000).toISOString()} (${lookbackHours}h ago)`);
  console.log(`scanning:   ${SCAN_RELAYS.length} relays`);
  console.log('');

  const results = await Promise.all(
    SCAN_RELAYS.map((url) => queryRelay(url, botPubkey, since)),
  );

  console.log('=== PER-RELAY RESULTS ===');
  const found = new Map();
  for (const r of results) {
    const polled = POLLED_BY_WATCHER.has(r.url) ? '[POLLED]' : '         ';
    console.log(`${polled} ${r.url.padEnd(38)} ${r.status.padEnd(14)} count=${r.events.length}`);
    for (const ev of r.events) {
      if (!ev || !ev.id) continue;
      if (!found.has(ev.id)) {
        found.set(ev.id, {
          createdAt: new Date((ev.created_at || 0) * 1000).toISOString(),
          relays: new Set(),
          event: ev,
        });
      }
      found.get(ev.id).relays.add(r.url);
    }
  }

  console.log('');
  console.log('=== UNIQUE RECEIPTS (detail) ===');
  if (found.size === 0) {
    console.log('NO 9735 receipts to bot found on ANY relay in the last',
      lookbackHours, 'hour(s).');
    console.log('=> Either the payment never settled, or Alby did not publish.');
    console.log('   Check the NWC wallet transaction history first.');
    process.exit(0);
  }

  const sorted = Array.from(found.entries()).sort(
    ([, a], [, b]) => a.createdAt.localeCompare(b.createdAt),
  );

  for (const [id, info] of sorted) {
    const ev = info.event;
    const relays = Array.from(info.relays);
    const onPolled = relays.some((u) => POLLED_BY_WATCHER.has(u));
    const tag = onPolled ? '\x1b[32m✓ on polled set\x1b[0m' : '\x1b[31m✗ NOT on polled set\x1b[0m';

    const dec = describeReceipt(ev);

    console.log('');
    console.log('────────────────────────────────────────────────────────────');
    console.log(`receipt ${id}`);
    console.log(`  created     ${info.createdAt}    ${tag}`);
    console.log(`  amount      \x1b[1;33m${dec.amountSats !== null ? dec.amountSats + ' sats' : '???'}\x1b[0m  (${dec.amountMsat !== null ? dec.amountMsat + ' msat' : ''})`);
    console.log(`  sender (P)  ${dec.senderP || '(none)'}${dec.senderP === dec.innerPubkey ? '  [matches inner.pubkey]' : ''}`);
    console.log(`  inner pk    ${dec.innerPubkey || '(no inner)'}`);
    console.log(`  comment     \x1b[1;36m${JSON.stringify(dec.comment || '')}\x1b[0m`);
    console.log(`  client tag  ${dec.clientTag || '(none)'}`);
    console.log(`  flavor      ${dec.flavor}`);
    console.log(`  binding     ${dec.binding}`);
    console.log(`  bolt11      ${dec.bolt11Short}`);
    console.log(`  payment_hsh ${dec.paymentHash || '(missing)'}`);
    console.log(`  found on    ${relays.join(', ')}`);
  }

  console.log('');
  console.log('=== SUMMARY ===');
  const total = found.size;
  const onPolled = Array.from(found.values()).filter(
    (v) => Array.from(v.relays).some((u) => POLLED_BY_WATCHER.has(u)),
  ).length;
  const onlyExternal = total - onPolled;
  console.log(`total unique receipts: ${total}`);
  console.log(`  on polled relays   : ${onPolled}  (watcher should have caught these)`);
  console.log(`  ONLY on external   : ${onlyExternal}  (watcher missed these — relay mismatch)`);
  if (onlyExternal > 0) {
    console.log('');
    console.log('=> Add the unique relays above to RELAYS[] in utils/NostrZapWatcher.js');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
