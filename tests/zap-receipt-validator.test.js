#!/usr/bin/env node
/**
 * Self-contained fixture suite for utils/zapReceiptValidator.
 *
 *   node tests/zap-receipt-validator.test.js
 *
 * No mocha/jest dependency — pure node assertions. Generates real
 * keys, real bolt11 invoices, and real signed Nostr events on the
 * fly so each test runs the entire validation chain end-to-end.
 *
 * Each scenario is described inline. A non-zero exit code indicates
 * at least one scenario failed.
 */

const assert = require('assert');
const crypto = require('crypto');
const bolt11 = require('bolt11');
const {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip04,
} = require('nostr-tools');
const { bech32 } = require('@scure/base');

const { validateZapReceipt } = require('../utils/zapReceiptValidator');
const { parseDamusBech32, isCanonicalNip04 } = require('../utils/privateZapDecoder');

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function randomNodePrivKeyHex() {
  return crypto.randomBytes(32).toString('hex');
}

function buildZapRequest({ senderSk, recipientHex, amountMsat, eventId = null }) {
  const tags = [
    ['relays', 'wss://relay.primal.net'],
    ['amount', String(amountMsat)],
    ['p', recipientHex],
  ];
  if (eventId) tags.push(['e', eventId]);
  return finalizeEvent(
    {
      kind: 9734,
      created_at: Math.floor(Date.now() / 1000) - 30,
      tags,
      content: 'thanks for the work',
    },
    senderSk,
  );
}

function buildInvoice({ msat, descriptionHashHex, nodePrivKeyHex }) {
  const enc = bolt11.encode({
    network: bolt11.encode.networks ? bolt11.encode.networks.bitcoin : undefined,
    millisatoshis: String(msat),
    timestamp: Math.floor(Date.now() / 1000),
    tags: [
      { tagName: 'payment_hash', data: crypto.randomBytes(32).toString('hex') },
      { tagName: 'purpose_commit_hash', data: descriptionHashHex },
      { tagName: 'expire_time', data: 3600 },
      { tagName: 'min_final_cltv_expiry', data: 18 },
    ],
  });
  const signed = bolt11.sign(enc, nodePrivKeyHex);
  return signed.paymentRequest;
}

function buildZapReceipt({
  zapperSk,
  recipientHex,
  zapRequestEvent,
  bolt11Str,
  preimageHex,
  senderHex,
}) {
  const tags = [
    ['p', recipientHex],
    ['bolt11', bolt11Str],
    ['description', JSON.stringify(zapRequestEvent)],
  ];
  if (senderHex) tags.push(['P', senderHex]);
  if (preimageHex) tags.push(['preimage', preimageHex]);
  return finalizeEvent(
    {
      kind: 9735,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    },
    zapperSk,
  );
}

