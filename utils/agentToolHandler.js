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
const { createResearchSessionDirect } = require('../services/researchSessionService');
const { resolveOwner } = require('../utils/resolveOwner');

// Removed 2026-04-28: per-tool flat-fee table previously fed createCostTracker.
// Internal infra (Pinecone, MongoDB, Atlas, our HTTP services) is $0 marginal —
// see HELPER_LLM_PRICES in constants/agentModels.js for what's actually billed.
//
// Also removed: `LIMITS.maxToolCallsPerSession` and the in-memory `sessionStore`
// counter. The cap was a process-wide, never-expiring 20-tool budget keyed by
// sessionId, which (a) leaked across follow-up turns in a single conversation
// (a long first turn left a starving budget for turn 2 onward) and (b) was
// surfaced verbatim to the LLM as an "API call limit" error stub which it
// then parroted to the user. Per-request work is now bounded by:
//   - executionProfile.maxToolRounds  (orchestrator round cap)
//   - executionProfile.costBudgetHard (real-money cap, see createCostTracker)
//   - executionProfile.latencyBudgetHardMs (wall-clock cap)
// Cross-turn abuse protection lives at the HTTP edge, not in the tool layer.

const RESULT_HARD_CAP = 20;
const MIN_SEQUENCE_INDEX = 3;
const MIN_WORD_COUNT = 15;
const AD_MATCH_THRESHOLD = 3;
const AD_PHRASES = [
  /\bpromo code\b/i, /\buse code\b/i, /\bsign up at\b/i, /\bdiscount\b/i,
  /\bsponsored by\b/i, /\bbrought to you by\b/i,
  /\bgo to \w+\.com\b/i, /\blink in the description\b/i, /\bspecial offer\b/i,
  /\bfree trial\b/i, /\bdownload the app\b/i, /\bcoupon\b/i,
  /\bcheck (it )?out at\b/i, /\bheads? to \w+\.com\b/i,
];

const SLIM_EPISODE_FIELDS = new Set([
  'title', 'guid', 'feedId', 'publishedDate', 'creator',
  'guests', 'duration', 'episodeCount', 'matchedGuest',
]);

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

function isAdContent(text) {
  let matches = 0;
  for (const pattern of AD_PHRASES) {
    if (pattern.test(text) && ++matches >= AD_MATCH_THRESHOLD) return true;
  }
  return false;
}

function filterFluffResults(data) {
  if (!data.results || !Array.isArray(data.results)) return data;

  const before = data.results.length;
  let adRemoved = 0;
  data.results = data.results.filter(r => {
    const id = r.shareLink || r.shareUrl || '';
    const seq = extractSequenceFromId(id);
    if (seq !== null && seq < MIN_SEQUENCE_INDEX) return false;
    const numWords = r.additionalFields?.num_words || 0;
    if (numWords > 0 && numWords < MIN_WORD_COUNT) return false;
    const text = r.quote || '';
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount > 0 && wordCount < MIN_WORD_COUNT) return false;
    if (isAdContent(text)) { adRemoved++; return false; }
    return true;
  });
  const removed = before - data.results.length;
  if (removed > 0) {
    printLog(`[TOOL] Fluff filter: removed ${removed} clips (${adRemoved} ad/sponsor)`);
  }
  return data;
}

function truncateResults(data) {
  for (const key of ['results', 'chapters', 'episodes', 'people', 'hostedFeeds']) {
    if (data[key] && data[key].length > RESULT_HARD_CAP) {
      data[key] = data[key].slice(0, RESULT_HARD_CAP);
    }
  }
  return data;
}

// --- Per-tool dispatch ---

