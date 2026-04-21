/**
 * Claude Managed Agents Gateway
 *
 * Lightweight proxy that sits between a Claude Managed Agent and the
 * Jamie API (running on localhost:4132). Provides:
 *   - Shared API key auth for the agent
 *   - In-memory session + daily cost tracking
 *   - Per-tool cost accounting and rate limiting
 *
 * Run standalone:  node agent-gateway.js
 * Default port:    3456
 */

const express = require('express');
const { printLog } = require('./constants.js');
const OpenAI = require('openai');
const { rerankClips } = require('./utils/clipReranker');

const openai = new OpenAI();

const app = express();
app.use(express.json());

const JAMIE_API_BASE = process.env.JAMIE_API_BASE || 'http://localhost:4132';
const GATEWAY_PORT = parseInt(process.env.AGENT_GATEWAY_PORT || '3456', 10);
const GATEWAY_API_KEY = process.env.AGENT_GATEWAY_KEY || 'jamie_agent_poc_key';

const TOOL_COSTS = {
  'search-quotes':           0.004,
  'search-chapters':         0.004,
  'list-episode-chapters':   0.002,
  'discover-podcasts':       0.005,
  'find-person':             0.001,
  'get-person-episodes':     0.001,
  'get-episode':             0.001,
  'get-feed':                0.001,
  'get-feed-episodes':       0.001,
  'get-adjacent-paragraphs': 0.001,
};

const LIMITS = {
  maxToolCallsPerSession: 20,
  maxCostPerSession:      1.00,
  maxCallsPerDay:         500,
  maxCostPerDay:          25.00,
};

// In-memory stores (POC only — use Redis in production)
const sessionStore = new Map();
const dailyStore   = new Map();

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

function getSession(sessionId) {
  if (!sessionStore.has(sessionId)) {
    sessionStore.set(sessionId, { toolCalls: 0, cost: 0, started: Date.now() });
  }
  return sessionStore.get(sessionId);
}

function getDaily(apiKey) {
  const key = `${apiKey}:${todayKey()}`;
  if (!dailyStore.has(key)) {
    dailyStore.set(key, { calls: 0, cost: 0 });
  }
  return dailyStore.get(key);
}

