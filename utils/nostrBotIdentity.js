/**
 * Nostr Bot Identity
 *
 * Loads the bot's nsec from env (`JAMIE_BOT_NSEC_BECH32`) and derives
 * Uint8Array secret key + hex pubkey + bech32 npub. Memoizes after the
 * first successful load. Throws on first access if the env is missing.
 *
 * The lightning address (`JAMIE_BOT_LN_ADDRESS`) is exposed here too so
 * one require() gives callers everything they need to identify and
 * receipt the bot.
 */

const { nip19, getPublicKey } = require('nostr-tools');

let cache = null;

function loadIdentity() {
  if (cache) return cache;

  const nsec = process.env.JAMIE_BOT_NSEC_BECH32;
  if (!nsec || typeof nsec !== 'string' || !nsec.trim()) {
    throw new Error(
      'JAMIE_BOT_NSEC_BECH32 is required. Set it in your .env file.',
    );
  }

  let decoded;
  try {
    decoded = nip19.decode(nsec.trim());
  } catch (err) {
    throw new Error(`JAMIE_BOT_NSEC_BECH32 failed to decode: ${err.message}`);
  }

  if (decoded.type !== 'nsec') {
    throw new Error(
      `JAMIE_BOT_NSEC_BECH32 must be an nsec1... key. Got type: ${decoded.type}`,
    );
  }

  const secretKey = decoded.data;
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    throw new Error(
      'JAMIE_BOT_NSEC_BECH32 decoded to unexpected secret-key shape (expected Uint8Array(32))',
    );
  }

  const pubkeyHex = getPublicKey(secretKey);
  const npub = nip19.npubEncode(pubkeyHex);
  const lnAddress = (process.env.JAMIE_BOT_LN_ADDRESS || '').trim() || null;

  cache = {
    secretKey,
    pubkeyHex,
    npub,
    lnAddress,
  };

  return cache;
}

function getBotSecretKey() {
  return loadIdentity().secretKey;
}

function getBotPubkeyHex() {
  return loadIdentity().pubkeyHex;
}

function getBotNpub() {
  return loadIdentity().npub;
}

function getBotLnAddress() {
  return loadIdentity().lnAddress;
}

function isBotEnabled() {
  return process.env.NOSTR_BOT_ENABLED === 'true';
}

module.exports = {
  getBotSecretKey,
  getBotPubkeyHex,
  getBotNpub,
  getBotLnAddress,
  isBotEnabled,
};
