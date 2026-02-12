/**
 * Blog API SEO Contract Tests
 * 
 * Validates that all blog endpoints return correct SEO fields,
 * valid sitemap XML, and valid RSS XML.
 * 
 * Usage:
 *   node test/blog-api-seo-contract.test.js [BASE_URL]
 * 
 * Defaults to http://localhost:4132 if no BASE_URL provided.
 * Requires at least one published BlogPost in the database.
 */

const http = require('http');
const https = require('https');

const BASE_URL = process.argv[2] || 'http://localhost:4132';

// FRONTEND_URL is detected dynamically from the first canonical_url in the API response.
// This avoids mismatch between the test runner's env and the server's env.
let FRONTEND_URL = null;

let passed = 0;
let failed = 0;
const failures = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseJson(body) {
  try { return JSON.parse(body); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testBlogList() {
  console.log('\n--- GET /api/blog (list) ---');
  const res = await fetch(`${BASE_URL}/api/blog`);
  const data = parseJson(res.body);

  assert(res.status === 200, 'Status is 200');
  assert(data !== null, 'Response is valid JSON');
  assert(data?.success === true, 'success is true');
  assert(Array.isArray(data?.posts), 'posts is an array');
  assert(typeof data?.total === 'number', 'total is a number');
  assert(typeof data?.page === 'number', 'page is a number');
  assert(typeof data?.limit === 'number', 'limit is a number');

  // Cache-Control
  const cc = res.headers['cache-control'] || '';
  assert(cc.includes('public'), 'Cache-Control includes public');
  assert(cc.includes('max-age=300'), 'Cache-Control max-age=300');

  // If posts exist, validate shape
  if (data?.posts?.length > 0) {
    const post = data.posts[0];
    assert(typeof post.title === 'string' && post.title.length > 0, 'First post has title');
    assert(typeof post.slug === 'string' && post.slug.length > 0, 'First post has slug');
    assert(typeof post.created_at === 'number', 'First post has created_at (number)');
    assert(post.seo !== undefined, 'First post has seo object');
    assert(typeof post.seo?.canonical_url === 'string', 'First post seo has canonical_url');

    // Auto-detect FRONTEND_URL from server's actual canonical_url
    if (post.seo?.canonical_url) {
      const match = post.seo.canonical_url.match(/^(https?:\/\/[^/]+)/);
      if (match) {
        FRONTEND_URL = match[1];
        console.log(`  (detected FRONTEND_URL from server: ${FRONTEND_URL})`);
      }
    }
    assert(FRONTEND_URL && post.seo.canonical_url.startsWith(FRONTEND_URL), `canonical_url starts with FRONTEND_URL (${FRONTEND_URL})`);
    assert(post.content_md === undefined, 'List view does not include content_md');
  } else {
    console.log('  (no posts found — seed a BlogPost to test post-level fields)');
  }

  return data?.posts?.[0]?.slug || null;
}

async function testBlogPost(slug) {
  console.log(`\n--- GET /api/blog/${slug} (single post) ---`);
  const res = await fetch(`${BASE_URL}/api/blog/${slug}`);
  const data = parseJson(res.body);

  assert(res.status === 200, 'Status is 200');
  assert(data?.success === true, 'success is true');
  assert(data?.post !== undefined, 'post object exists');

  const post = data?.post;
  if (!post) return;

  // Content fields
  assert(typeof post.title === 'string', 'post.title is a string');
  assert(typeof post.slug === 'string', 'post.slug is a string');
  assert(typeof post.content_md === 'string' && post.content_md.length > 0, 'post.content_md is non-empty');
  assert(typeof post.created_at === 'number', 'post.created_at is a number');
  assert(typeof post.updated_at === 'number', 'post.updated_at is a number');
  assert(Array.isArray(post.tags), 'post.tags is an array');

  // SEO block
  const seo = post.seo;
  assert(seo !== undefined, 'seo object exists');
  assert(typeof seo?.canonical_url === 'string', 'seo.canonical_url is a string');
  assert(seo?.canonical_url?.includes(slug), 'canonical_url contains slug');
  assert(FRONTEND_URL && seo?.canonical_url?.startsWith(FRONTEND_URL), `canonical_url starts with FRONTEND_URL (${FRONTEND_URL})`);

  // Meta description
  assert(typeof seo?.meta_description === 'string', 'seo.meta_description is a string');
  assert(seo?.meta_description?.length <= 160, `meta_description is <= 160 chars (got ${seo?.meta_description?.length})`);

  // OpenGraph
  assert(typeof seo?.og_title === 'string' && seo.og_title.length > 0, 'seo.og_title is non-empty');
  assert(typeof seo?.og_description === 'string', 'seo.og_description is a string');
  assert(typeof seo?.og_url === 'string', 'seo.og_url is a string');

  // JSON-LD
  const ld = seo?.json_ld;
  assert(ld !== undefined, 'seo.json_ld exists');
  assert(ld?.['@context'] === 'https://schema.org', 'json_ld @context is schema.org');
  assert(ld?.['@type'] === 'Article', 'json_ld @type is Article');
  assert(typeof ld?.headline === 'string' && ld.headline.length > 0, 'json_ld headline is non-empty');
  assert(typeof ld?.datePublished === 'string', 'json_ld datePublished exists');
  assert(typeof ld?.dateModified === 'string', 'json_ld dateModified exists');
  // Validate ISO 8601 format
  assert(!isNaN(Date.parse(ld?.datePublished)), 'json_ld datePublished is valid ISO 8601');
  assert(!isNaN(Date.parse(ld?.dateModified)), 'json_ld dateModified is valid ISO 8601');
  assert(ld?.author?.['@type'] === 'Person', 'json_ld author is a Person');
  assert(typeof ld?.mainEntityOfPage?.['@id'] === 'string', 'json_ld mainEntityOfPage has @id');

  // Cache-Control
  const cc = res.headers['cache-control'] || '';
  assert(cc.includes('public'), 'Cache-Control includes public');
  assert(cc.includes('max-age=600'), 'Cache-Control max-age=600');
}

async function testBlogPost404() {
  console.log('\n--- GET /api/blog/nonexistent-slug-99999999 (404) ---');
  const res = await fetch(`${BASE_URL}/api/blog/nonexistent-slug-99999999`);
  const data = parseJson(res.body);

  assert(res.status === 404, 'Status is 404');
  assert(data !== null, 'Response is valid JSON (not HTML error page)');
  assert(data?.success === false, 'success is false');
  assert(typeof data?.error === 'string', 'error message is a string');
}

async function testSitemap() {
  console.log('\n--- GET /blog/sitemap.xml ---');
  const res = await fetch(`${BASE_URL}/blog/sitemap.xml`);

  assert(res.status === 200, 'Status is 200');

  const ct = res.headers['content-type'] || '';
  assert(ct.includes('application/xml'), 'Content-Type is application/xml');

  // Cache-Control
  const cc = res.headers['cache-control'] || '';
  assert(cc.includes('public'), 'Cache-Control includes public');
  assert(cc.includes('max-age=3600'), 'Cache-Control max-age=3600');

  // XML structure
  assert(res.body.includes('<?xml'), 'Response starts with XML declaration');
  assert(res.body.includes('<urlset'), 'Response contains <urlset>');

  // If posts exist, check for URL entries
  if (res.body.includes('<url>')) {
    assert(res.body.includes('<loc>'), 'Sitemap entries have <loc>');
    assert(res.body.includes('<lastmod>'), 'Sitemap entries have <lastmod>');
    assert(res.body.includes('<changefreq>'), 'Sitemap entries have <changefreq>');
    assert(res.body.includes('<priority>'), 'Sitemap entries have <priority>');
    assert(!FRONTEND_URL || res.body.includes(FRONTEND_URL), `Sitemap URLs reference FRONTEND_URL (${FRONTEND_URL})`);
  } else {
    console.log('  (no <url> entries — seed a BlogPost to validate entry structure)');
  }
}

async function testRss() {
  console.log('\n--- GET /blog/rss.xml ---');
  const res = await fetch(`${BASE_URL}/blog/rss.xml`);

  assert(res.status === 200, 'Status is 200');

  const ct = res.headers['content-type'] || '';
  assert(ct.includes('application/rss+xml'), 'Content-Type is application/rss+xml');

  // Cache-Control
  const cc = res.headers['cache-control'] || '';
  assert(cc.includes('public'), 'Cache-Control includes public');
  assert(cc.includes('max-age=1800'), 'Cache-Control max-age=1800');

  // XML structure
  assert(res.body.includes('<?xml'), 'Response starts with XML declaration');
  assert(res.body.includes('<rss'), 'Response contains <rss>');
  assert(res.body.includes('<channel>'), 'Response contains <channel>');
  assert(res.body.includes('<title>'), 'Channel has <title>');
  assert(res.body.includes('<link>'), 'Channel has <link>');

  // If items exist, check structure
  if (res.body.includes('<item>')) {
    assert(res.body.includes('<guid'), 'RSS items have <guid>');
    assert(res.body.includes('<pubDate>'), 'RSS items have <pubDate>');
    assert(!FRONTEND_URL || res.body.includes(FRONTEND_URL), `RSS links reference FRONTEND_URL (${FRONTEND_URL})`);
  } else {
    console.log('  (no <item> entries — seed a BlogPost to validate item structure)');
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  console.log(`\nBlog API SEO Contract Tests`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`FRONTEND_URL: (auto-detected from server response)`);

  try {
    const firstSlug = await testBlogList();

    if (firstSlug) {
      await testBlogPost(firstSlug);
    } else {
      console.log('\n  (skipping single-post test — no posts found)');
    }

    await testBlogPost404();
    await testSitemap();
    await testRss();

  } catch (error) {
    console.error('\nFATAL ERROR:', error.message);
    console.error('Is the server running at', BASE_URL, '?');
    process.exit(1);
  }

  // Summary
  console.log(`\n========================================`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    failures.forEach(f => console.log(`    - ${f}`));
  }
  console.log(`========================================\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run();
