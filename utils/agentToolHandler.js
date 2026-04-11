/**
 * Agent Tool Handler
 *
 * Dispatches Claude's tool calls directly to service functions.
 * No loopback HTTP — all calls stay in-process.
 *
 * Applies limit clamping, fluff filtering, reranking, and slim metadata
 * as post-processing on top of the shared service layer.
 */

const { printLog } = require('../constants.js');
const { rerankClips } = require('./clipReranker');

const { searchQuotes } = require('../services/searchQuotesService');
const { searchChapters } = require('../services/searchChaptersService');
const { discoverPodcasts } = require('../routes/discoverRoutes');
const {
  getFeed, getFeedEpisodes, getEpisode,
  listChapters, findPeople, getPersonEpisodes,
} = require('../services/corpusService');
const { getAdjacentParagraphs } = require('../agent-tools/pineconeTools.js');

const TOOL_COSTS = {
  search_quotes:           0.004,
  search_chapters:         0.004,
  list_episode_chapters:   0.002,
  discover_podcasts:       0.005,
  find_person:             0.001,
  get_person_episodes:     0.001,
  get_episode:             0.001,
  get_feed:                0.001,
  get_feed_episodes:       0.001,
  get_adjacent_paragraphs: 0.001,
  suggest_action:          0,
};

const LIMITS = {
  maxToolCallsPerSession: 20,
  maxCostPerSession:      1.00,
};

const RESULT_HARD_CAP = 20;
const MIN_SEQUENCE_INDEX = 3;
const MIN_WORD_COUNT = 15;

const SLIM_EPISODE_FIELDS = new Set([
  'title', 'guid', 'feedId', 'publishedDate', 'creator',
  'guests', 'duration', 'episodeCount', 'matchedGuest',
]);

// --- In-memory session tracking (POC — use Redis in production) ---

const sessionStore = new Map();

function getSession(sessionId) {
  if (!sessionStore.has(sessionId)) {
    sessionStore.set(sessionId, { toolCalls: 0, cost: 0, started: Date.now() });
  }
  return sessionStore.get(sessionId);
}

// --- Helpers ---

function slimEpisode(ep) {
  const slim = {};
  for (const key of SLIM_EPISODE_FIELDS) {
    if (ep[key] !== undefined) slim[key] = ep[key];
  }
  return slim;
}

function clampLimit(requested, defaultVal = 5) {
  const limit = requested || defaultVal;
  return Math.min(Math.max(1, limit), RESULT_HARD_CAP);
}

