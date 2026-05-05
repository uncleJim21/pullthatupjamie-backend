#!/usr/bin/env node
/**
 * Quick check: LNURL-pay advertises NIP-57 (allowsNostr + nostrPubkey) for your
 * lightning address, then poll a few relays for recent kind:9735 zap receipts
 * where #p matches JAMIE_BOT_NSEC_BECH32's pubkey.
 *
 * Usage (from repo root):
 *   node scripts/check-zap-receipts.js
 *
 * Reads:
 *   JAMIE_BOT_LN_ADDRESS   e.g. jamie_bot@getalby.com
 *   JAMIE_BOT_NSEC_BECH32  bot nsec
 *
 * Optional env:
 *   NOSTR_ZAP_CHECK_RELAYS  comma-separated wss URLs (defaults to 3 public relays)
 *   NOSTR_ZAP_CHECK_SINCE   unix seconds (default: now - 7d)
 *
 * Does not start the server or write to Mongo.
 */

require('dotenv').config();
const https = require('https');
const WebSocket = require('ws');
const { nip19, getPublicKey, verifyEvent } = require('nostr-tools');

const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { Accept: 'application/json' } }, (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Bad JSON from ${url}: ${body.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
  });
}

function parseLnAddress(addr) {
  const s = (addr || '').trim().toLowerCase();
  const at = s.indexOf('@');
  if (at < 1 || at === s.length - 1) {
    throw new Error(`Invalid lightning address: "${addr}" (expected local@domain)`);
  }
  return { local: s.slice(0, at), domain: s.slice(at + 1) };
}

function botPubkeyHexFromNsec(nsecBech32) {
  const decoded = nip19.decode(nsecBech32.trim());
  if (decoded.type !== 'nsec') throw new Error('JAMIE_BOT_NSEC_BECH32 must be nsec1...');
  const sk = decoded.data;
  if (!(sk instanceof Uint8Array) || sk.length !== 32) {
    throw new Error('nsec decoded to unexpected secret key shape');
  }
  return getPublicKey(sk);
}

function queryRelay(relayUrl, filter) {
  return new Promise((resolve) => {
    const events = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        if (socket && socket.readyState === WebSocket.OPEN) socket.close();
      } catch (_) {
        /* ignore */
      }
      resolve(events);
    };

    const timer = setTimeout(() => finish(), 12_000);
    let socket;

    try {
      socket = new WebSocket(relayUrl);
      socket.on('open', () => {
        const sub = 'zchk_' + Math.random().toString(36).slice(2, 10);
        socket.send(JSON.stringify(['REQ', sub, filter]));
      });
      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg[0] === 'EVENT' && msg[2]) events.push(msg[2]);
          else if (msg[0] === 'EOSE') {
            clearTimeout(timer);
            finish();
          }
        } catch (_) {
          /* ignore */
        }
      });
      socket.on('error', () => {
        clearTimeout(timer);
        finish();
      });
      socket.on('close', () => {
        clearTimeout(timer);
        finish();
      });
    } catch (_) {
      clearTimeout(timer);
      finish();
    }
  });
}

async function main() {
  const lnAddr = process.env.JAMIE_BOT_LN_ADDRESS;
  const nsec = process.env.JAMIE_BOT_NSEC_BECH32;

  if (!lnAddr || !nsec) {
    console.error(
      'Set JAMIE_BOT_LN_ADDRESS and JAMIE_BOT_NSEC_BECH32 (or load .env via dotenv).',
    );
    process.exit(1);
  }

  const { local, domain } = parseLnAddress(lnAddr);
  const botPk = botPubkeyHexFromNsec(nsec);

  console.log('--- Bot identity ---');
  console.log('npub:', nip19.npubEncode(botPk));
  console.log('hex pubkey:', botPk);
  console.log('');

  const wellKnownUrl = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(local)}`;
  console.log('--- LNURL-pay (NIP-57 gate) ---');
  console.log('GET', wellKnownUrl);

  let ln;
  try {
    ln = await httpsGetJson(wellKnownUrl);
  } catch (e) {
    console.error('Failed to fetch LNURL:', e.message);
    process.exit(1);
  }

  if (ln.status && ln.status === 'ERROR') {
    console.error('LNURL error:', ln.reason || ln);
    process.exit(1);
  }

  const allows = ln.allowsNostr === true;
  const zapperPk = typeof ln.nostrPubkey === 'string' ? ln.nostrPubkey : '';
  console.log('tag:', ln.tag);
  console.log('allowsNostr:', ln.allowsNostr);
  console.log('nostrPubkey (zapper service):', zapperPk || '(missing)');
  if (!allows || !/^[0-9a-fA-F]{64}$/.test(zapperPk)) {
    console.log('');
    console.log(
      'RESULT: NIP-57 zaps are NOT advertised on this LNURL endpoint — clients may pay via plain LNURL without kind:9734/9735.',
    );
    process.exit(1);
  }

  console.log('RESULT: NIP-57 fields present — zap receipts should be signed by nostrPubkey above.');
  console.log('');

  const sinceEnv = process.env.NOSTR_ZAP_CHECK_SINCE;
  const since = sinceEnv
    ? parseInt(sinceEnv, 10)
    : Math.floor(Date.now() / 1000) - 7 * 24 * 3600;

  const relays = (process.env.NOSTR_ZAP_CHECK_RELAYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const relayList = relays.length ? relays : DEFAULT_RELAYS;

  const filter = {
    kinds: [9735],
    '#p': [botPk],
    since,
    limit: 25,
  };

  console.log('--- Relay poll (kind 9735, #p = bot) ---');
  console.log('since:', since, `(${new Date(since * 1000).toISOString()})`);
  console.log('relays:', relayList.join(', '));
  console.log('');

  const sets = await Promise.all(relayList.map((r) => queryRelay(r, filter)));
  const byId = new Map();
  for (const evs of sets) {
    for (const ev of evs) {
      if (ev && ev.id && !byId.has(ev.id)) byId.set(ev.id, ev);
    }
  }

  const merged = [...byId.values()].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  if (!merged.length) {
    console.log(
      'No kind:9735 receipts found on these relays in the window. Send a small test zap to the bot profile (lud16), wait ~30s, re-run.',
    );
    process.exit(0);
  }

  console.log(`Found ${merged.length} unique receipt(s):\n`);

  for (const ev of merged.slice(0, 15)) {
    const okProv = ev.pubkey.toLowerCase() === zapperPk.toLowerCase();
    const sigOk = verifyEvent(ev);
    const bolt11 = (ev.tags || []).find((t) => t[0] === 'bolt11')?.[1]?.slice(0, 24) || '';
    console.log(`id:        ${ev.id}`);
    console.log(`created:   ${ev.created_at} (${new Date(ev.created_at * 1000).toISOString()})`);
    console.log(`receipt signer == LNURL nostrPubkey: ${okProv ? 'yes' : 'NO (unexpected)'}`);
    console.log(`verifyEvent(receipt): ${sigOk ? 'ok' : 'FAIL'}`);
    console.log(`bolt11:    ${bolt11}...`);
    console.log('');
  }

  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
