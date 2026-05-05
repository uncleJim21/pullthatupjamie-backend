/**
 * Nostr Reply Builder
 *
 * Converts an agent text response (with embedded {{clip:...}} tokens
 * and possibly markdown bullets) into a NIP-10 threaded kind:1 event
 * signed by the bot's nsec.
 *
 * Tokens like `{{clip:abc123}}` are rendered as
 * `https://pullthatupjamie.ai/share?clip=abc123` since Nostr clients
 * don't know about Jamie's clip cards but DO auto-link plain URLs.
 *
 * NIP-10 threading: every reply tags the original mention as both
 * "root" and "reply" (we treat each mention as a fresh thread). The
 * mention author's pubkey goes into a `p` tag so they get a
 * notification. If the mention itself was a reply in a longer
 * thread (its own `e` tags carry markers root/reply), we preserve
 * those so the entire thread is properly linked.
 *
 * Length cap: 1500 chars. Truncation falls back to the last
 * whitespace boundary plus an ellipsis.
 */

const { finalizeEvent, nip19 } = require('nostr-tools');
const { getBotSecretKey } = require('./nostrBotIdentity');

/**
 * Render a hex pubkey as a Nostr-21 mention URI that clients
 * actually recognize as a mention (`nostr:npub1...`). Damus,
 * Primal, Amethyst etc. all replace this with an inline clickable
 * mention card showing the user's name + avatar. Without the
 * `nostr:` prefix and bech32 encoding, the bare `@<hex>` is just
 * literal text — no notification, no rendering.
 *
 * The `p` tag in event.tags is what actually drives notifications;
 * the `nostr:npub1...` in content is what makes it visually
 * obvious who the message is for.
 */
function pubkeyToNostrMention(hex) {
  if (!hex || typeof hex !== 'string') return '';
  try {
    return `nostr:${nip19.npubEncode(hex)}`;
  } catch (_) {
    return '';
  }
}

const SHARE_BASE_URL = 'https://pullthatupjamie.ai/share';
// Nostr kind:1 has no protocol-level character limit; this cap is
// purely a defensive guard against relays that reject huge messages
// (Damus-style relays typically accept 256KB; nostr.wine 64KB) and
// against runaway agent outputs. 32000 chars ≈ 32KB which is safely
// under every relay limit we care about while still covering
// multi-paragraph "summarize N things" responses with headroom.
const REPLY_MAX_CHARS = 32000;
const ELLIPSIS = '…';

const CLIP_RE = /\{\{clip:([^}]+)\}\}/g;

function renderClipTokens(text) {
  if (!text) return '';
  return text.replace(CLIP_RE, (_, shareLink) => {
    const safe = String(shareLink).trim();
    if (!safe) return '';
    return `${SHARE_BASE_URL}?clip=${encodeURIComponent(safe)}`;
  });
}

/**
 * Light markdown→plain-text pass. Nostr clients don't render
 * markdown, so leaving in `**bold**` and `[label](url)` looks ugly.
 * We collapse common patterns to plain text + URLs.
 */
