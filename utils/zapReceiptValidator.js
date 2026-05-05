/**
 * NIP-57 Zap Receipt Validator
 *
 * Pure function. Given a kind:9735 event from a relay plus a bot
 * pubkey and a trusted set of zapper-service pubkeys, returns:
 *   { ok: true,  normalized: { … } }                — accept and credit
 *   { ok: false, reason: 'short-error-code', detail: '…' } — discard
 *
 * Validation chain (in order, fail-closed):
 *   1.  Structural: kind 9735, valid id/pubkey/sig fields shape.
 *   2.  Signature: verifyEvent(receipt) — receipt was signed by
 *       receipt.pubkey, untampered.
 *   3.  Trust: receipt.pubkey ∈ trustedZapperPubkeys.
 *   4.  Recipient: at least one #p tag matching botPubkeyHex.
 *   5.  description tag: present, parses to a kind:9734 zap request
 *       with a valid signature and a #p tag matching botPubkeyHex.
 *   6.  bolt11 tag: present, parses via bolt11.decode().
 *   7.  Binding: the invoice's description_hash equals
 *       sha256(description), OR the invoice's description equals
 *       description verbatim. This is the cryptographic link
 *       between the receipt and the zap request.
 *   8.  Amount sanity: invoice msats ≥ amount tag in zap request
 *       (within tolerance, default 0 bps).
 *   9.  Optional: preimage tag matches invoice payment_hash. If
 *       requireValidPreimage is true and the tag is missing or
 *       mismatched, reject. Default: not required.
 *
 * Returns normalized { receiptId, bolt11, senderNpubHex,
 * recipientNpubHex, amountMsat, amountSats, zapRequestEventId,
 * zapperServicePubkey, receiptCreatedAt, rawZapRequest } on success.
 *
 * NOTE: This function does NOT touch Mongo, the network, or the
 * BTC/USD price oracle. The caller is responsible for converting
 * amountSats → microUSD and persisting.
 */

const crypto = require('crypto');
const bolt11 = require('bolt11');
const { verifyEvent } = require('nostr-tools');
const { classifyAnonTag, decryptPrivateZap } = require('./privateZapDecoder');

const HEX64 = /^[0-9a-f]{64}$/;

function fail(reason, detail) {
  return { ok: false, reason, detail: detail || null };
}

function isHex64(s) {
  return typeof s === 'string' && HEX64.test(s.toLowerCase());
}

function findTag(event, name) {
  if (!event || !Array.isArray(event.tags)) return null;
  const t = event.tags.find((tag) => Array.isArray(tag) && tag[0] === name);
  return t ? t[1] : null;
}