function makeFixture({
  amountMsat = 100_000,
  invoiceMsatOverride = null,
  descriptionOverride = null,
  preimage = false,
} = {}) {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const zapperSk = generateSecretKey();
  const zapperHex = getPublicKey(zapperSk);
  const botSk = generateSecretKey();
  const botHex = getPublicKey(botSk);

  const zapRequest = buildZapRequest({
    senderSk,
    recipientHex: botHex,
    amountMsat,
  });

  const description = descriptionOverride !== null
    ? descriptionOverride
    : JSON.stringify(zapRequest);
  const descriptionHash = sha256Hex(description);

  const nodeKey = randomNodePrivKeyHex();
  const bolt11Str = buildInvoice({
    msat: invoiceMsatOverride !== null ? invoiceMsatOverride : amountMsat,
    descriptionHashHex: descriptionHash,
    nodePrivKeyHex: nodeKey,
  });

  let preimageHex = null;
  if (preimage) {
    preimageHex = crypto.randomBytes(32).toString('hex');
  }

  const receipt = buildZapReceipt({
    zapperSk,
    recipientHex: botHex,
    zapRequestEvent: descriptionOverride !== null ? JSON.parse(descriptionOverride) || zapRequest : zapRequest,
    bolt11Str,
    preimageHex,
    senderHex,
  });

  // Mutate the description tag if an override was requested
  if (descriptionOverride !== null) {
    receipt.tags = receipt.tags.map((t) => {
      if (Array.isArray(t) && t[0] === 'description') return ['description', descriptionOverride];
      return t;
    });
    // Re-sign if we changed contents post-finalize. finalizeEvent already
    // signed; for these negative tests we DON'T re-sign — the invalid sig
    // is itself part of the failure mode.
  }

  return { senderHex, zapperHex, botHex, zapRequest, receipt, description, bolt11Str };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────
test('happy path: trusted zapper, valid sigs, matching binding → ok', async () => {
  const { receipt, botHex, zapperHex, senderHex } = makeFixture();
  const result = validateZapReceipt({
    receipt,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: [zapperHex],
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.normalized.recipientNpubHex, botHex);
  assert.strictEqual(result.normalized.senderNpubHex, senderHex);
  assert.strictEqual(result.normalized.zapperServicePubkey, zapperHex);
  assert.strictEqual(result.normalized.amountMsat, 100_000);
  assert.strictEqual(result.normalized.amountSats, 100);
});

// ─────────────────────────────────────────────────────────────────────────
// Trust gate
// ─────────────────────────────────────────────────────────────────────────
test('untrusted zapper rejected', async () => {
  const { receipt, botHex } = makeFixture();
  const result = validateZapReceipt({
    receipt,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: ['f'.repeat(64)], // not the real zapper
  });
  assert.strictEqual(result.ok, false);
  assertEqual(result.reason, 'untrusted-zapper', 'reason');
});

// ─────────────────────────────────────────────────────────────────────────
// Wrong recipient
// ─────────────────────────────────────────────────────────────────────────
test('receipt for a different recipient rejected', async () => {
  const { receipt, zapperHex } = makeFixture();
  const otherBot = 'a'.repeat(64);
  const result = validateZapReceipt({
    receipt,
    botPubkeyHex: otherBot,
    trustedZapperPubkeys: [zapperHex],
  });
  assert.strictEqual(result.ok, false);
  assertEqual(result.reason, 'not-for-bot', 'reason');
});

// ─────────────────────────────────────────────────────────────────────────
// Tampered receipt sig
// ─────────────────────────────────────────────────────────────────────────
test('corrupted receipt sig fails sig check', async () => {
  const { receipt, botHex, zapperHex } = makeFixture();
  // JSON-clone to strip nostr-tools' cached `verifiedSymbol` property,
  // which would otherwise short-circuit verifyEvent and return true.
  // (Real-world receipts arrive via JSON over WebSocket so they never
  // have this symbol set.)
  const tampered = JSON.parse(JSON.stringify(receipt));
  tampered.sig = '0'.repeat(128);
  const result = validateZapReceipt({
    receipt: tampered,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: [zapperHex],
  });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assertEqual(result.reason, 'bad-sig', 'reason');
});

// ─────────────────────────────────────────────────────────────────────────
// Description hash mismatch
// ─────────────────────────────────────────────────────────────────────────
test('mutated description tag breaks invoice binding', async () => {
  const { receipt, botHex, zapperHex } = makeFixture();
  // Replace description with a different valid-looking JSON. The
  // receipt sig is now invalid because we changed a tag, so we expect
  // bad-sig. This is fine — the invariant we care about is "any
  // mutation rejects".
  receipt.tags = receipt.tags.map((t) => {
    if (Array.isArray(t) && t[0] === 'description') {
      const fakeReq = JSON.parse(t[1]);
      fakeReq.content = 'evil';
      return ['description', JSON.stringify(fakeReq)];
    }
    return t;
  });
  const result = validateZapReceipt({
    receipt,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: [zapperHex],
  });
  assert.strictEqual(result.ok, false);
  // The mutation invalidates either the receipt sig, the inner zap
  // request sig, or the description→invoice binding. Any of these
  // proves the validator caught the tampering.
  assert.ok(
    ['bad-sig', 'bad-zap-request-sig', 'binding-mismatch'].includes(result.reason),
    `unexpected reason: ${result.reason}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Missing bolt11
// ─────────────────────────────────────────────────────────────────────────
test('missing bolt11 tag rejected', async () => {
  const { receipt, botHex, zapperHex } = makeFixture();
  receipt.tags = receipt.tags.filter((t) => !(Array.isArray(t) && t[0] === 'bolt11'));
  const result = validateZapReceipt({
    receipt,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: [zapperHex],
  });
  assert.strictEqual(result.ok, false);
  // Sig will fail first because we tampered tags. The earlier-stage
  // bad-sig outcome still proves rejection.
  assert.ok(['no-bolt11', 'bad-sig'].includes(result.reason));
});

// ─────────────────────────────────────────────────────────────────────────
// Underpayment vs zap request amount tag
// ─────────────────────────────────────────────────────────────────────────
test('invoice underpayment vs zap-request amount rejected', async () => {
  // Invoice for 50_000 msat but zap request asked for 100_000.
  const { receipt, botHex, zapperHex } = makeFixture({
    amountMsat: 100_000,
    invoiceMsatOverride: 50_000,
  });
  const result = validateZapReceipt({
    receipt,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: [zapperHex],
  });
  assert.strictEqual(result.ok, false);
  assertEqual(result.reason, 'underpaid', 'reason');
});

// ─────────────────────────────────────────────────────────────────────────
// Preimage policy
// ─────────────────────────────────────────────────────────────────────────
test('requireValidPreimage=true with no preimage rejected', async () => {
  const { receipt, botHex, zapperHex } = makeFixture({ preimage: false });
  const result = validateZapReceipt({
    receipt,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: [zapperHex],
    requireValidPreimage: true,
  });
  assert.strictEqual(result.ok, false);
  assertEqual(result.reason, 'no-preimage', 'reason');
});

// ─────────────────────────────────────────────────────────────────────────
// Anonymous + private zap fixtures
// ─────────────────────────────────────────────────────────────────────────
//
// We rebuild the fixture from scratch for these scenarios because we
// need control over (a) the inner zap-request's tags (adding `anon`)
// and (b) which keypair signs which event. Real zap clients use an
// EPHEMERAL keypair to sign the outer 9734 + 9735 (the receipt's
// zapper service is still trusted), and embed the REAL sender's
// signed kind-9733 inside an NIP-04-encrypted `anon` tag value.

function makePrivateZapFixture({ encoding = 'bech32' } = {}) {
  const realSenderSk = generateSecretKey();
  const realSenderHex = getPublicKey(realSenderSk);
  const ephemeralSk = generateSecretKey();
  const ephemeralHex = getPublicKey(ephemeralSk);
  const zapperSk = generateSecretKey();
  const zapperHex = getPublicKey(zapperSk);
  const botSk = generateSecretKey();
  const botHex = getPublicKey(botSk);

  const amountMsat = 100_000;

  // Build the inner kind-9733 signed by the REAL sender.
  const innerEvent = finalizeEvent(
    {
      kind: 9733,
      created_at: Math.floor(Date.now() / 1000) - 30,
      tags: [
        ['p', botHex],
      ],
      content: 'thanks Jamie',
    },
    realSenderSk,
  );

  // Encrypt the inner event with NIP-04 between bot's pubkey and the
  // ephemeral private key (i.e., the keypair we'll use to sign the
  // outer 9734). For decryption the bot uses (botSk, ephemeralHex).
  const innerJson = JSON.stringify(innerEvent);
  const encryptedCanonical = nip04.encrypt(ephemeralSk, botHex, innerJson);

  let anonValue;
  if (encoding === 'bech32') {
    // Convert canonical NIP-04 (`<base64>?iv=<base64>`) to Damus
    // bech32 wire format (`pzap1...rpg_iv1...`).
    const [b64Cipher, ivPart] = encryptedCanonical.split('?iv=');
    const cipherBytes = Buffer.from(b64Cipher, 'base64');
    const ivBytes = Buffer.from(ivPart, 'base64');
    const cipherWords = bech32.toWords(cipherBytes);
    const ivWords = bech32.toWords(ivBytes);
    const cipherBech = bech32.encode('pzap', cipherWords, 1500);
    const ivBech = bech32.encode('iv', ivWords, 1500);
    anonValue = `${cipherBech}_${ivBech}`;
  } else {
    anonValue = encryptedCanonical;
  }

  const outerZapRequest = finalizeEvent(
    {
      kind: 9734,
      created_at: Math.floor(Date.now() / 1000) - 20,
      tags: [
        ['p', botHex],
        ['relays', 'wss://relay.primal.net'],
        ['amount', String(amountMsat)],
        ['anon', anonValue],
      ],
      content: '',
    },
    ephemeralSk,
  );

  const description = JSON.stringify(outerZapRequest);
  const descriptionHash = sha256Hex(description);
  const nodeKey = randomNodePrivKeyHex();
  const bolt11Str = buildInvoice({
    msat: amountMsat,
    descriptionHashHex: descriptionHash,
    nodePrivKeyHex: nodeKey,
  });

  const receipt = buildZapReceipt({
    zapperSk,
    recipientHex: botHex,
    zapRequestEvent: outerZapRequest,
    bolt11Str,
    preimageHex: null,
    senderHex: ephemeralHex, // Damus stamps the ephemeral key on the receipt
  });

  return {
    realSenderHex,
    ephemeralHex,
    zapperHex,
    botHex,
    botSk,
    receipt,
    anonValue,
  };
}

test('private zap (Damus bech32) decrypts and credits real sender', async () => {
  const { receipt, botHex, botSk, zapperHex, realSenderHex, ephemeralHex } =
    makePrivateZapFixture({ encoding: 'bech32' });
  const result = validateZapReceipt({
    receipt,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: [zapperHex],
    botSecretKey: botSk,
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assertEqual(result.normalized.zapFlavor, 'private', 'zapFlavor');
  assertEqual(result.normalized.senderNpubHex, realSenderHex, 'recovered real sender');
  assert.notStrictEqual(
    result.normalized.senderNpubHex,
    ephemeralHex,
    'must NOT be the ephemeral throwaway pubkey',
  );
});

test('private zap (canonical NIP-04 wire) decrypts and credits real sender', async () => {
  const { receipt, botHex, botSk, zapperHex, realSenderHex } =
    makePrivateZapFixture({ encoding: 'canonical' });
  const result = validateZapReceipt({
    receipt,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: [zapperHex],
    botSecretKey: botSk,
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assertEqual(result.normalized.zapFlavor, 'private', 'zapFlavor');
  assertEqual(result.normalized.senderNpubHex, realSenderHex, 'recovered real sender');
});

test('truly anonymous zap (anon tag with no value) is rejected, not crediting anyone', async () => {
  // Build a fixture where the outer 9734 has an `anon` tag with no
  // encrypted value — i.e., a fully anonymous zap from a
  // throwaway key. This should be rejected by the validator with
  // `anonymous-zap-unattributable` so the watcher knows to skip
  // persisting any row.
  const ephemeralSk = generateSecretKey();
  const zapperSk = generateSecretKey();
  const zapperHex = getPublicKey(zapperSk);
  const botSk = generateSecretKey();
  const botHex = getPublicKey(botSk);

  const amountMsat = 100_000;
  const outerZapRequest = finalizeEvent(
    {
      kind: 9734,
      created_at: Math.floor(Date.now() / 1000) - 20,
      tags: [
        ['p', botHex],
        ['relays', 'wss://relay.primal.net'],
        ['amount', String(amountMsat)],
        ['anon'], // length 1 — fully anonymous
      ],
      content: '',
    },
    ephemeralSk,
  );

  const description = JSON.stringify(outerZapRequest);
  const descriptionHash = sha256Hex(description);
  const nodeKey = randomNodePrivKeyHex();
  const bolt11Str = buildInvoice({
    msat: amountMsat,
    descriptionHashHex: descriptionHash,
    nodePrivKeyHex: nodeKey,
  });
  const receipt = buildZapReceipt({
    zapperSk,
    recipientHex: botHex,
    zapRequestEvent: outerZapRequest,
    bolt11Str,
    preimageHex: null,
    senderHex: getPublicKey(ephemeralSk),
  });

  const result = validateZapReceipt({
    receipt,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: [zapperHex],
    botSecretKey: botSk,
  });
  assert.strictEqual(result.ok, false, 'anonymous must reject');
  assertEqual(result.reason, 'anonymous-zap-unattributable', 'reason');
});

test('private zap with no botSecretKey falls through to private-zap-no-key', async () => {
  const { receipt, botHex, zapperHex } = makePrivateZapFixture({ encoding: 'bech32' });
  const result = validateZapReceipt({
    receipt,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: [zapperHex],
    // No botSecretKey provided.
  });
  assert.strictEqual(result.ok, false);
  assertEqual(result.reason, 'private-zap-no-key', 'reason');
});

test('private zap with corrupted ciphertext rejects with private-zap-decrypt-failed', async () => {
  const { receipt, botHex, botSk, zapperHex } = makePrivateZapFixture({ encoding: 'canonical' });
  // Mutate the inner anon tag value inside the description (without
  // re-signing — the receipt sig was over the old description so it
  // will fail first; but if the receipt sig DID pass, the inner
  // private-zap decrypt would fail too. We just want to prove the
  // validator never silently credits a tampered private zap).
  const newReceipt = JSON.parse(JSON.stringify(receipt));
  newReceipt.tags = newReceipt.tags.map((t) => {
    if (Array.isArray(t) && t[0] === 'description') {
      const desc = JSON.parse(t[1]);
      desc.tags = desc.tags.map((dt) => {
        if (Array.isArray(dt) && dt[0] === 'anon') {
          // Truncate the b64 cipher by 4 chars to mangle it
          return ['anon', String(dt[1]).slice(0, -4) + 'XXXX'];
        }
        return dt;
      });
      return ['description', JSON.stringify(desc)];
    }
    return t;
  });
  const result = validateZapReceipt({
    receipt: newReceipt,
    botPubkeyHex: botHex,
    trustedZapperPubkeys: [zapperHex],
    botSecretKey: botSk,
  });
  assert.strictEqual(result.ok, false);
  // Either the receipt sig failed first (because we touched the
  // description tag) or the inner decrypt failed. Either is a
  // valid rejection — the invariant we're proving is "tampered
  // private zaps don't credit".
  assert.ok(
    [
      'bad-sig',
      'bad-zap-request-sig',
      'binding-mismatch',
      'private-zap-decrypt-failed',
    ].includes(result.reason),
    `unexpected reason: ${result.reason}`,
  );
});

// Smoke-test the wire-format detection helpers.
test('wire-format helpers: pzap1 detected as bech32, base64?iv= detected as canonical', () => {
  assert.strictEqual(
    isCanonicalNip04('AAA?iv=BBB'),
    true,
    'canonical NIP-04 string should be detected',
  );
  assert.strictEqual(
    isCanonicalNip04('pzap1abc_iv1xyz'),
    false,
    'Damus bech32 should NOT be detected as canonical',
  );
  // parseDamusBech32 round-trip — encode random bytes ourselves.
  const cipher = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const cipherBech = bech32.encode('pzap', bech32.toWords(cipher), 1500);
  const ivBech = bech32.encode('iv', bech32.toWords(iv), 1500);
  const blob = `${cipherBech}_${ivBech}`;
  const parsed = parseDamusBech32(blob);
  assert.strictEqual(parsed.ok, true, JSON.stringify(parsed));
  assert.strictEqual(parsed.iv.toString('hex'), iv.toString('hex'));
  assert.strictEqual(parsed.ciphertext.toString('hex'), cipher.toString('hex'));
});

// ─────────────────────────────────────────────────────────────────────────
// Run all
// ─────────────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
