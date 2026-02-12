const WebSocket = require('ws');
const BlogPost = require('../models/BlogPost');
const { generateSlug } = require('./blogSlugGenerator');
const { buildCanonicalUrl, buildMetaDescription, extractImageFromMarkdown } = require('./blogSeoHelpers');

// Subset of relays optimized for long-form content (kind 30023)
const BLOG_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nosto.re',
  'wss://nostr.oxtr.dev',
  'wss://eden.nostr.land'
];

const MIN_CONTENT_LENGTH = 500;

class BlogIngestionService {
  constructor() {
    this.pubkey = process.env.NOSTR_BLOG_PUBKEY || null;
    this.cutoff = parseInt(process.env.NOSTR_BLOG_CUTOFF, 10) || 0;
    this.enabled = process.env.NOSTR_BLOG_ENABLED === 'true';
  }

  /**
   * Main entry point — poll relays for new long-form posts and ingest them.
   * Designed to be called by a cron job.
   */
  async poll() {
    if (!this.enabled) {
      console.log('[BlogIngestion] Disabled via NOSTR_BLOG_ENABLED, skipping.');
      return { skipped: true, reason: 'disabled' };
    }

    if (!this.pubkey) {
      console.error('[BlogIngestion] NOSTR_BLOG_PUBKEY is not set, skipping.');
      return { skipped: true, reason: 'no_pubkey' };
    }

    console.log(`[BlogIngestion] Polling relays for kind:30023 from pubkey ${this.pubkey.substring(0, 12)}...`);

    // Determine "since" — use the most recent post's created_at, or fall back to cutoff
    const latestPost = await BlogPost.findOne({ pubkey: this.pubkey })
      .sort({ created_at: -1 })
      .select('created_at')
      .lean();
    
    const since = latestPost ? latestPost.created_at : this.cutoff;

    // Query all relays in parallel
    const results = await Promise.allSettled(
      BLOG_RELAYS.map(relay => this._queryRelay(relay, since))
    );

    // Collect all events, deduplicate by event id
    const eventMap = new Map();
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        for (const event of result.value) {
          if (!eventMap.has(event.id)) {
            eventMap.set(event.id, event);
          }
        }
      }
    }

    const events = Array.from(eventMap.values());
    console.log(`[BlogIngestion] Collected ${events.length} unique events from ${BLOG_RELAYS.length} relays.`);

    // Validate and ingest each event
    let ingested = 0;
    let updated = 0;
    let skipped = 0;

    for (const event of events) {
      try {
        const result = await this._processEvent(event);
        if (result === 'ingested') ingested++;
        else if (result === 'updated') updated++;
        else skipped++;
      } catch (err) {
        console.error(`[BlogIngestion] Error processing event ${event.id}:`, err.message);
        skipped++;
      }
    }

    const summary = { ingested, updated, skipped, total: events.length };
    console.log(`[BlogIngestion] Complete:`, summary);
    return summary;
  }

  /**
   * Query a single relay for kind:30023 events.
   * @returns {Promise<Array>} Array of Nostr events
   */
  _queryRelay(relayUrl, since) {
    return new Promise((resolve) => {
      const events = [];
      let socket = null;
      let resolved = false;
      const timeout = 15000;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (socket && socket.readyState === WebSocket.OPEN) {
          try { socket.close(); } catch (_) { /* ignore */ }
        }
        resolve(events);
      };

      const timer = setTimeout(() => {
        console.log(`[BlogIngestion] Timeout querying ${relayUrl}, returning ${events.length} events collected so far.`);
        finish();
      }, timeout);

      try {
        socket = new WebSocket(relayUrl);

        socket.onopen = () => {
          const subscriptionId = 'blog_' + Math.random().toString(36).substring(2, 9);
          const filter = {
            kinds: [30023],
            authors: [this.pubkey],
            since: since
          };
          socket.send(JSON.stringify(['REQ', subscriptionId, filter]));
        };

        socket.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);

            if (Array.isArray(data) && data[0] === 'EVENT' && data[2]) {
              events.push(data[2]);
            } else if (Array.isArray(data) && data[0] === 'EOSE') {
              clearTimeout(timer);
              finish();
            }
          } catch (_) { /* ignore parse errors */ }
        };

        socket.onerror = () => {
          clearTimeout(timer);
          finish();
        };

        socket.onclose = () => {
          clearTimeout(timer);
          finish();
        };

      } catch (err) {
        console.error(`[BlogIngestion] Failed to connect to ${relayUrl}:`, err.message);
        clearTimeout(timer);
        finish();
      }
    });
  }

  /**
   * Validate and ingest/update a single Nostr event.
   * @returns {Promise<string>} 'ingested' | 'updated' | 'skipped'
   */
  async _processEvent(event) {
    // --- Validation ---
    if (event.kind !== 30023) return 'skipped';
    if (event.pubkey !== this.pubkey) return 'skipped';
    if (event.created_at <= this.cutoff) return 'skipped';

    const title = this._getTag(event, 'title');
    if (!title) {
      console.log(`[BlogIngestion] Skipping event ${event.id}: no title tag.`);
      return 'skipped';
    }

    if (!event.content || event.content.length < MIN_CONTENT_LENGTH) {
      console.log(`[BlogIngestion] Skipping event ${event.id}: content too short (${event.content?.length || 0} < ${MIN_CONTENT_LENGTH}).`);
      return 'skipped';
    }

    // --- Extract metadata from tags ---
    const dTag = this._getTag(event, 'd');
    const summary = this._getTag(event, 'summary') || '';
    const image = this._getTag(event, 'image') || extractImageFromMarkdown(event.content) || '';
    const publishedAt = parseInt(this._getTag(event, 'published_at'), 10) || event.created_at;
    const tTags = (event.tags || [])
      .filter(t => t[0] === 't')
      .map(t => t[1])
      .filter(Boolean);

    // --- Check for existing post (edit detection via d tag or event id) ---
    let existing = null;
    if (dTag) {
      existing = await BlogPost.findOne({ pubkey: this.pubkey, nostr_d_tag: dTag });
    }
    if (!existing) {
      existing = await BlogPost.findOne({ nostr_event_id: event.id });
    }

    if (existing) {
      // Update existing post — preserve slug, update content
      if (event.created_at <= existing.updated_at) {
        return 'skipped'; // Older or same version, skip
      }

      existing.nostr_event_id = event.id;
      existing.title = title;
      existing.summary = summary;
      existing.content_md = event.content;
      existing.updated_at = event.created_at;
      existing.tags = tTags;
      existing.source_url = this._getTag(event, 'r') || existing.source_url;

      // Refresh SEO fields
      existing.seo.meta_description = buildMetaDescription(existing);
      existing.seo.canonical_url = buildCanonicalUrl(existing.slug);
      existing.seo.og_image = image;

      await existing.save();
      console.log(`[BlogIngestion] Updated post: "${title}" (slug: ${existing.slug})`);
      return 'updated';
    }

    // --- New post: generate slug and insert ---
    const slug = await generateSlug(title, publishedAt, event.id);

    const post = new BlogPost({
      nostr_event_id: event.id,
      nostr_d_tag: dTag || null,
      pubkey: event.pubkey,
      title,
      slug,
      summary,
      content_md: event.content,
      created_at: publishedAt,
      updated_at: event.created_at,
      source: 'stacker.news',
      source_url: this._getTag(event, 'r') || '',
      status: 'published',
      tags: tTags,
      seo: {
        meta_description: '',  // Will be set below
        canonical_url: buildCanonicalUrl(slug),
        og_image: image
      }
    });

    // Compute meta_description after doc is built (needs content_md populated)
    post.seo.meta_description = buildMetaDescription(post);

    await post.save();
    console.log(`[BlogIngestion] Ingested new post: "${title}" (slug: ${slug})`);
    return 'ingested';
  }

  /**
   * Extract a tag value from a Nostr event.
   * @param {Object} event
   * @param {string} tagName
   * @returns {string|null}
   */
  _getTag(event, tagName) {
    if (!event.tags || !Array.isArray(event.tags)) return null;
    const tag = event.tags.find(t => t[0] === tagName);
    return tag ? tag[1] : null;
  }
}

module.exports = BlogIngestionService;