async function handleSearchQuotes(input, { openai, recordHelperLlmUsage }) {
  const { query, guid, guids, feedIds, limit, minDate, maxDate } = input;
  const clampedLimit = clampLimit(limit, 5);
  const overFetchLimit = Math.min(clampedLimit * 3, RESULT_HARD_CAP);

  const q = typeof query === 'string' ? query.trim() : (query != null && query !== '' ? String(query).trim() : '');
  if (!q) {
    printLog(`[TOOL] search_quotes: rejected empty/missing query (raw=${JSON.stringify(query)})`);
    return {
      error: 'search_quotes requires a non-empty `query` string (the model omitted it or passed only whitespace). Retry with a concrete phrase from the user question.',
      results: [],
    };
  }

  printLog(`[TOOL] search_quotes: query="${q}", limit=${clampedLimit} (fetching=${overFetchLimit}), smartMode=true`);
  const data = await searchQuotes({
    query: q, guid, guids, feedIds, limit: overFetchLimit, minDate, maxDate, smartMode: true,
  }, { openai, recordHelperLlmUsage });
  filterFluffResults(data);

  if (data.results && data.results.length > 2 && openai) {
    const clips = data.results.map(r => ({
      quote: r.quote,
      creator: r.creator || r.episode,
      episode: r.episode,
    }));
    try {
      const reranked = await rerankClips({ query: q, clips, openai });
      if (typeof recordHelperLlmUsage === 'function' && reranked.usage) {
        recordHelperLlmUsage(
          reranked.usage.model,
          reranked.usage.input_tokens || 0,
          reranked.usage.output_tokens || 0,
        );
      }
      const inputCount = clips.length;
      let keptCount = inputCount;
      if (reranked.clips.length > 0) {
        const rerankTexts = new Set(reranked.clips.map(c => c.quote));
        data.results = data.results.filter(r => rerankTexts.has(r.quote));
        keptCount = data.results.length;
        printLog(`[TOOL] Reranker: ${clips.length} -> ${data.results.length} clips`);
      }
      if (data._meta) {
        data._meta.reranker = {
          activated: true,
          input: inputCount,
          kept: keptCount,
          removed: inputCount - keptCount,
        };
      }
    } catch (rerankErr) {
      printLog(`[TOOL] Reranker failed (non-fatal): ${rerankErr.message}`);
      if (data._meta) data._meta.reranker = { activated: false, error: rerankErr.message };
    }
  } else if (data._meta) {
    data._meta.reranker = { activated: false, reason: 'too few clips to rerank' };
  }

  truncateResults(data);
  if (data.results) data.results = data.results.slice(0, clampedLimit);
  if (data._meta) data._meta.afterClamp = data.results?.length || 0;
  printLog(`[TOOL] search_quotes: ${data.results?.length || 0} results`);
  return data;
}

async function handleSearchChapters(input) {
  const { search, feedIds, limit, page = 1 } = input;
  const clampedLimit = clampLimit(limit, 5);
  const s = typeof search === 'string' ? search.trim() : (search != null && search !== '' ? String(search).trim() : '');
  if (!s) {
    printLog('[TOOL] search_chapters: rejected empty search');
    return { error: 'search_chapters requires a non-empty `search` string.', data: [] };
  }

  printLog(`[TOOL] search_chapters: search="${s}", limit=${clampedLimit}`);
  const data = await searchChapters({ search: s, feedIds, limit: clampedLimit, page });
  truncateResults(data);
  printLog(`[TOOL] search_chapters: ${data.data?.length || 0} results`);
  return data;
}

async function handleDiscoverPodcasts(input) {
  const { query, limit } = input;
  const clampedLimit = clampLimit(limit, 5);
  const q = typeof query === 'string' ? query.trim() : (query != null && query !== '' ? String(query).trim() : '');
  if (!q) {
    printLog(`[TOOL] discover_podcasts: rejected empty/missing query`);
    return { error: 'discover_podcasts requires a non-empty `query` string.', results: [] };
  }

  printLog(`[TOOL] discover_podcasts: query="${q}", limit=${clampedLimit}`);
  const data = await discoverPodcasts({ query: q, limit: clampedLimit });
  truncateResults(data);
  printLog(`[TOOL] discover_podcasts: ${data.results?.length || 0} results`);
  return data;
}

function buildSearchStrategy(people, hostedFeeds) {
  const hostedFeedIds = (hostedFeeds || []).slice(0, 5).map(f => String(f.feedId));

  const guestGuids = [];
  for (const p of (people || [])) {
    if (p.role === 'guest' && Array.isArray(p.recentEpisodes)) {
      for (const ep of p.recentEpisodes) {
        if (ep.guid && guestGuids.length < 10) guestGuids.push(ep.guid);
      }
    }
  }

  const parts = [];
  if (hostedFeedIds.length) {
    const feedNames = hostedFeeds.slice(0, 3).map(f => f.title || f.feedId).join(', ');
    parts.push(`Host of ${feedNames}. Search with feedIds=[${hostedFeedIds.join(',')}].`);
  }
  if (guestGuids.length) {
    parts.push(`Guest on ${guestGuids.length} episode(s). Search with guids for guest appearances.`);
  }
  if (!parts.length) parts.push('No hosted feeds or guest episodes found. Try search_quotes with name as query.');

  return {
    hostedFeedIds,
    guestGuids,
    hint: parts.join(' ').substring(0, 250),
  };
}

