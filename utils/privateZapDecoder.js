/**
 * Private-Zap Decoder (NIP-57 informal extension)
 *
 * NIP-57 itself doesn't define private zaps — they're a Damus-led
 * extension. The wire format for the `anon` tag's encrypted payload
 * is one of:
 *
 *   1. Damus bech32 form:  `pzap1<bech32-cipher>_iv1<bech32-iv>`
 *      - HRP `pzap` carries raw AES-256-CBC ciphertext
 *      - HRP `iv`   carries the 16-byte IV
 *      - Joined with a literal underscore
 *
 *   2. Canonical NIP-04 form: `<base64-cipher>?iv=<base64-iv>`
 *      - Same as Nostr DM encryption; ciphertext + IV both base64.
 *
 * Decryption uses the bot's nsec + the *outer 9734 zap request's
 * pubkey* (the ephemeral throwaway key) as the NIP-04 key pair.
 * The plaintext is JSON for an inner kind-9733 event signed by the
 * REAL sender. That inner event's `pubkey` field is the npub we
 * actually credit.
 *
 * Reference: damus iOS source — `decrypt_private_zap` in
 * damus/Features/Zaps/Models/Zap.swift and `decode_dm_bech32` /
 * `aes_operation` in damus/Core/Nostr/NostrEvent.swift.
 *
 * This module is pure. The caller (zapReceiptValidator) supplies
 * the bot's secret key and the outer zap request — we never read
 * env vars or touch the database.
 */

const { bech32 } = require('@scure/base');
const { nip04, verifyEvent } = require('nostr-tools');

const BECH32_LIMIT = 1500; // pzap1 + iv1 blobs are well under 1KB
const HEX64 = /^[0-9a-f]{64}$/i;

function fail(reason, detail) {
  return { ok: false, reason, detail: detail || null };
}

function isHex64(s) {
  return typeof s === 'string' && HEX64.test(s);
}

function findTag(event, name) {
  if (!event || !Array.isArray(event.tags)) return null;
  const t = event.tags.find((tag) => Array.isArray(tag) && tag[0] === name);
  return t ? t : null;
}

/**
 * Detect whether an `anon` tag value is empty (= truly anonymous,
 * no encrypted payload to decrypt) vs present (= private zap, must
 * attempt decryption).
 *
 * Per Damus's behavior, an anon tag with no value is treated as a
 * full anonymous zap — unattributable. An anon tag with a non-empty
 * value is a private zap and the value is the encrypted blob.
 */
function classifyAnonTag(zapRequest) {
  const tag = findTag(zapRequest, 'anon');
  if (!tag) return { kind: 'none' };
  const value = tag.length >= 2 ? String(tag[1] || '').trim() : '';
  if (!value) return { kind: 'anonymous' };
  return { kind: 'private', value };
}

/**
 * Try to parse the Damus bech32 wire format
 * `pzap1<...>_iv1<...>`. Returns
 *   { ok: true, ciphertext: Buffer, iv: Buffer }
 * or
 *   { ok: false, reason }
 *
 * Uses @scure/base's bech32 decoder which we already have via
 * nostr-tools' transitive deps.
 */
function parseDamusBech32(value) {
  if (typeof value !== 'string' || !value.startsWith('pzap1')) {
    return { ok: false, reason: 'not-pzap-bech32' };
  }
  // Damus joins with a single underscore; the iv part is its own
  // bech32 string with HRP `iv`. Split into [pzap1..., iv1...].
  const idx = value.indexOf('_iv1');
  if (idx === -1) {
    return { ok: false, reason: 'pzap-missing-iv-separator' };
  }
  const cipherPart = value.slice(0, idx);
  const ivPart = value.slice(idx + 1); // keep "iv1..." prefix
  let cipherDec;
  let ivDec;
  try {
    cipherDec = bech32.decode(cipherPart, BECH32_LIMIT);
  } catch (err) {
    return { ok: false, reason: 'pzap-cipher-bech32-decode-failed', detail: err.message };
  }
  try {
    ivDec = bech32.decode(ivPart, BECH32_LIMIT);
  } catch (err) {
    return { ok: false, reason: 'pzap-iv-bech32-decode-failed', detail: err.message };
  }
  if (cipherDec.prefix !== 'pzap') {
    return { ok: false, reason: 'pzap-cipher-bad-hrp', detail: cipherDec.prefix };
  }
  if (ivDec.prefix !== 'iv') {
    return { ok: false, reason: 'pzap-iv-bad-hrp', detail: ivDec.prefix };
  }
  const cipherBytes = Buffer.from(bech32.fromWords(cipherDec.words));
  const ivBytes = Buffer.from(bech32.fromWords(ivDec.words));
  if (ivBytes.length !== 16) {
    return { ok: false, reason: 'pzap-iv-wrong-length', detail: `${ivBytes.length}!=16` };
  }
  if (cipherBytes.length === 0 || cipherBytes.length % 16 !== 0) {
    return {
      ok: false,
      reason: 'pzap-cipher-not-aes-block-aligned',
      detail: `${cipherBytes.length}%16!=0`,
    };
  }
  return { ok: true, ciphertext: cipherBytes, iv: ivBytes };
}

