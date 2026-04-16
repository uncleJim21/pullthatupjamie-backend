/**
 * Corpus Service — pure business logic for corpus read endpoints.
 *
 * Every function accepts plain JS objects (not req/res) and returns data.
 * Route handlers and the agent tool handler both call these directly.
 */

const JamieVectorMetadata = require('../models/JamieVectorMetadata');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function clampPagination({ limit, page } = {}) {
  const l = Math.min(Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT), MAX_LIMIT);
  const p = Math.max(1, parseInt(page, 10) || 1);
  return { limit: l, page: p, skip: (p - 1) * l };
}

function buildPagination(page, limit, totalCount) {
  const totalPages = Math.ceil(totalCount / limit);
  return { page, totalPages, totalCount, limit, hasMore: page < totalPages };
}

function formatFeed(doc) {
  const meta = doc.metadataRaw || {};
  return {
    feedId: doc.feedId || meta.feedId,
    title: meta.title || null,
    author: meta.author || null,
    description: meta.description || null,
    episodeCount: meta.episodeCount || null,
    imageUrl: meta.imageUrl || null,
    hosts: Array.isArray(meta.hosts) ? meta.hosts : [],
    feedType: meta.feedType || null,
  };
}

function formatEpisode(doc) {
  const meta = doc.metadataRaw || {};
  return {
    guid: doc.guid || meta.guid,
    title: meta.title || null,
    creator: meta.creator || null,
    description: meta.description || null,
    publishedDate: meta.publishedDate || doc.publishedDate || null,
    duration: meta.duration || null,
    imageUrl: meta.imageUrl || meta.episodeImage || null,
    guests: meta.guests || [],
  };
}

