/**
 * Corpus Service — pure business logic for corpus read endpoints.
 *
 * Every function accepts plain JS objects (not req/res) and returns data.
 * Route handlers and the agent tool handler both call these directly.
 */

const JamieVectorMetadata = require('../models/JamieVectorMetadata');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Person lookups (find_person / get_person_episodes) run case-insensitive
// $regex scans over the episode docs — regex isn't btree-indexable, so these
// are collection scans. On a loaded DB one scan can take 90s+, which used to
// hang the agent loop until its outer timeout. We hard-bound every person
// query with maxTimeMS so a slow scan fails fast and the agent moves on with
// whatever the other (faster) scans returned, instead of stalling the turn.
const PERSON_QUERY_MAX_TIME_MS = (() => {
  const raw = parseInt(process.env.CORPUS_PERSON_QUERY_MAX_TIME_MS, 10);
  if (Number.isFinite(raw) && raw >= 1000) return raw;
  return 15000; // default: 15s per scan
})();

// Case-insensitive collation. Querying name fields with equality + this
// collation lets the planner use the guests_ci / creator_ci indexes
// (JamieVectorMetadata) instead of an unindexable case-insensitive $regex,
// turning a 90s scan into a millisecond seek. strength:2 = case-insensitive,
// accent-sensitive.
const PERSON_CI_COLLATION = { locale: 'en', strength: 2 };

// MongoDB raises code 50 / "MaxTimeMSExpired" when a query exceeds maxTimeMS.
function isMaxTimeExpired(err) {
  return !!err && (err.code === 50 || err.codeName === 'MaxTimeMSExpired'
    || /maxtimems/i.test(err.message || ''));
}

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

// $group + $project tail shared by the guest and creator pipelines. `role`
// distinguishes the two in the output.
function personGroupAndProject(role) {
  return [
    {
      $group: {
        _id: { $toLower: `$metadataRaw.${role === 'guest' ? 'guests' : 'creator'}` },
        name: { $first: `$metadataRaw.${role === 'guest' ? 'guests' : 'creator'}` },
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
        _id: 0, name: 1, role: { $literal: role }, appearances: 1,
        feeds: { $slice: ['$feeds', 5] },
        recentEpisodes: {
          $slice: [{ $sortArray: { input: '$recentEpisodes', sortBy: { publishedTimestamp: -1 } } }, 3],
        },
      },
    },
  ];
}

// Run the guest + creator aggregations for one match mode, time-bounded and
// independently recoverable (a slow/failed pipeline degrades to []). When
// `useCollation` is set, equality $matches ride the case-insensitive collation
// indexes (guests_ci / creator_ci) — the fast path. The regex mode is the
// substring fallback and cannot use an index (it scans, hence maxTimeMS).
async function runPeoplePipelines({ search, feedId, excludeCreators, useCollation }) {
  const eq = (field) => (useCollation
    ? { [field]: search }
    : { [field]: { $regex: search, $options: 'i' } });

  const guestBase = useCollation
    ? { type: 'episode', ...eq('metadataRaw.guests') }
    : { type: 'episode', 'metadataRaw.guests': { $exists: true, $ne: [] } };
  if (feedId) guestBase.feedId = feedId;

  const guestPipeline = [
    { $match: guestBase },
    ...(useCollation ? [] : (search ? [{ $match: eq('metadataRaw.guests') }] : [])),
    { $unwind: '$metadataRaw.guests' },
    ...(search ? [{ $match: eq('metadataRaw.guests') }] : []),
    ...personGroupAndProject('guest'),
  ];

  const aggs = [guestPipeline];

  if (!excludeCreators) {
    const creatorBase = useCollation
      ? { type: 'episode', ...eq('metadataRaw.creator') }
      : { type: 'episode', 'metadataRaw.creator': { $exists: true, $ne: null, $ne: '' } };
    if (feedId) creatorBase.feedId = feedId;

    const creatorPipeline = [
      { $match: creatorBase },
      ...(useCollation ? [] : (search ? [{ $match: eq('metadataRaw.creator') }] : [])),
      ...personGroupAndProject('creator'),
    ];
    aggs.push(creatorPipeline);
  }

  const settled = await Promise.allSettled(aggs.map((pipeline) => {
    let agg = JamieVectorMetadata.aggregate(pipeline).option({ maxTimeMS: PERSON_QUERY_MAX_TIME_MS });
    if (useCollation) agg = agg.collation(PERSON_CI_COLLATION);
    return agg.exec();
  }));

  return settled.map((r) => {
    if (r.status === 'fulfilled') return r.value;
    if (isMaxTimeExpired(r.reason)) {
      console.warn(`[corpusService.findPeople] a ${useCollation ? 'exact' : 'regex'} person scan exceeded ${PERSON_QUERY_MAX_TIME_MS}ms for search="${search || ''}" — returning partial results`);
      return [];
    }
    throw r.reason;
  }).flat();
}

