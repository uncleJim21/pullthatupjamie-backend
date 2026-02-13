const crypto = require('crypto');
const BlogPost = require('../models/BlogPost');

/**
 * Generate a deterministic, human-readable slug from a blog post title and timestamp.
 * Format: kebab-case-title-YYYYMMDD
 * 
 * Rules:
 *   - Slug is generated ONCE on first ingestion and never changes
 *   - Slug must not contain the Nostr event ID
 *   - Collision resolution: append short hash of nostr_event_id if needed
 * 
 * @param {string} title - The blog post title
 * @param {number} createdAt - Unix timestamp (seconds) from the Nostr event
 * @param {string} nostrEventId - The Nostr event ID (used only for collision resolution)
 * @returns {Promise<string>} The generated slug
 */
async function generateSlug(title, createdAt, nostrEventId) {
  if (!title || typeof title !== 'string') {
    throw new Error('Title is required for slug generation');
  }
  if (!createdAt || typeof createdAt !== 'number') {
    throw new Error('createdAt timestamp is required for slug generation');
  }

  // Convert unix timestamp to YYYYMMDD
  const date = new Date(createdAt * 1000);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const dateSuffix = `${yyyy}${mm}${dd}`;

  // Convert title to kebab-case
  const kebab = title
    .toLowerCase()
    .trim()
    .replace(/['']/g, '')             // Remove apostrophes/smart quotes
    .replace(/[^a-z0-9\s-]/g, '')     // Strip non-alphanumeric (keep spaces and hyphens)
    .replace(/\s+/g, '-')             // Spaces to hyphens
    .replace(/-+/g, '-')              // Collapse multiple hyphens
    .replace(/^-|-$/g, '');           // Trim leading/trailing hyphens

  // Truncate to ~80 chars before date suffix for reasonable URL length
  const maxKebabLength = 80;
  let truncated = kebab;
  if (truncated.length > maxKebabLength) {
    truncated = truncated.substring(0, maxKebabLength);
    // Don't cut in the middle of a word — trim to last hyphen
    const lastHyphen = truncated.lastIndexOf('-');
    if (lastHyphen > maxKebabLength * 0.5) {
      truncated = truncated.substring(0, lastHyphen);
    }
  }

  const baseSlug = `${truncated}-${dateSuffix}`;

  // Check for collision
  const existing = await BlogPost.findOne({ slug: baseSlug });
  if (!existing) {
    return baseSlug;
  }

  // Collision resolution: append 4-char hash of nostr_event_id
  const hash = crypto
    .createHash('sha256')
    .update(nostrEventId || Date.now().toString())
    .digest('hex')
    .substring(0, 4);

  return `${baseSlug}-${hash}`;
}

module.exports = { generateSlug };