async function handleFindPerson(input) {
  const { name } = input;
  const n = typeof name === 'string' ? name.trim() : (name != null && name !== '' ? String(name).trim() : '');
  if (!n) {
    printLog(`[TOOL] find_person: rejected empty/missing name`);
    return {
      error: 'find_person requires a non-empty `name` string.',
      people: [],
      hostedFeeds: [],
    };
  }
  printLog(`[TOOL] find_person: name="${n}"`);
  const data = await findPeople({ search: n, limit: RESULT_HARD_CAP });
  const normalized = {
    people: data.data || [],
    hostedFeeds: data.hostedFeeds || [],
    pagination: data.pagination,
    query: data.query,
  };
  truncateResults(normalized);
  normalized.searchStrategy = buildSearchStrategy(normalized.people, normalized.hostedFeeds);
  printLog(`[TOOL] find_person: ${normalized.people?.length || 0} people, ${normalized.hostedFeeds?.length || 0} hosted feeds, hint="${normalized.searchStrategy.hint}"`);
  return normalized;
}

async function handleGetPersonEpisodes(input) {
  const { name, limit, verbose } = input;
  const clampedLimit = clampLimit(limit, 5);
  const n = typeof name === 'string' ? name.trim() : (name != null && name !== '' ? String(name).trim() : '');
  if (!n) {
    printLog(`[TOOL] get_person_episodes: rejected empty name`);
    return { error: 'get_person_episodes requires a non-empty `name`.', episodes: [] };
  }

  printLog(`[TOOL] get_person_episodes: name="${n}", limit=${clampedLimit}`);
  const data = await getPersonEpisodes({ name: n, limit: clampedLimit });
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
  const g = typeof guid === 'string' ? guid.trim() : (guid != null && guid !== '' ? String(guid).trim() : '');
  if (!g) {
    printLog(`[TOOL] get_episode: rejected empty guid`);
    return { error: 'get_episode requires a non-empty episode `guid`.', episode: null };
  }
  printLog(`[TOOL] get_episode: guid="${g}"`);
  const data = await getEpisode({ guid: g });
  const normalized = { episode: data?.data || data };
  printLog(`[TOOL] get_episode: ${normalized.episode?.title || 'found'}`);
  return normalized;
}

async function handleGetFeed(input) {
  const { feedId } = input;
  const fid = feedId != null && feedId !== '' ? String(feedId).trim() : '';
  if (!fid) {
    printLog(`[TOOL] get_feed: rejected empty feedId`);
    return { error: 'get_feed requires a `feedId`.', feed: null };
  }
  printLog(`[TOOL] get_feed: feedId="${fid}"`);
  const data = await getFeed({ feedId: fid });
  const normalized = { feed: data?.data || data };
  printLog(`[TOOL] get_feed: ${normalized.feed?.title || 'found'}`);
  return normalized;
}

const VERBOSE_EPISODE_LIMIT = 5;
// Episode listing supports a higher cap than other tools because the model
// often needs to see a year+ of episodes for research-session curation, and
// the slim payload (~150 chars/episode) keeps token cost bounded even at 100.
const EPISODE_LIST_HARD_CAP = 100;

async function handleGetFeedEpisodes(input) {
  const { feedId, limit, minDate, maxDate, verbose } = input;
  const fid = feedId != null && feedId !== '' ? String(feedId).trim() : '';
  if (!fid) {
    printLog(`[TOOL] get_feed_episodes: rejected empty feedId`);
    return { error: 'get_feed_episodes requires a `feedId`.', episodes: [] };
  }
  const defaultLimit = verbose ? VERBOSE_EPISODE_LIMIT : 10;
  const hardCap = verbose ? VERBOSE_EPISODE_LIMIT : EPISODE_LIST_HARD_CAP;
  const clampedLimit = Math.min(Math.max(1, limit || defaultLimit), hardCap);

  printLog(`[TOOL] get_feed_episodes: feedId="${fid}", limit=${clampedLimit}, verbose=${!!verbose}`);
  const data = await getFeedEpisodes({ feedId: fid, limit: clampedLimit, minDate, maxDate });
  const normalized = { episodes: data.data || [], pagination: data.pagination };
  if (normalized.episodes && normalized.episodes.length > hardCap) {
    normalized.episodes = normalized.episodes.slice(0, hardCap);
  }
  if (!verbose && normalized.episodes) {
    normalized.episodes = normalized.episodes.map(slimEpisode);
  }
  printLog(`[TOOL] get_feed_episodes: ${normalized.episodes?.length || 0} episodes, slim=${!verbose}`);
  return normalized;
}