function stripUnsupportedMarkdown(text) {
  if (!text) return '';
  let out = text;
  // [label](url) → "label (url)"
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)');
  // **bold** → bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  // *italic* / _italic_ → italic (but only when not inside a URL)
  out = out.replace(/(?<![A-Za-z0-9])\*([^*\n]+)\*(?![A-Za-z0-9])/g, '$1');
  // Heading hashes "## Foo" → "Foo"
  out = out.replace(/^#{1,6}\s+/gm, '');
  // Inline code `foo` → foo (Nostr clients render backticks literally)
  out = out.replace(/`([^`\n]+)`/g, '$1');
  return out;
}

/**
 * Truncate at a whitespace boundary if possible. Always under
 * REPLY_MAX_CHARS chars including the ellipsis.
 */
function capLength(text) {
  if (!text) return '';
  if (text.length <= REPLY_MAX_CHARS) return text;
  const slice = text.slice(0, REPLY_MAX_CHARS - ELLIPSIS.length - 1);
  const lastWs = slice.lastIndexOf(' ');
  const safe = lastWs > REPLY_MAX_CHARS / 2 ? slice.slice(0, lastWs) : slice;
  return safe.trimEnd() + ELLIPSIS;
}

function normalizeAgentText(text) {
  return capLength(stripUnsupportedMarkdown(renderClipTokens(text || '')).trim());
}

/**
 * Build the `tags` array for the NIP-10 reply.
 *
 * Strategy: this reply targets the mention as both root and reply
 * marker (single-event thread). If the mention itself carries `e`
 * tags with markers root/reply, we propagate the original "root" so
 * the full thread is preserved, and treat the mention as our reply
 * marker.
 */
function buildThreadTags(mentionEvent, relayHint = '') {
  const tags = [];

  // Find existing root marker on the mention. If present, our reply
  // tags should keep that root and add the mention as the reply.
  let inheritedRootId = null;
  let inheritedRootRelay = '';
  if (Array.isArray(mentionEvent.tags)) {
    for (const t of mentionEvent.tags) {
      if (Array.isArray(t) && t[0] === 'e' && t[3] === 'root') {
        inheritedRootId = t[1];
        inheritedRootRelay = t[2] || '';
        break;
      }
    }
  }

  if (inheritedRootId && inheritedRootId !== mentionEvent.id) {
    tags.push(['e', inheritedRootId, inheritedRootRelay, 'root']);
    tags.push(['e', mentionEvent.id, relayHint, 'reply']);
  } else {
    tags.push(['e', mentionEvent.id, relayHint, 'root']);
  }

  // Always p-tag the author of the mention. NIP-10 also recommends
  // propagating all upstream p-tags so the whole thread is notified;
  // for V1 we just notify the immediate author to keep things simple.
  tags.push(['p', mentionEvent.pubkey]);

  return tags;
}

/**
 * Build a signed kind:1 reply event ready to publish.
 *
 * @param {Object} params
 * @param {Object} params.mentionEvent  the kind:1 we are replying to (raw event)
 * @param {string} params.text          agent answer (may include {{clip:...}})
 * @param {string} [params.relayHint]   optional relay URL to include in e tags
 * @returns {Object} signed Nostr event
 */
function buildReplyEvent({ mentionEvent, text, relayHint = '' }) {
  if (!mentionEvent || typeof mentionEvent.id !== 'string') {
    throw new Error('mentionEvent.id is required to build a reply');
  }
  const cleanText = normalizeAgentText(text);
  if (!cleanText) {
    throw new Error('reply text is empty after normalization');
  }
  const tags = buildThreadTags(mentionEvent, relayHint);
  const eventTemplate = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content: cleanText,
    tags,
  };
  return finalizeEvent(eventTemplate, getBotSecretKey());
}

/**
 * Build a signed insufficient-balance reply. Standalone helper so
 * the worker can drop a quick "fund me" note even when the agent
 * never ran. Includes the bot's lightning address (lud16) so the
 * caller can zap to top up.
 *
 * The copy explicitly calls out the public-vs-private-vs-anonymous
 * distinction because anonymous zaps (which use throwaway keypairs
 * with no recoverable identity) can't be tied to the user's npub
 * and so won't credit their balance. Private "only Jamie sees"
 * zaps work fine because we decrypt the inner zap request to
 * recover the real sender. Public zaps obviously work too.
 */
function buildInsufficientBalanceReply({ mentionEvent, lnAddress, costUsd, balanceUsd, relayHint = '' }) {
  const lines = [];
  const mention = pubkeyToNostrMention(mentionEvent.pubkey);
  // Lead with a proper Nostr-21 mention so the user sees a
  // clickable inline card (and so they don't see a hex prefix that
  // looks broken). If encoding somehow fails we fall back to
  // skipping the mention prefix entirely — the `p` tag still drives
  // the notification.
  const greet = mention ? `${mention} you don't have enough balance for a Jamie Pull yet.` : `You don't have enough balance for a Jamie Pull yet.`;
  lines.push(greet);
  if (typeof costUsd === 'number') {
    lines.push(`Each Jamie Pull costs about $${costUsd.toFixed(2)}.`);
  }
  if (typeof balanceUsd === 'number' && balanceUsd > 0) {
    lines.push(`Current balance: $${balanceUsd.toFixed(4)}.`);
  } else {
    lines.push(`You have no balance yet.`);
  }
  if (lnAddress) {
    lines.push(
      `Zap me at ${lnAddress} (any amount) and I'll credit your npub. Public OR private ("only Jamie sees") zaps both work — but anonymous zaps can't be tied to you, so they won't credit. Try again once funds arrive.`,
    );
  } else {
    lines.push(
      `Zap me to top up and try again once funds arrive. Public or private zaps work — anonymous zaps can't be tied to your npub.`,
    );
  }
  return buildReplyEvent({ mentionEvent, text: lines.join(' '), relayHint });
}

module.exports = {
  buildReplyEvent,
  buildInsufficientBalanceReply,
  pubkeyToNostrMention,
  // Exported for unit tests:
  renderClipTokens,
  stripUnsupportedMarkdown,
  capLength,
  normalizeAgentText,
  buildThreadTags,
  REPLY_MAX_CHARS,
};
