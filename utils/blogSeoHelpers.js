/**
 * SEO helper utilities for the blog system.
 * These generate pre-computed metadata that the frontend can embed directly.
 */

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://pullthatupjamie.com';
const SITE_NAME = 'Pull That Up Jamie';
const AUTHOR_NAME = process.env.BLOG_AUTHOR_NAME || 'Pull That Up Jamie';

/**
 * Build canonical URL from slug.
 * @param {string} slug
 * @returns {string}
 */
function buildCanonicalUrl(slug) {
  const base = FRONTEND_URL.replace(/\/+$/, '');
  return `${base}/blog/${slug}`;
}

/**
 * Build a meta description from summary or content.
 * Truncated to 155 chars for optimal SERP display.
 * @param {Object} post - Blog post document
 * @returns {string}
 */
function buildMetaDescription(post) {
  const source = post.summary || post.content_md || '';

  // Strip markdown formatting for a clean description
  const cleaned = source
    .replace(/#{1,6}\s+/g, '')       // Remove headings
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1') // Remove bold/italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Remove links, keep text
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')      // Remove images
    .replace(/`{1,3}[^`]*`{1,3}/g, '')        // Remove inline code
    .replace(/>\s+/g, '')             // Remove blockquotes
    .replace(/[-*+]\s+/g, '')         // Remove list markers
    .replace(/\n+/g, ' ')            // Newlines to spaces
    .replace(/\s+/g, ' ')            // Collapse whitespace
    .trim();

  if (cleaned.length <= 155) {
    return cleaned;
  }

  // Truncate at word boundary
  const truncated = cleaned.substring(0, 155);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 100) {
    return truncated.substring(0, lastSpace) + '...';
  }
  return truncated + '...';
}

/**
 * Build OpenGraph data object.
 * @param {Object} post - Blog post document
 * @returns {Object}
 */
function buildOgData(post) {
  const canonicalUrl = buildCanonicalUrl(post.slug);
  const description = buildMetaDescription(post);

  return {
    og_title: post.title,
    og_description: description,
    og_url: canonicalUrl,
    og_image: post.seo?.og_image || '',
    og_type: 'article',
    og_site_name: SITE_NAME
  };
}

/**
 * Build JSON-LD Article structured data.
 * Frontend can embed this directly in a <script type="application/ld+json"> tag.
 * @param {Object} post - Blog post document
 * @returns {Object}
 */
function buildJsonLd(post) {
  const canonicalUrl = buildCanonicalUrl(post.slug);
  const description = buildMetaDescription(post);

  // Convert unix timestamps to ISO 8601
  const datePublished = new Date(post.created_at * 1000).toISOString();
  const dateModified = new Date(post.updated_at * 1000).toISOString();

  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: description,
    datePublished: datePublished,
    dateModified: dateModified,
    author: {
      '@type': 'Person',
      name: AUTHOR_NAME
    },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: FRONTEND_URL
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': canonicalUrl
    },
    url: canonicalUrl,
    ...(post.seo?.og_image ? { image: post.seo.og_image } : {}),
    ...(post.tags?.length ? { keywords: post.tags.join(', ') } : {})
  };
}

/**
 * Build the complete SEO block for an API response.
 * @param {Object} post - Blog post document
 * @returns {Object}
 */
function buildSeoBlock(post) {
  const ogData = buildOgData(post);

  return {
    canonical_url: buildCanonicalUrl(post.slug),
    meta_description: buildMetaDescription(post),
    ...ogData,
    json_ld: buildJsonLd(post)
  };
}

/**
 * Extract an image URL from markdown content (first image found).
 * @param {string} markdown
 * @returns {string|null}
 */
function extractImageFromMarkdown(markdown) {
  if (!markdown) return null;
  const match = markdown.match(/!\[[^\]]*\]\(([^)]+)\)/);
  return match ? match[1] : null;
}

module.exports = {
  buildCanonicalUrl,
  buildMetaDescription,
  buildOgData,
  buildJsonLd,
  buildSeoBlock,
  extractImageFromMarkdown,
  FRONTEND_URL,
  SITE_NAME
};
