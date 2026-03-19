/**
 * Macaroon Utilities for L402 Protocol
 * 
 * Mints and verifies macaroons for the L402 credit system.
 * Uses the macaroons.js library (same lineage as LND/Aperture/Golem)
 * for cross-ecosystem interoperability.
 * 
 * Root key derivation: HMAC-SHA256(L402_MACAROON_SECRET, paymentHash)
 * This is deterministic per-invoice — no root key storage needed.
 */

const crypto = require('crypto');
const { MacaroonsBuilder, MacaroonsVerifier } = require('macaroons.js');

const LOCATION = 'https://www.pullthatupjamie.ai';
const MACAROON_TTL_DAYS = 90;

function getMacaroonSecret() {
  const secret = process.env.L402_MACAROON_SECRET;
  if (!secret) {
    throw new Error('L402_MACAROON_SECRET env var is required for L402 macaroon operations');
  }
  return secret;
}

/**
 * Derive a per-invoice root key from the server secret and payment hash.
 * Deterministic: same inputs always produce the same key.
 * 
 * @param {string} paymentHash - 64-char hex payment hash
 * @returns {Buffer} 32-byte root key
 */
function deriveRootKey(paymentHash) {
  return crypto.createHmac('sha256', getMacaroonSecret())
    .update(paymentHash)
    .digest();
}

/**
 * Mint a new macaroon for an L402 credential.
 * 
 * Expiry is set to MACAROON_TTL_DAYS from now (not the invoice expiry),
 * since the credential's useful life spans the entire credit balance,
 * which outlives the invoice by orders of magnitude.
 * 
 * @param {string} paymentHash - 64-char hex payment hash (becomes the identifier)
 * @returns {{ macaroonBase64: string, paymentHash: string }}
 */
function mintMacaroon(paymentHash) {
  const rootKey = deriveRootKey(paymentHash);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + MACAROON_TTL_DAYS);

  const macaroon = new MacaroonsBuilder(LOCATION, rootKey, paymentHash)
    .add_first_party_caveat(`service = pullthatupjamie`)
    .add_first_party_caveat(`payment_hash = ${paymentHash}`)
    .add_first_party_caveat(`expires_at = ${Math.floor(expiresAt.getTime() / 1000)}`)
    .getMacaroon();

  return {
    macaroonBase64: macaroon.serialize(),
    paymentHash
  };
}

/**
 * Verify a macaroon and extract its payment hash.
 * 
 * Checks:
 * 1. HMAC chain integrity (proves it was minted by this server)
 * 2. Service caveat matches
 * 3. Payment hash caveat present and consistent with identifier
 * 4. Expiry caveat not exceeded (for unpaid macaroons)
 * 
 * @param {string} macaroonBase64 - Base64url-encoded macaroon
 * @returns {{ valid: boolean, paymentHash: string|null, error: string|null }}
 */
function verifyMacaroon(macaroonBase64) {
  try {
    const macaroon = MacaroonsBuilder.deserialize(macaroonBase64);
    const paymentHash = macaroon.identifier;

    const hexPattern = /^[0-9a-fA-F]{64}$/;
    if (!hexPattern.test(paymentHash)) {
      return { valid: false, paymentHash: null, error: 'Invalid macaroon identifier (expected 64-char hex payment hash)' };
    }

    const rootKey = deriveRootKey(paymentHash);

    const verifier = new MacaroonsVerifier(macaroon);

    verifier.satisfyExact('service = pullthatupjamie');
    verifier.satisfyExact(`payment_hash = ${paymentHash}`);

    // General verifier for expires_at: check current time < expiry
    verifier.satisfyGeneral((caveat) => {
      if (!caveat.startsWith('expires_at = ')) return false;
      const expiryUnix = parseInt(caveat.split(' = ')[1], 10);
      if (isNaN(expiryUnix)) return false;
      return Math.floor(Date.now() / 1000) < expiryUnix;
    });

    const valid = verifier.isValid(rootKey);

    if (!valid) {
      return { valid: false, paymentHash, error: 'Macaroon HMAC verification failed or caveats not satisfied' };
    }

    return { valid: true, paymentHash, error: null };
  } catch (err) {
    return { valid: false, paymentHash: null, error: `Macaroon parsing error: ${err.message}` };
  }
}

/**
 * Parse an L402 Authorization header.
 * 
 * Expected format: "L402 <base64url_macaroon>:<hex_preimage>"
 * 
 * @param {string} authHeader - Raw Authorization header value
 * @returns {{ macaroonBase64: string, preimage: string } | null}
 */
function parseL402Header(authHeader) {
  if (!authHeader) return null;

  // L402 scheme is case-insensitive per RFC 7235
  const match = authHeader.match(/^L402\s+(.+):([0-9a-fA-F]{64})$/i);
  if (!match) return null;

  return {
    macaroonBase64: match[1],
    preimage: match[2]
  };
}

/**
 * Build the WWW-Authenticate header value for a 402 challenge.
 * 
 * @param {string} macaroonBase64 - Serialized macaroon
 * @param {string} invoice - BOLT-11 invoice string
 * @returns {string}
 */
function buildWwwAuthenticateHeader(macaroonBase64, invoice) {
  return `L402 macaroon="${macaroonBase64}", invoice="${invoice}"`;
}

module.exports = {
  mintMacaroon,
  verifyMacaroon,
  parseL402Header,
  buildWwwAuthenticateHeader,
  deriveRootKey
};