function formatChapter(doc) {
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
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

async function getFeed({ feedId }) {
  const feed = await JamieVectorMetadata.findOne({ type: 'feed', feedId })
    .select('feedId metadataRaw')
    .lean();
  if (!feed) return null;
  return { data: formatFeed(feed) };
}

async function getFeedEpisodes({ feedId, limit, page, sort = 'newest', minDate, maxDate }) {
  const pag = clampPagination({ limit, page });

  const query = { type: 'episode', feedId };
  if (minDate || maxDate) {
    query.publishedTimestamp = {};
    if (minDate) query.publishedTimestamp.$gte = new Date(minDate).getTime();
    if (maxDate) query.publishedTimestamp.$lte = new Date(maxDate).getTime();
  }

  const totalCount = await JamieVectorMetadata.countDocuments(query);
  const sortDir = sort === 'oldest' ? 1 : -1;

  const episodes = await JamieVectorMetadata.find(query)
    .select('guid feedId publishedDate publishedTimestamp metadataRaw')
    .sort({ publishedTimestamp: sortDir })
    .skip(pag.skip)
    .limit(pag.limit)
    .lean();

  return {
    data: episodes.map(formatEpisode),
    pagination: buildPagination(pag.page, pag.limit, totalCount),
  };
}

async function getEpisode({ guid }) {
  const episode = await JamieVectorMetadata.findOne({ type: 'episode', guid })
    .select('guid feedId publishedDate publishedTimestamp metadataRaw')
    .lean();
  if (!episode) return null;
  return { data: formatEpisode(episode) };
}

async function listChapters({ guids, feedIds, limit: rawLimit }) {
  const limit = Math.min(parseInt(rawLimit) || 100, 200);

  const filter = { type: 'chapter' };
  if (guids && guids.length > 0) {
    const guidList = Array.isArray(guids) ? guids : guids.split(',').map(g => g.trim()).filter(Boolean);
    filter.guid = { $in: guidList };
  } else if (feedIds && feedIds.length > 0) {
    const feedList = Array.isArray(feedIds) ? feedIds : feedIds.split(',').map(f => f.trim()).filter(Boolean);
    filter.feedId = { $in: feedList };
  } else {
    return { error: 'Provide guids or feedIds' };
  }

  const chapters = await JamieVectorMetadata.find(filter)
    .select('pineconeId guid feedId start_time end_time metadataRaw')
    .sort({ guid: 1, start_time: 1 })
    .limit(limit)
    .lean();

  return { data: chapters.map(formatChapter) };
}

async function findPeople({ guestsOnly, search, feedId, limit, page }) {
  const pag = clampPagination({ limit, page });
  const excludeCreators = guestsOnly === 'true' || guestsOnly === true;

  const pipelines = [];

  // Guest pipeline
  const guestMatch = { type: 'episode', 'metadataRaw.guests': { $exists: true, $ne: [] } };
  if (feedId) guestMatch.feedId = feedId;

  const guestPipeline = [
    { $match: guestMatch },
    { $unwind: '$metadataRaw.guests' },
    ...(search ? [{ $match: { 'metadataRaw.guests': { $regex: search, $options: 'i' } } }] : []),
    {
      $group: {
        _id: { $toLower: '$metadataRaw.guests' },
        name: { $first: '$metadataRaw.guests' },
        appearances: { $sum: 1 },
        feeds: { $addToSet: { feedId: '$feedId', title: '$metadataRaw.feedTitle' } },
        recentEpisodes: {
          $push: {
            guid: '$guid',
            title: '$metadataRaw.title',
            publishedDate: '$metadataRaw.publishedDate',
            publishedTimestamp: '$publishedTimestamp',
          },
        },
      },
    },
    {
      $project: {
        _id: 0, name: 1, role: { $literal: 'guest' }, appearances: 1,
        feeds: { $slice: ['$feeds', 5] },
        recentEpisodes: {
          $slice: [{ $sortArray: { input: '$recentEpisodes', sortBy: { publishedTimestamp: -1 } } }, 3],
        },
      },
    },
  ];
  pipelines.push(JamieVectorMetadata.aggregate(guestPipeline));

  if (!excludeCreators) {
    const creatorMatch = { type: 'episode', 'metadataRaw.creator': { $exists: true, $ne: null, $ne: '' } };
    if (feedId) creatorMatch.feedId = feedId;

    const creatorPipeline = [
      { $match: creatorMatch },
      ...(search ? [{ $match: { 'metadataRaw.creator': { $regex: search, $options: 'i' } } }] : []),
      {
        $group: {
          _id: { $toLower: '$metadataRaw.creator' },
          name: { $first: '$metadataRaw.creator' },
          appearances: { $sum: 1 },
          feeds: { $addToSet: { feedId: '$feedId', title: '$metadataRaw.feedTitle' } },
          recentEpisodes: {
            $push: {
              guid: '$guid',
              title: '$metadataRaw.title',
              publishedDate: '$metadataRaw.publishedDate',
              publishedTimestamp: '$publishedTimestamp',
            },
          },
        },
      },
      {
        $project: {
          _id: 0, name: 1, role: { $literal: 'creator' }, appearances: 1,
          feeds: { $slice: ['$feeds', 5] },
          recentEpisodes: {
            $slice: [{ $sortArray: { input: '$recentEpisodes', sortBy: { publishedTimestamp: -1 } } }, 3],
          },
        },
      },
    ];
    pipelines.push(JamieVectorMetadata.aggregate(creatorPipeline));
  }

  // Feed-hosts pipeline: find feeds where the person is a tagged host
  let feedHostsPromise = Promise.resolve([]);
  if (search) {
    feedHostsPromise = JamieVectorMetadata.find({
      type: 'feed',
      'metadataRaw.hosts': { $elemMatch: { $regex: search, $options: 'i' } },
    })
      .select('feedId metadataRaw')
      .lean()
      .then(docs => docs.map(formatFeed));
  }

  const [peopleResults, hostedFeeds] = await Promise.all([
    Promise.all(pipelines),
    feedHostsPromise,
  ]);

  let allPeople = peopleResults.flat()
    .map(p => ({
      ...p,
      feeds: (p.feeds || []).filter(f => f.feedId && f.title),
      recentEpisodes: (p.recentEpisodes || [])
        .filter(e => e.guid && e.title)
        .map(e => ({ guid: e.guid, title: e.title, publishedDate: e.publishedDate })),
    }))
    .sort((a, b) => b.appearances - a.appearances);

  const totalCount = allPeople.length;
  const paginated = allPeople.slice(pag.skip, pag.skip + pag.limit);

  return {
    data: paginated,
    hostedFeeds: hostedFeeds || [],
    pagination: buildPagination(pag.page, pag.limit, totalCount),
    query: { guestsOnly: excludeCreators, search: search || null, feedId: feedId || null },
  };
}

async function getPersonEpisodes({ name, guestsOnly = false, feedId, limit, page }) {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return { error: 'name is required', status: 400 };
  }

  const pag = clampPagination({ limit, page });
  const searchName = name.trim();
  const excludeCreators = guestsOnly === true || guestsOnly === 'true';

  const orConditions = [
    { 'metadataRaw.guests': { $regex: `^${searchName}$`, $options: 'i' } },
  ];
  if (!excludeCreators) {
    orConditions.push({ 'metadataRaw.creator': { $regex: `^${searchName}$`, $options: 'i' } });
  }

  const query = { type: 'episode', $or: orConditions };
  if (feedId) query.feedId = feedId;

  const totalCount = await JamieVectorMetadata.countDocuments(query);

  const episodes = await JamieVectorMetadata.find(query)
    .select('guid feedId publishedDate publishedTimestamp metadataRaw')
    .sort({ publishedTimestamp: -1 })
    .skip(pag.skip)
    .limit(pag.limit)
    .lean();

  const formatted = episodes.map(doc => {
    const meta = doc.metadataRaw || {};
    const guests = (meta.guests || []).map(g => g.toLowerCase());
    const creator = (meta.creator || '').toLowerCase();
    const searchLower = searchName.toLowerCase();

    let role = 'unknown';
    if (guests.includes(searchLower)) role = 'guest';
    else if (creator === searchLower) role = 'creator';

    return {
      guid: doc.guid || meta.guid,
      title: meta.title || null,
      feedId: doc.feedId || meta.feedId,
      feedTitle: meta.feedTitle || null,
      publishedDate: meta.publishedDate || doc.publishedDate || null,
      role,
      imageUrl: meta.imageUrl || meta.episodeImage || null,
      duration: meta.duration || null,
    };
  });

  return {
    data: formatted,
    pagination: buildPagination(pag.page, pag.limit, totalCount),
    query: { name: searchName, guestsOnly: excludeCreators, feedId: feedId || null },
  };
}

module.exports = {
  getFeed,
  getFeedEpisodes,
  getEpisode,
  listChapters,
  findPeople,
  getPersonEpisodes,
  formatFeed,
  formatEpisode,
  formatChapter,
  clampPagination,
  buildPagination,
};
