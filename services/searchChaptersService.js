/**
 * Search Chapters Service — keyword-based chapter search across the corpus.
 *
 * Pure business logic: accepts params, returns data. No req/res.
 */

const JamieVectorMetadata = require('../models/JamieVectorMetadata');

async function searchChapters({ search, feedIds = [], limit: rawLimit = 20, page: rawPage = 1 }) {
  if (!search || typeof search !== 'string' || search.trim().length === 0) {
    return { error: 'search is required', status: 400 };
  }

  const searchTerm = search.trim();
  const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 20), 200);
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const skip = (page - 1) * limit;

  const lower = searchTerm.toLowerCase();
  const upper = searchTerm.toUpperCase();
  const titleCase = searchTerm.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  const firstCap = searchTerm.charAt(0).toUpperCase() + searchTerm.slice(1).toLowerCase();
  const keywordVariants = [...new Set([searchTerm, lower, upper, titleCase, firstCap])];

  const query = {
    type: 'chapter',
    'metadataRaw.keywords': { $in: keywordVariants },
  };

  const feedIdArray = (Array.isArray(feedIds) ? feedIds : [feedIds]).filter(Boolean);
  if (feedIdArray.length > 0) {
    query.feedId = { $in: feedIdArray };
  }

  const totalCount = await JamieVectorMetadata.countDocuments(query);

  const chapters = await JamieVectorMetadata.find(query)
    .select('pineconeId guid feedId start_time end_time metadataRaw')
    .sort({ 'metadataRaw.headline': 1 })
    .skip(skip)
    .limit(limit)
    .lean();

  // Enrich with parent episode context
  const uniqueGuids = [...new Set(chapters.map(c => c.guid).filter(Boolean))];
  const episodeMap = new Map();

  if (uniqueGuids.length > 0) {
    const episodes = await JamieVectorMetadata.find({
      type: 'episode',
      guid: { $in: uniqueGuids },
    })
      .select('guid feedId publishedDate metadataRaw')
      .lean();

    for (const ep of episodes) {
      episodeMap.set(ep.guid, ep);
    }
  }

  const formatChapterResult = (doc) => {
    const meta = doc.metadataRaw || {};
    return {
      pineconeId: doc.pineconeId,
      chapterNumber: meta.chapterNumber ?? meta.chapter_number ?? null,
      headline: meta.headline || null,
      keywords: meta.keywords || [],
      summary: meta.summary || null,
      startTime: meta.startTime ?? meta.start_time ?? doc.start_time ?? null,
      endTime: meta.endTime ?? meta.end_time ?? doc.end_time ?? null,
      duration: meta.duration || null,
    };
  };

  const formatEpisodeContext = (doc) => {
    const meta = doc.metadataRaw || {};
    return {
      guid: doc.guid || meta.guid,
      title: meta.title || null,
      creator: meta.creator || null,
      publishedDate: meta.publishedDate || doc.publishedDate || null,
      feedId: doc.feedId || meta.feedId,
      imageUrl: meta.imageUrl || meta.episodeImage || null,
      listenLink: meta.listenLink || null,
    };
  };

  const nullEpisode = (chapter) => ({
    guid: chapter.guid, title: null, creator: null,
    publishedDate: null, feedId: chapter.feedId,
    imageUrl: null, listenLink: null,
  });

  const data = chapters.map(chapter => ({
    chapter: formatChapterResult(chapter),
    episode: episodeMap.has(chapter.guid)
      ? formatEpisodeContext(episodeMap.get(chapter.guid))
      : nullEpisode(chapter),
  }));

  const totalPages = Math.ceil(totalCount / limit);

  return {
    data,
    pagination: { page, totalPages, totalCount, limit, hasMore: page < totalPages },
    query: { search: searchTerm, feedIds: feedIdArray.length > 0 ? feedIdArray : null },
  };
}

module.exports = { searchChapters };