function findTagAll(event, name) {
  if (!event || !Array.isArray(event.tags)) return [];
  return event.tags
    .filter((tag) => Array.isArray(tag) && tag[0] === name)
    .map((tag) => tag[1]);
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function decodeBolt11(invoiceStr) {
  try {
    return bolt11.decode(invoiceStr);
  } catch (err) {
    return null;
  }
}

function getBolt11Tag(decoded, tagName) {
  if (!decoded || !Array.isArray(decoded.tags)) return null;
  const t = decoded.tags.find((tag) => tag.tagName === tagName);
  return t ? t.data : null;
}

/**
 * Validate a NIP-57 zap receipt.
 *
 * Anonymous-zap handling:
 *   The validator inspects the inner zap-request 9734 for an `anon`
 *   tag. The tag has three possible meanings:
 *     - absent          → public zap, sender = zapRequest.pubkey
 *     - present + empty → truly anonymous, return
 *                         `{ ok:false, reason:'anonymous-zap-unattributable' }`
 *                         The watcher uses this signal to skip
 *                         persisting the row entirely (we don't want
 *                         orphan credits in our DB).
 *     - present + value → private zap. Attempt NIP-04 decryption of
 *                         the encrypted payload using the bot's nsec
 *                         + the outer ephemeral pubkey. On success
 *                         the inner kind-9733's `pubkey` becomes the
 *                         sender. On failure → reject as
 *                         `private-zap-decrypt-failed`.
 *
 * @param {Object} params
 * @param {Object} params.receipt              kind:9735 event from relay
 * @param {string} params.botPubkeyHex         hex 64 — recipient
 * @param {string[]} params.trustedZapperPubkeys hex 64[] — accepted signers
 * @param {Uint8Array} [params.botSecretKey]   bot's nsec bytes (32). Required to
 *                                             decrypt private zaps; if absent and
 *                                             the receipt is a private zap, it
 *                                             will be rejected as
 *                                             `private-zap-no-key`.
 * @param {boolean} [params.requireValidPreimage=false]
 * @param {number}  [params.amountToleranceBps=0] under-tolerance in basis points
 * @returns {{ ok: true, normalized: object } | { ok: false, reason: string, detail: string|null }}
 */
function validateZapReceipt(params) {
  const {
    receipt,
    botPubkeyHex,
    trustedZapperPubkeys,
    botSecretKey = null,
    requireValidPreimage = false,
    amountToleranceBps = 0,
  } = params || {};

  if (!receipt || typeof receipt !== 'object') {
    return fail('bad-receipt', 'receipt missing');
  }
  if (!isHex64(botPubkeyHex)) {
    return fail('bad-input', 'botPubkeyHex must be 64-char hex');
  }
  if (!Array.isArray(trustedZapperPubkeys) || trustedZapperPubkeys.length === 0) {
    return fail('bad-input', 'trustedZapperPubkeys empty');
  }

  // 1. Structural
  if (receipt.kind !== 9735) return fail('not-zap-receipt', `kind=${receipt.kind}`);
  if (!isHex64(receipt.id)) return fail('bad-receipt', 'id not 64-hex');
  if (!isHex64(receipt.pubkey)) return fail('bad-receipt', 'pubkey not 64-hex');
  if (typeof receipt.sig !== 'string' || receipt.sig.length !== 128) {
    return fail('bad-receipt', 'sig missing or wrong length');
  }
  if (typeof receipt.created_at !== 'number' || receipt.created_at <= 0) {
    return fail('bad-receipt', 'created_at invalid');
  }
  if (!Array.isArray(receipt.tags)) return fail('bad-receipt', 'tags not array');

  // 2. Signature on receipt
  let receiptSigOk = false;
  try {
    receiptSigOk = verifyEvent(receipt);
  } catch (err) {
    return fail('sig-error', err.message);
  }
  if (!receiptSigOk) return fail('bad-sig', 'receipt signature invalid');

  // 3. Trust gate — receipt signer must be a known zapper service
  const trustSet = new Set(trustedZapperPubkeys.map((s) => String(s).toLowerCase()));
  if (!trustSet.has(receipt.pubkey.toLowerCase())) {
    return fail('untrusted-zapper', `signer=${receipt.pubkey}`);
  }

  // 4. Recipient
  const pTags = findTagAll(receipt, 'p');
  if (!pTags.includes(botPubkeyHex.toLowerCase())) {
    return fail('not-for-bot', 'no #p tag matching botPubkeyHex');
  }

  // 5. Description = zap request JSON
  const description = findTag(receipt, 'description');
  if (typeof description !== 'string' || description.length === 0) {
    return fail('no-description', 'missing description tag');
  }
  let zapRequest;
  try {
    zapRequest = JSON.parse(description);
  } catch (err) {
    return fail('bad-description', `JSON parse failed: ${err.message}`);
  }
  if (!zapRequest || zapRequest.kind !== 9734) {
    return fail('not-zap-request', `inner kind=${zapRequest && zapRequest.kind}`);
  }
  if (!isHex64(zapRequest.pubkey)) {
    return fail('bad-zap-request', 'sender pubkey not 64-hex');
  }
  let zapReqSigOk = false;
  try {
    zapReqSigOk = verifyEvent(zapRequest);
  } catch (err) {
    return fail('zap-request-sig-error', err.message);
  }
  if (!zapReqSigOk) return fail('bad-zap-request-sig', 'zap request signature invalid');

  const zapReqPTags = findTagAll(zapRequest, 'p');
  if (!zapReqPTags.includes(botPubkeyHex.toLowerCase())) {
    return fail('zap-request-not-for-bot', 'zap request #p does not match bot');
  }

  // 6. bolt11
  const bolt11Str = findTag(receipt, 'bolt11');
  if (typeof bolt11Str !== 'string' || bolt11Str.length === 0) {
    return fail('no-bolt11', 'missing bolt11 tag');
  }
  const decoded = decodeBolt11(bolt11Str);
  if (!decoded) return fail('bad-bolt11', 'bolt11 decode failed');

  // 7. Binding: description_hash or description on the invoice must
  //    match the receipt's description tag.
  const invoiceDescHash = getBolt11Tag(decoded, 'purpose_commit_hash')
    || getBolt11Tag(decoded, 'description_hash');
  const invoiceDesc = getBolt11Tag(decoded, 'description');
  const expectedHash = sha256Hex(description);

  let bindingOk = false;
  if (typeof invoiceDescHash === 'string' && invoiceDescHash.toLowerCase() === expectedHash) {
    bindingOk = true;
  } else if (Buffer.isBuffer(invoiceDescHash) && invoiceDescHash.toString('hex').toLowerCase() === expectedHash) {
    bindingOk = true;
  } else if (typeof invoiceDesc === 'string' && invoiceDesc === description) {
    bindingOk = true;
  }
  if (!bindingOk) {
    return fail('binding-mismatch', `invoice description_hash != sha256(description)`);
  }

  // 8. Amount sanity
  // bolt11 lib exposes .millisatoshis (string) or .satoshis (number) for the
  // invoice amount. Normalize to msat number; treat unset as failure.
  let invoiceMsat = null;
  if (decoded.millisatoshis) {
    invoiceMsat = parseInt(decoded.millisatoshis, 10);
  } else if (typeof decoded.satoshis === 'number') {
    invoiceMsat = decoded.satoshis * 1000;
  }
  if (!Number.isFinite(invoiceMsat) || invoiceMsat <= 0) {
    return fail('zero-amount', 'invoice amount missing or zero');
  }

  const requestedAmountStr = findTag(zapRequest, 'amount');
  if (requestedAmountStr) {
    const requestedMsat = parseInt(requestedAmountStr, 10);
    if (Number.isFinite(requestedMsat) && requestedMsat > 0) {
      const minAcceptable = Math.floor(requestedMsat * (10000 - amountToleranceBps) / 10000);
      if (invoiceMsat < minAcceptable) {
        return fail('underpaid', `invoice ${invoiceMsat}msat < requested ${requestedMsat}msat`);
      }
    }
  }

  // 9. Optional preimage
  if (requireValidPreimage) {
    const preimage = findTag(receipt, 'preimage');
    if (typeof preimage !== 'string' || !/^[0-9a-f]{64}$/i.test(preimage)) {
      return fail('no-preimage', 'preimage missing or malformed');
    }
    const paymentHash = getBolt11Tag(decoded, 'payment_hash');
    const phHex = Buffer.isBuffer(paymentHash) ? paymentHash.toString('hex') : paymentHash;
    if (typeof phHex !== 'string') {
      return fail('no-payment-hash', 'invoice missing payment_hash');
    }
    const computed = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    if (computed.toLowerCase() !== phHex.toLowerCase()) {
      return fail('bad-preimage', 'sha256(preimage) != payment_hash');
    }
  }

  // 10. Anonymous / private zap handling. Inspect the inner zap
  //     request for an `anon` tag.
  //       - absent         → public zap, ordinary sender resolution
  //       - present empty  → truly anonymous (no encrypted payload),
  //                          unattributable: reject early so the
  //                          watcher can skip persisting it
  //       - present value  → private zap, decrypt and use inner pubkey
  const anonClass = classifyAnonTag(zapRequest);
  let senderHex;
  let zapFlavor = 'public';
  let privateZapInnerEvent = null;

  if (anonClass.kind === 'anonymous') {
    return fail(
      'anonymous-zap-unattributable',
      'zap request has an empty `anon` tag — sender is an ephemeral key with no recoverable identity',
    );
  }

  if (anonClass.kind === 'private') {
    if (!botSecretKey) {
      return fail(
        'private-zap-no-key',
        'private zap detected but no botSecretKey provided to validator',
      );
    }
    const decrypted = decryptPrivateZap({
      anonValue: anonClass.value,
      botSecretKey,
      outerZapRequest: zapRequest,
    });
    if (!decrypted.ok) {
      return fail(
        'private-zap-decrypt-failed',
        `${decrypted.reason}${decrypted.detail ? ': ' + decrypted.detail : ''}`,
      );
    }
    senderHex = decrypted.realSenderHex;
    zapFlavor = 'private';
    privateZapInnerEvent = decrypted.innerEvent;
  } else {
    // Public zap: prefer the receipt's capital-P sender tag
    // (NIP-57 optional but commonly present from Alby), else fall
    // back to the inner zap request pubkey.
    const senderFromReceiptP = findTag(receipt, 'P');
    senderHex = isHex64(senderFromReceiptP)
      ? senderFromReceiptP.toLowerCase()
      : zapRequest.pubkey.toLowerCase();
  }

  const amountSats = Math.floor(invoiceMsat / 1000);

  return {
    ok: true,
    normalized: {
      receiptId: receipt.id.toLowerCase(),
      bolt11: bolt11Str,
      senderNpubHex: senderHex,
      recipientNpubHex: botPubkeyHex.toLowerCase(),
      amountMsat: invoiceMsat,
      amountSats,
      zapRequestEventId: isHex64(zapRequest.id) ? zapRequest.id.toLowerCase() : null,
      zapperServicePubkey: receipt.pubkey.toLowerCase(),
      receiptCreatedAt: receipt.created_at,
      rawZapRequest: zapRequest,
      zapFlavor, // 'public' | 'private'
      privateZapInnerEvent, // kind-9733 from the decrypted anon blob, or null
    },
  };
}

module.exports = { validateZapReceipt };