async function handleGetAdjacentParagraphs(input) {
  const { paragraphId, windowSize } = input;
  const pid = typeof paragraphId === 'string' ? paragraphId.trim() : (paragraphId != null && paragraphId !== '' ? String(paragraphId).trim() : '');
  if (!pid) {
    printLog(`[TOOL] get_adjacent_paragraphs: rejected empty paragraphId`);
    return {
      error: 'get_adjacent_paragraphs requires a non-empty `paragraphId` (shareLink from search_quotes).',
      before: [],
      current: null,
      after: [],
    };
  }
  const clampedWindow = Math.min(Math.max(1, windowSize || 3), 10);

  printLog(`[TOOL] get_adjacent_paragraphs: id="${pid}", window=${clampedWindow}`);
  const data = await getAdjacentParagraphs(pid, clampedWindow);
  const normalized = {
    before: data.before || [],
    current: data.current || null,
    after: data.after || [],
  };
  const totalCount = normalized.before.length + (normalized.current ? 1 : 0) + normalized.after.length;
  printLog(`[TOOL] get_adjacent_paragraphs: ${totalCount} paragraphs`);
  return normalized;
}

async function handleCreateResearchSession(input, { req, clipCache }) {
  const { pineconeIds, title } = input;
  if (!Array.isArray(pineconeIds) || pineconeIds.length === 0) {
    printLog('[TOOL] create_research_session: rejected empty pineconeIds');
    return { error: 'create_research_session requires a non-empty `pineconeIds` array (shareLinks from search_quotes).' };
  }
  printLog(`[TOOL] create_research_session: ${pineconeIds?.length || 0} clips, title="${title || 'auto'}", cached=${clipCache?.size || 0}`);

  let userId = null;
  let clientId = null;
  if (req) {
    try {
      const owner = await resolveOwner(req);
      if (owner) {
        userId = owner.userId;
        clientId = owner.clientId;
      }
    } catch (err) {
      printLog(`[TOOL] create_research_session: owner resolution failed: ${err.message}`);
    }
  }

  try {
    const result = await createResearchSessionDirect({ pineconeIds, title, userId, clientId, clipCache });
    printLog(`[TOOL] create_research_session: created ${result.sessionId} (${result.itemCount} items)`);
    return result;
  } catch (err) {
    printLog(`[TOOL] create_research_session: failed: ${err.message}`);
    return { error: err.message };
  }
}

const TOOL_DISPATCH = {
  search_quotes:              handleSearchQuotes,
  search_chapters:            handleSearchChapters,
  discover_podcasts:          handleDiscoverPodcasts,
  find_person:                handleFindPerson,
  get_person_episodes:        handleGetPersonEpisodes,
  list_episode_chapters:      handleListEpisodeChapters,
  get_episode:                handleGetEpisode,
  get_feed:                   handleGetFeed,
  get_feed_episodes:          handleGetFeedEpisodes,
  get_adjacent_paragraphs:    handleGetAdjacentParagraphs,
  create_research_session:    handleCreateResearchSession,
};

/**
 * Execute a tool call from the Claude agent.
 *
 * Per-request work is bounded by the route's executionProfile (max rounds,
 * cost budget, latency budget). There is intentionally NO cross-turn /
 * cross-session counter here — that previously caused user-facing "API call
 * limit" parroting (see 2026-04-28 fix). Cross-turn abuse protection belongs
 * at the HTTP edge.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} opts
 * @param {object} opts.openai - OpenAI client (for embeddings + reranker)
 * @param {string} [opts.sessionId] - Session ID (currently unused at this
 *        layer; preserved in signature for downstream handlers / future use)
 * @param {function} [opts.recordHelperLlmUsage] - Callback (modelId, inputTokens, outputTokens) =>
 *        invoked by helpers (reranker, embedding, query expansion) so the
 *        caller can attribute their real spend to the request's cost tracker.
 */
async function executeAgentTool(toolName, toolInput, { openai, sessionId, req, clipCache, recordHelperLlmUsage }) {
  const handler = TOOL_DISPATCH[toolName];
  if (!handler) {
    return { error: `Unknown tool: ${toolName}` };
  }

  try {
    return await handler(toolInput, { openai, req, clipCache, recordHelperLlmUsage });
  } catch (err) {
    const msg = err && (err.message || String(err));
    printLog(`[TOOL] ${toolName} threw (recovered): ${msg}`);
    return {
      error: msg,
      toolExecutionFailed: true,
      hint: 'Fix arguments or try a different tool, then continue. Empty search_quotes.query causes embedding API errors — always pass a non-empty string.',
    };
  }
}

module.exports = { executeAgentTool };