async function findPeople({ guestsOnly, search, feedId, limit, page }) {
  const pag = clampPagination({ limit, page });
  const excludeCreators = guestsOnly === 'true' || guestsOnly === true;

  // Feed-hosts lookup: only 352 feed docs, so a regex scan here is sub-ms and
  // not worth indexing. Runs in parallel with the people lookup.
  let feedHostsPromise = Promise.resolve([]);
  if (search) {
    feedHostsPromise = JamieVectorMetadata.find({
      type: 'feed',
      'metadataRaw.hosts': { $elemMatch: { $regex: search, $options: 'i' } },
    })
      .select('feedId metadataRaw')
      .maxTimeMS(PERSON_QUERY_MAX_TIME_MS)
      .lean()
      .then(docs => docs.map(formatFeed))
      .catch((err) => {
        if (isMaxTimeExpired(err)) {
          console.warn(`[corpusService.findPeople] feed-hosts scan exceeded ${PERSON_QUERY_MAX_TIME_MS}ms for search="${search}" — returning none`);
          return [];
        }
        throw err;
      });
  }

  // Fast path: index-backed case-insensitive EXACT match (the agent almost
  // always passes a full name like "Michael Saylor"). Falls back to the
  // bounded substring regex scan only when exact finds nobody, so partial-name
  // discovery still works without paying the scan cost on every call.
  let peopleResults = await runPeoplePipelines({ search, feedId, excludeCreators, useCollation: !!search });
  if (search && peopleResults.length === 0) {
    peopleResults = await runPeoplePipelines({ search, feedId, excludeCreators, useCollation: false });
  }
  const hostedFeeds = await feedHostsPromise;

  let allPeople = peopleResults
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

  // Case-insensitive EXACT match via collation (index-backed through
  // guests_ci / creator_ci) — replaces the unindexable `^name$` regex while
  // preserving exact-match semantics.
  const orConditions = [
    { 'metadataRaw.guests': searchName },
  ];
  if (!excludeCreators) {
    orConditions.push({ 'metadataRaw.creator': searchName });
  }

  const query = { type: 'episode', $or: orConditions };
  if (feedId) query.feedId = feedId;

  // maxTimeMS guard as a backstop. On timeout we surface an explicit error
  // the agent can act on rather than hanging the turn.
  let totalCount;
  let episodes;
  try {
    totalCount = await JamieVectorMetadata.countDocuments(query)
      .collation(PERSON_CI_COLLATION)
      .maxTimeMS(PERSON_QUERY_MAX_TIME_MS);
    episodes = await JamieVectorMetadata.find(query)
      .select('guid feedId publishedDate publishedTimestamp metadataRaw')
      .sort({ publishedTimestamp: -1 })
      .skip(pag.skip)
      .limit(pag.limit)
      .collation(PERSON_CI_COLLATION)
      .maxTimeMS(PERSON_QUERY_MAX_TIME_MS)
      .lean();
  } catch (err) {
    if (isMaxTimeExpired(err)) {
      console.warn(`[corpusService.getPersonEpisodes] scan exceeded ${PERSON_QUERY_MAX_TIME_MS}ms for name="${searchName}"`);
      return {
        error: `Lookup for "${searchName}" timed out after ${PERSON_QUERY_MAX_TIME_MS}ms`,
        status: 504,
        data: [],
        pagination: buildPagination(pag.page, pag.limit, 0),
        query: { name: searchName, guestsOnly: excludeCreators, feedId: feedId || null },
      };
    }
    throw err;
  }

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