// --- Auth middleware ---
app.use((req, res, next) => {
  if (req.path === '/health') return next();

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${GATEWAY_API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// --- Session + limit tracking middleware ---
app.use((req, res, next) => {
  if (req.path === '/health') return next();

  const sessionId = req.headers['x-session-id'] || 'default';
  const toolName = req.path.replace('/api/', '');
  const toolCost = TOOL_COSTS[toolName] || 0;

  const session = getSession(sessionId);
  const daily   = getDaily(GATEWAY_API_KEY);

  if (session.toolCalls >= LIMITS.maxToolCallsPerSession) {
    return res.status(429).json({
      error: 'Session tool-call limit reached',
      limit: LIMITS.maxToolCallsPerSession,
      used: session.toolCalls,
    });
  }
  if (session.cost + toolCost > LIMITS.maxCostPerSession) {
    return res.status(429).json({
      error: 'Session cost limit reached',
      limit: LIMITS.maxCostPerSession,
      current: session.cost,
    });
  }
  if (daily.calls >= LIMITS.maxCallsPerDay) {
    return res.status(429).json({ error: 'Daily call limit reached' });
  }
  if (daily.cost + toolCost > LIMITS.maxCostPerDay) {
    return res.status(429).json({ error: 'Daily cost limit reached' });
  }

  session.toolCalls++;
  session.cost += toolCost;
  daily.calls++;
  daily.cost += toolCost;

  req.sessionId = sessionId;
  req.toolCost  = toolCost;
  req.toolName  = toolName;
  next();
});

const RESULT_HARD_CAP = 20;
const MIN_SEQUENCE_INDEX = 3;
const MIN_WORD_COUNT = 15;

const SLIM_EPISODE_FIELDS = new Set([
  'title', 'guid', 'feedId', 'publishedDate', 'creator',
  'guests', 'duration', 'episodeCount', 'matchedGuest',
]);

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
    printLog(`[GATEWAY] Fluff filter: removed ${before - data.results.length} intro/short clips`);
  }
  return data;
}

function truncateResults(data) {
  if (data.results && data.results.length > RESULT_HARD_CAP) {
    data.results = data.results.slice(0, RESULT_HARD_CAP);
  }
  if (data.chapters && data.chapters.length > RESULT_HARD_CAP) {
    data.chapters = data.chapters.slice(0, RESULT_HARD_CAP);
  }
  if (data.episodes && data.episodes.length > RESULT_HARD_CAP) {
    data.episodes = data.episodes.slice(0, RESULT_HARD_CAP);
  }
  if (data.people && data.people.length > RESULT_HARD_CAP) {
    data.people = data.people.slice(0, RESULT_HARD_CAP);
  }
  return data;
}

// --- Proxy helper ---
async function proxyToJamie(method, path, body, headers = {}) {
  const url = `${JAMIE_API_BASE}${path}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.JWT_TEST_TOKEN
        ? { 'Authorization': `Bearer ${process.env.JWT_TEST_TOKEN}` }
        : { 'X-Free-Tier': 'true' }),
      ...headers,
    },
  };
  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Jamie API ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ==================================================================
//  Tool endpoints — called by the Claude Managed Agent
// ==================================================================

app.post('/api/search-quotes', async (req, res) => {
  const { query, guid, guids, feedIds, limit, minDate, maxDate } = req.body;
  const clampedLimit = clampLimit(limit, 5);
  const overFetchLimit = Math.min(clampedLimit * 3, RESULT_HARD_CAP);
  const start = Date.now();

  try {
    printLog(`[GATEWAY] search-quotes: query="${query}", limit=${clampedLimit} (requested=${limit || 'default'}, fetching=${overFetchLimit}), smartMode=true`);
    const data = await proxyToJamie('POST', '/api/search-quotes', {
      query, guid, guids, feedIds, limit: overFetchLimit, minDate, maxDate, smartMode: true,
    });
    filterFluffResults(data);

    if (data.results && data.results.length > 2) {
      const clips = data.results.map(r => ({
        quote: r.quote,
        creator: r.creator || r.episode,
        episode: r.episode,
      }));
      const reranked = await rerankClips({ query, clips, openai });
      if (reranked.clips.length > 0) {
        const rerankTexts = new Set(reranked.clips.map(c => c.quote));
        data.results = data.results.filter(r => rerankTexts.has(r.quote));
        printLog(`[GATEWAY] Reranker: ${clips.length} → ${data.results.length} clips`);
      }
    }

    truncateResults(data);
    if (data.results) data.results = data.results.slice(0, clampedLimit);
    printLog(`[GATEWAY] search-quotes: ${data.results?.length || 0} results (${Date.now() - start}ms)`);
    res.json(data);
  } catch (err) {
    printLog(`[GATEWAY] search-quotes ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/search-chapters', async (req, res) => {
  const { search, feedIds, limit, page = 1 } = req.body;
  const clampedLimit = clampLimit(limit, 5);
  const start = Date.now();

  try {
    printLog(`[GATEWAY] search-chapters: search="${search}", limit=${clampedLimit} (requested=${limit || 'default'})`);
    const data = await proxyToJamie('POST', '/api/search-chapters', {
      search, feedIds, limit: clampedLimit, page,
    });
    truncateResults(data);
    printLog(`[GATEWAY] search-chapters: ${data.chapters?.length || 0} results (${Date.now() - start}ms)`);
    res.json(data);
  } catch (err) {
    printLog(`[GATEWAY] search-chapters ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/discover-podcasts', async (req, res) => {
  const { query, limit } = req.body;
  const clampedLimit = clampLimit(limit, 5);
  const start = Date.now();

  try {
    printLog(`[GATEWAY] discover-podcasts: query="${query}", limit=${clampedLimit} (requested=${limit || 'default'})`);
    const data = await proxyToJamie('POST', '/api/discover-podcasts', {
      query, limit: clampedLimit,
    });
    truncateResults(data);
    printLog(`[GATEWAY] discover-podcasts: ${data.results?.length || 0} results (${Date.now() - start}ms)`);
    res.json(data);
  } catch (err) {
    printLog(`[GATEWAY] discover-podcasts ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/find-person', async (req, res) => {
  const { name } = req.body;
  const start = Date.now();

  try {
    printLog(`[GATEWAY] find-person: name="${name}"`);
    const data = await proxyToJamie('GET', `/api/corpus/people?search=${encodeURIComponent(name)}&limit=${RESULT_HARD_CAP}`);
    const normalized = { people: data.data || [], pagination: data.pagination, query: data.query };
    truncateResults(normalized);
    printLog(`[GATEWAY] find-person: ${normalized.people?.length || 0} results (${Date.now() - start}ms)`);
    res.json(normalized);
  } catch (err) {
    printLog(`[GATEWAY] find-person ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/get-person-episodes', async (req, res) => {
  const { name, limit, verbose } = req.body;
  const clampedLimit = clampLimit(limit, 5);
  const start = Date.now();

  try {
    printLog(`[GATEWAY] get-person-episodes: name="${name}", limit=${clampedLimit} (requested=${limit || 'default'})`);
    const data = await proxyToJamie('POST', '/api/corpus/people/episodes', {
      name, limit: clampedLimit,
    });
    const normalized = { episodes: data.data || [], pagination: data.pagination, query: data.query };
    truncateResults(normalized);
    if (!verbose && normalized.episodes) {
      normalized.episodes = normalized.episodes.map(slimEpisode);
    }
    printLog(`[GATEWAY] get-person-episodes: ${normalized.episodes?.length || 0} results, slim=${!verbose} (${Date.now() - start}ms)`);
    res.json(normalized);
  } catch (err) {
    printLog(`[GATEWAY] get-person-episodes ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// --- List Episode Chapters (direct fetch, no search) ---

app.post('/api/list-episode-chapters', async (req, res) => {
  const { guids, feedIds, limit } = req.body;
  const start = Date.now();

  try {
    const queryParams = new URLSearchParams();
    if (guids && guids.length > 0) queryParams.set('guids', guids.join(','));
    if (feedIds && feedIds.length > 0) queryParams.set('feedIds', feedIds.join(','));
    if (limit) queryParams.set('limit', Math.min(limit, RESULT_HARD_CAP * 2));

    printLog(`[GATEWAY] list-episode-chapters: guids=${guids?.length || 0}, feedIds=${feedIds?.length || 0}`);
    const data = await proxyToJamie('GET', `/api/corpus/chapters?${queryParams.toString()}`);
    const chapters = data.data || data.chapters || data || [];
    const normalized = { chapters: Array.isArray(chapters) ? chapters : [] };
    printLog(`[GATEWAY] list-episode-chapters: ${normalized.chapters.length} chapters (${Date.now() - start}ms)`);
    res.json(normalized);
  } catch (err) {
    printLog(`[GATEWAY] list-episode-chapters ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// --- Get Episode by GUID ---

app.post('/api/get-episode', async (req, res) => {
  const { guid } = req.body;
  const start = Date.now();

  try {
    printLog(`[GATEWAY] get-episode: guid="${guid}"`);
    const data = await proxyToJamie('GET', `/api/corpus/episodes/${encodeURIComponent(guid)}`);
    const normalized = { episode: data.data || data };
    printLog(`[GATEWAY] get-episode: ${normalized.episode?.title || 'found'} (${Date.now() - start}ms)`);
    res.json(normalized);
  } catch (err) {
    printLog(`[GATEWAY] get-episode ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// --- Get Feed by ID ---

app.post('/api/get-feed', async (req, res) => {
  const { feedId } = req.body;
  const start = Date.now();

  try {
    printLog(`[GATEWAY] get-feed: feedId="${feedId}"`);
    const data = await proxyToJamie('GET', `/api/corpus/feeds/${encodeURIComponent(feedId)}`);
    const normalized = { feed: data.data || data };
    printLog(`[GATEWAY] get-feed: ${normalized.feed?.title || 'found'} (${Date.now() - start}ms)`);
    res.json(normalized);
  } catch (err) {
    printLog(`[GATEWAY] get-feed ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// --- Get Feed Episodes ---

app.post('/api/get-feed-episodes', async (req, res) => {
  const { feedId, limit, minDate, maxDate, verbose } = req.body;
  const clampedLimit = clampLimit(limit, 10);
  const start = Date.now();

  try {
    const queryParams = new URLSearchParams({ limit: clampedLimit });
    if (minDate) queryParams.set('minDate', minDate);
    if (maxDate) queryParams.set('maxDate', maxDate);

    printLog(`[GATEWAY] get-feed-episodes: feedId="${feedId}", limit=${clampedLimit}`);
    const data = await proxyToJamie('GET', `/api/corpus/feeds/${encodeURIComponent(feedId)}/episodes?${queryParams.toString()}`);
    const normalized = { episodes: data.data || [], pagination: data.pagination };
    truncateResults(normalized);
    if (!verbose && normalized.episodes) {
      normalized.episodes = normalized.episodes.map(slimEpisode);
    }
    printLog(`[GATEWAY] get-feed-episodes: ${normalized.episodes?.length || 0} episodes, slim=${!verbose} (${Date.now() - start}ms)`);
    res.json(normalized);
  } catch (err) {
    printLog(`[GATEWAY] get-feed-episodes ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// --- Get Adjacent Paragraphs (context expansion) ---

app.post('/api/get-adjacent-paragraphs', async (req, res) => {
  const { paragraphId, windowSize } = req.body;
  const clampedWindow = Math.min(Math.max(1, windowSize || 3), 10);
  const start = Date.now();

  try {
    printLog(`[GATEWAY] get-adjacent-paragraphs: id="${paragraphId}", window=${clampedWindow}`);
    const data = await proxyToJamie('GET', `/api/adjacent-paragraphs/${encodeURIComponent(paragraphId)}?windowSize=${clampedWindow}`);
    const normalized = {
      before: data.before || [],
      current: data.current || null,
      after: data.after || [],
    };
    const totalCount = normalized.before.length + (normalized.current ? 1 : 0) + normalized.after.length;
    printLog(`[GATEWAY] get-adjacent-paragraphs: ${totalCount} paragraphs (${Date.now() - start}ms)`);
    res.json(normalized);
  } catch (err) {
    printLog(`[GATEWAY] get-adjacent-paragraphs ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// --- Usage / health ---

app.get('/api/usage/:sessionId', (req, res) => {
  const session = sessionStore.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({
    sessionId: req.params.sessionId,
    usage: session,
    limits: LIMITS,
    remaining: {
      toolCalls: LIMITS.maxToolCallsPerSession - session.toolCalls,
      cost: LIMITS.maxCostPerSession - session.cost,
    },
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'agent-gateway', uptime: process.uptime() });
});

// --- Start ---

app.listen(GATEWAY_PORT, () => {
  console.log(`\n[AGENT-GATEWAY] Running on port ${GATEWAY_PORT}`);
  console.log(`[AGENT-GATEWAY] Proxying to Jamie API at ${JAMIE_API_BASE}`);
  console.log(`[AGENT-GATEWAY] API key: ${GATEWAY_API_KEY}\n`);
});
