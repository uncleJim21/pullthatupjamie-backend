const express = require('express');
const router = express.Router();
const BlogPost = require('../models/BlogPost');
const { buildSeoBlock, buildCanonicalUrl, FRONTEND_URL, SITE_NAME } = require('../utils/blogSeoHelpers');

// =============================================================================
// GET /blog/sitemap.xml — XML Sitemap for search engines (public)
// IMPORTANT: Must be defined BEFORE /:slug to avoid wildcard capture
// =============================================================================
router.get('/sitemap.xml', async (req, res) => {
  try {
    const posts = await BlogPost.find({ status: 'published' })
      .sort({ created_at: -1 })
      .select('slug updated_at')
      .lean();

    const urls = posts.map(post => {
      const loc = buildCanonicalUrl(post.slug);
      const lastmod = new Date(post.updated_at * 1000).toISOString().split('T')[0]; // YYYY-MM-DD
      return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;

    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (error) {
    console.error('[Blog API] Error generating sitemap:', error.message);
    res.status(500).set('Content-Type', 'application/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'
    );
  }
});

// =============================================================================
// GET /blog/rss.xml — RSS 2.0 Feed (public)
// IMPORTANT: Must be defined BEFORE /:slug to avoid wildcard capture
// =============================================================================
router.get('/rss.xml', async (req, res) => {
  try {
    const posts = await BlogPost.find({ status: 'published' })
      .sort({ created_at: -1 })
      .limit(50)
      .select('title slug summary created_at tags')
      .lean();

    const items = posts.map(post => {
      const link = buildCanonicalUrl(post.slug);
      const pubDate = new Date(post.created_at * 1000).toUTCString();
      const categories = (post.tags || [])
        .map(tag => `      <category>${escapeXml(tag)}</category>`)
        .join('\n');

      return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <description>${escapeXml(post.summary || '')}</description>
      <pubDate>${pubDate}</pubDate>
${categories}
    </item>`;
    });

    const blogUrl = `${FRONTEND_URL.replace(/\/+$/, '')}/blog`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(SITE_NAME)} Blog</title>
    <link>${escapeXml(blogUrl)}</link>
    <description>Latest posts from ${escapeXml(SITE_NAME)}</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(blogUrl + '/rss.xml')}" rel="self" type="application/rss+xml" />
${items.join('\n')}
  </channel>
</rss>`;

    res.set('Content-Type', 'application/rss+xml');
    res.set('Cache-Control', 'public, max-age=1800');
    res.send(xml);
  } catch (error) {
    console.error('[Blog API] Error generating RSS feed:', error.message);
    res.status(500).set('Content-Type', 'application/rss+xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Error</title></channel></rss>'
    );
  }
});

// =============================================================================
// GET /api/blog — List published blog posts (public, no auth)
// =============================================================================
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const tag = req.query.tag || null;

    const filter = { status: 'published' };
    if (tag) {
      filter.tags = tag.toLowerCase();
    }

    const [posts, total] = await Promise.all([
      BlogPost.find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .select('-content_md -__v') // Exclude full content from list view
        .lean(),
      BlogPost.countDocuments(filter)
    ]);

    // Attach SEO block to each post in the list
    const enriched = posts.map(post => ({
      title: post.title,
      slug: post.slug,
      summary: post.summary,
      created_at: post.created_at,
      updated_at: post.updated_at,
      tags: post.tags,
      source_url: post.source_url,
      seo: {
        canonical_url: buildCanonicalUrl(post.slug),
        meta_description: post.seo?.meta_description || '',
        og_image: post.seo?.og_image || ''
      }
    }));

    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    res.json({
      success: true,
      posts: enriched,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('[Blog API] Error listing posts:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch blog posts' });
  }
});

// =============================================================================
// GET /api/blog/:slug — Get a single blog post by slug (public, no auth)
// =============================================================================
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const post = await BlogPost.findOne({ slug, status: 'published' })
      .select('-__v')
      .lean();

    if (!post) {
      return res.status(404).json({
        success: false,
        error: 'Blog post not found',
        slug
      });
    }

    // Build full SEO block for the single-post response
    const seo = buildSeoBlock(post);

    res.set('Cache-Control', 'public, max-age=600, stale-while-revalidate=120');
    res.json({
      success: true,
      post: {
        title: post.title,
        slug: post.slug,
        content_md: post.content_md,
        summary: post.summary,
        created_at: post.created_at,
        updated_at: post.updated_at,
        tags: post.tags,
        source: post.source,
        source_url: post.source_url,
        seo
      }
    });
  } catch (error) {
    console.error('[Blog API] Error fetching post:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch blog post' });
  }
});

// =============================================================================
// Helpers
// =============================================================================
function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = router;