/**
 * Build the canonical NIP-04 wire string from raw ciphertext + iv.
 * `nip04.decrypt` from nostr-tools accepts this exact format.
 */
function toCanonicalNip04(ciphertext, iv) {
  return `${ciphertext.toString('base64')}?iv=${iv.toString('base64')}`;
}

/**
 * Detect the canonical NIP-04 wire format. We don't need to decode
 * it ourselves — nip04.decrypt accepts it directly.
 */
function isCanonicalNip04(value) {
  if (typeof value !== 'string') return false;
  if (!value.includes('?iv=')) return false;
  // Light sanity: split into two parts and require both look base64-ish.
  const [cipher, ivPart] = value.split('?iv=');
  if (!cipher || !ivPart) return false;
  return /^[A-Za-z0-9+/=]+$/.test(cipher) && /^[A-Za-z0-9+/=]+$/.test(ivPart);
}

/**
 * Decrypt a private-zap `anon` tag value into the inner kind-9733
 * Nostr event. Verifies the inner event's signature and that its
 * referenced `e`/`p` tags match the outer zap request.
 *
 * @param {Object} params
 * @param {string} params.anonValue              the raw anon tag value
 * @param {Uint8Array} params.botSecretKey       the bot's nsec bytes (32)
 * @param {Object} params.outerZapRequest        the outer kind-9734 event
 * @returns {{ ok: true, innerEvent, realSenderHex }
 *          | { ok: false, reason: string, detail: string|null }}
 */
function decryptPrivateZap({ anonValue, botSecretKey, outerZapRequest }) {
  if (!anonValue || typeof anonValue !== 'string') {
    return fail('no-anon-value');
  }
  if (!botSecretKey || botSecretKey.length !== 32) {
    return fail('no-bot-secret-key');
  }
  if (!outerZapRequest || !isHex64(outerZapRequest.pubkey)) {
    return fail('bad-outer-zap-request');
  }

  // Normalize wire format: canonical NIP-04 → use as-is. Damus
  // bech32 → decode + re-encode as canonical so nip04.decrypt can
  // consume it.
  let canonical;
  if (isCanonicalNip04(anonValue)) {
    canonical = anonValue;
  } else {
    const parsed = parseDamusBech32(anonValue);
    if (!parsed.ok) return fail(parsed.reason, parsed.detail);
    canonical = toCanonicalNip04(parsed.ciphertext, parsed.iv);
  }

  let plaintext;
  try {
    plaintext = nip04.decrypt(botSecretKey, outerZapRequest.pubkey, canonical);
  } catch (err) {
    // nip04.decrypt throws on shared-secret derivation failure or
    // AES failure. In our context that means the blob wasn't
    // encrypted to us, or it was tampered.
    return fail('nip04-decrypt-failed', err.message);
  }

  let innerEvent;
  try {
    innerEvent = JSON.parse(plaintext);
  } catch (err) {
    return fail('inner-not-json', err.message);
  }

  if (!innerEvent || typeof innerEvent !== 'object') {
    return fail('inner-empty');
  }
  if (innerEvent.kind !== 9733) {
    return fail('inner-wrong-kind', `kind=${innerEvent.kind}`);
  }
  if (!isHex64(innerEvent.pubkey)) {
    return fail('inner-bad-pubkey');
  }
  if (typeof innerEvent.sig !== 'string' || innerEvent.sig.length !== 128) {
    return fail('inner-bad-sig-shape');
  }
  if (!Array.isArray(innerEvent.tags)) {
    return fail('inner-bad-tags');
  }

  let innerSigOk = false;
  try {
    innerSigOk = verifyEvent(innerEvent);
  } catch (err) {
    return fail('inner-sig-error', err.message);
  }
  if (!innerSigOk) return fail('inner-bad-sig');

  // Cross-check: inner referenced `e`/`p` tags must match the outer
  // zap request, otherwise an attacker who can decrypt could
  // reattribute. (For us, only the bot can decrypt, so this is
  // belt-and-suspenders — but Damus enforces it too.)
  const outerETag = findTag(outerZapRequest, 'e');
  const outerPTag = findTag(outerZapRequest, 'p');
  const innerETag = findTag(innerEvent, 'e');
  const innerPTag = findTag(innerEvent, 'p');

  // The `p` tag (recipient) must always match — both should be the bot.
  if (!outerPTag || !innerPTag || outerPTag[1] !== innerPTag[1]) {
    return fail('inner-p-mismatch');
  }

  // The `e` tag is optional (profile zaps don't have one). If the
  // outer has it, the inner must match. If the outer doesn't have
  // it, neither should the inner.
  if (outerETag) {
    if (!innerETag || innerETag[1] !== outerETag[1]) {
      return fail('inner-e-mismatch');
    }
  } else if (innerETag) {
    return fail('inner-unexpected-e');
  }

  return {
    ok: true,
    innerEvent,
    realSenderHex: innerEvent.pubkey.toLowerCase(),
  };
}

module.exports = {
  classifyAnonTag,
  decryptPrivateZap,
  // Exposed for unit tests:
  parseDamusBech32,
  toCanonicalNip04,
  isCanonicalNip04,
};