function extractSequenceFromId(pineconeId) {
  const match = pineconeId && pineconeId.match(/_p(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

function filterFluffResults(data) {
  if (!data.results || !Array.isArray(data.results)) return data;

  const before = data.results.length;
  data.results = data.results.filter(r => {
    const id = r.shareLink || r.shareUrl || '';
    const seq = extractSequenceFromId(id);
    if (seq !== null && seq < MIN_SEQUENCE_INDEX) return false;
    const numWords = r.additionalFields?.num_words || 0;
    if (numWords > 0 && numWords < MIN_WORD_COUNT) return false;
    const text = r.quote || '';
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount > 0 && wordCount < MIN_WORD_COUNT) return false;
    return true;
  });
  if (data.results.length < before) {
    printLog(`[TOOL] Fluff filter: removed ${before - data.results.length} intro/short clips`);
  }
  return data;
}

function truncateResults(data) {
  for (const key of ['results', 'chapters', 'episodes', 'people']) {
    if (data[key] && data[key].length > RESULT_HARD_CAP) {
      data[key] = data[key].slice(0, RESULT_HARD_CAP);
    }
  }
  return data;
}

// --- Per-tool dispatch ---

async function handleSearchQuotes(input, { openai }) {
  const { query, guid, guids, feedIds, limit, minDate, maxDate } = input;
  const clampedLimit = clampLimit(limit, 5);
  const overFetchLimit = Math.min(clampedLimit * 3, RESULT_HARD_CAP);

  printLog(`[TOOL] search_quotes: query="${query}", limit=${clampedLimit} (fetching=${overFetchLimit}), smartMode=true`);
  const data = await searchQuotes({
    query, guid, guids, feedIds, limit: overFetchLimit, minDate, maxDate, smartMode: true,
  }, { openai });
  filterFluffResults(data);

  if (data.results && data.results.length > 2 && openai) {
    const clips = data.results.map(r => ({
      quote: r.quote,
      creator: r.creator || r.episode,
      episode: r.episode,
    }));
    const reranked = await rerankClips({ query, clips, openai });
    if (reranked.clips.length > 0) {
      const rerankTexts = new Set(reranked.clips.map(c => c.quote));
      data.results = data.results.filter(r => rerankTexts.has(r.quote));
      printLog(`[TOOL] Reranker: ${clips.length} -> ${data.results.length} clips`);
    }
  }

  truncateResults(data);
  if (data.results) data.results = data.results.slice(0, clampedLimit);
  printLog(`[TOOL] search_quotes: ${data.results?.length || 0} results`);
  return data;
}

async function handleSearchChapters(input) {
  const { search, feedIds, limit, page = 1 } = input;
  const clampedLimit = clampLimit(limit, 5);

  printLog(`[TOOL] search_chapters: search="${search}", limit=${clampedLimit}`);
  const data = await searchChapters({ search, feedIds, limit: clampedLimit, page });
  truncateResults(data);
  printLog(`[TOOL] search_chapters: ${data.data?.length || 0} results`);
  return data;
}

async function handleDiscoverPodcasts(input) {
  const { query, limit } = input;
  const clampedLimit = clampLimit(limit, 5);

  printLog(`[TOOL] discover_podcasts: query="${query}", limit=${clampedLimit}`);
  const data = await discoverPodcasts({ query, limit: clampedLimit });
  truncateResults(data);
  printLog(`[TOOL] discover_podcasts: ${data.results?.length || 0} results`);
  return data;
}

async function handleFindPerson(input) {
  const { name } = input;
  printLog(`[TOOL] find_person: name="${name}"`);
  const data = await findPeople({ search: name, limit: RESULT_HARD_CAP });
  const normalized = { people: data.data || [], pagination: data.pagination, query: data.query };
  truncateResults(normalized);
  printLog(`[TOOL] find_person: ${normalized.people?.length || 0} results`);
  return normalized;
}

async function handleGetPersonEpisodes(input) {
  const { name, limit, verbose } = input;
  const clampedLimit = clampLimit(limit, 5);

  printLog(`[TOOL] get_person_episodes: name="${name}", limit=${clampedLimit}`);
  const data = await getPersonEpisodes({ name, limit: clampedLimit });
  const normalized = { episodes: data.data || [], pagination: data.pagination, query: data.query };
  truncateResults(normalized);
  if (!verbose && normalized.episodes) {
    normalized.episodes = normalized.episodes.map(slimEpisode);
  }
  printLog(`[TOOL] get_person_episodes: ${normalized.episodes?.length || 0} results, slim=${!verbose}`);
  return normalized;
}

async function handleListEpisodeChapters(input) {
  const { guids, feedIds, limit } = input;
  const clampedLimit = limit ? Math.min(limit, RESULT_HARD_CAP * 2) : undefined;

  printLog(`[TOOL] list_episode_chapters: guids=${guids?.length || 0}, feedIds=${feedIds?.length || 0}`);
  const data = await listChapters({ guids, feedIds, limit: clampedLimit });
  const chapters = data.data || [];
  const normalized = { chapters: Array.isArray(chapters) ? chapters : [] };
  printLog(`[TOOL] list_episode_chapters: ${normalized.chapters.length} chapters`);
  return normalized;
}

async function handleGetEpisode(input) {
  const { guid } = input;
  printLog(`[TOOL] get_episode: guid="${guid}"`);
  const data = await getEpisode({ guid });
  const normalized = { episode: data?.data || data };
  printLog(`[TOOL] get_episode: ${normalized.episode?.title || 'found'}`);
  return normalized;
}

async function handleGetFeed(input) {
  const { feedId } = input;
  printLog(`[TOOL] get_feed: feedId="${feedId}"`);
  const data = await getFeed({ feedId });
  const normalized = { feed: data?.data || data };
  printLog(`[TOOL] get_feed: ${normalized.feed?.title || 'found'}`);
  return normalized;
}

async function handleGetFeedEpisodes(input) {
  const { feedId, limit, minDate, maxDate, verbose } = input;
  const clampedLimit = clampLimit(limit, 10);

  printLog(`[TOOL] get_feed_episodes: feedId="${feedId}", limit=${clampedLimit}`);
  const data = await getFeedEpisodes({ feedId, limit: clampedLimit, minDate, maxDate });
  const normalized = { episodes: data.data || [], pagination: data.pagination };
  truncateResults(normalized);
  if (!verbose && normalized.episodes) {
    normalized.episodes = normalized.episodes.map(slimEpisode);
  }
  printLog(`[TOOL] get_feed_episodes: ${normalized.episodes?.length || 0} episodes, slim=${!verbose}`);
  return normalized;
}

async function handleGetAdjacentParagraphs(input) {
  const { paragraphId, windowSize } = input;
  const clampedWindow = Math.min(Math.max(1, windowSize || 3), 10);

  printLog(`[TOOL] get_adjacent_paragraphs: id="${paragraphId}", window=${clampedWindow}`);
  const data = await getAdjacentParagraphs(paragraphId, clampedWindow);
  const normalized = {
    before: data.before || [],
    current: data.current || null,
    after: data.after || [],
  };
  const totalCount = normalized.before.length + (normalized.current ? 1 : 0) + normalized.after.length;
  printLog(`[TOOL] get_adjacent_paragraphs: ${totalCount} paragraphs`);
  return normalized;
}

const TOOL_DISPATCH = {
  search_quotes:           handleSearchQuotes,
  search_chapters:         handleSearchChapters,
  discover_podcasts:       handleDiscoverPodcasts,
  find_person:             handleFindPerson,
  get_person_episodes:     handleGetPersonEpisodes,
  list_episode_chapters:   handleListEpisodeChapters,
  get_episode:             handleGetEpisode,
  get_feed:                handleGetFeed,
  get_feed_episodes:       handleGetFeedEpisodes,
  get_adjacent_paragraphs: handleGetAdjacentParagraphs,
};

/**
 * Execute a tool call from the Claude agent.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} opts
 * @param {object} opts.openai - OpenAI client (for embeddings + reranker)
 * @param {string} opts.sessionId - Session ID for rate limiting
 */
async function executeAgentTool(toolName, toolInput, { openai, sessionId }) {
  const handler = TOOL_DISPATCH[toolName];
  if (!handler) {
    return { error: `Unknown tool: ${toolName}` };
  }

  const toolCost = TOOL_COSTS[toolName] || 0;
  const session = getSession(sessionId || 'default');

  if (session.toolCalls >= LIMITS.maxToolCallsPerSession) {
    return {
      error: 'Session tool-call limit reached',
      limit: LIMITS.maxToolCallsPerSession,
      used: session.toolCalls,
    };
  }
  if (session.cost + toolCost > LIMITS.maxCostPerSession) {
    return {
      error: 'Session cost limit reached',
      limit: LIMITS.maxCostPerSession,
      current: session.cost,
    };
  }

  session.toolCalls++;
  session.cost += toolCost;

  return handler(toolInput, { openai });
}

module.exports = { executeAgentTool, TOOL_COSTS };
