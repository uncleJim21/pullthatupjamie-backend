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

const app = express();
app.use(express.json());

const JAMIE_API_BASE = process.env.JAMIE_API_BASE || 'http://localhost:4132';
const GATEWAY_PORT = parseInt(process.env.AGENT_GATEWAY_PORT || '3456', 10);
const GATEWAY_API_KEY = process.env.AGENT_GATEWAY_KEY || 'jamie_agent_poc_key';

const TOOL_COSTS = {
  'search-quotes':        0.004,
  'search-chapters':      0.004,
  'discover-podcasts':    0.005,
  'find-person':          0.001,
  'get-person-episodes':  0.001,
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
  const { query, guid, guids, feedIds, limit = 10, minDate, maxDate } = req.body;
  const start = Date.now();

  try {
    printLog(`[GATEWAY] search-quotes: query="${query}", limit=${limit}`);
    const data = await proxyToJamie('POST', '/api/search-quotes', {
      query, guid, guids, feedIds, limit, minDate, maxDate,
    });
    printLog(`[GATEWAY] search-quotes: ${data.results?.length || 0} results (${Date.now() - start}ms)`);
    res.json(data);
  } catch (err) {
    printLog(`[GATEWAY] search-quotes ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/search-chapters', async (req, res) => {
  const { search, feedIds, limit = 20, page = 1 } = req.body;
  const start = Date.now();

  try {
    printLog(`[GATEWAY] search-chapters: search="${search}", limit=${limit}`);
    const data = await proxyToJamie('POST', '/api/search-chapters', {
      search, feedIds, limit, page,
    });
    printLog(`[GATEWAY] search-chapters: ${data.chapters?.length || 0} results (${Date.now() - start}ms)`);
    res.json(data);
  } catch (err) {
    printLog(`[GATEWAY] search-chapters ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/discover-podcasts', async (req, res) => {
  const { query, limit = 10 } = req.body;
  const start = Date.now();

  try {
    printLog(`[GATEWAY] discover-podcasts: query="${query}", limit=${limit}`);
    const data = await proxyToJamie('POST', '/api/discover-podcasts', {
      query, limit,
    });
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
    const data = await proxyToJamie('GET', `/api/corpus/people?search=${encodeURIComponent(name)}&limit=20`);
    printLog(`[GATEWAY] find-person: ${data.people?.length || 0} results (${Date.now() - start}ms)`);
    res.json(data);
  } catch (err) {
    printLog(`[GATEWAY] find-person ERROR: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/get-person-episodes', async (req, res) => {
  const { name, limit = 20 } = req.body;
  const start = Date.now();

  try {
    printLog(`[GATEWAY] get-person-episodes: name="${name}", limit=${limit}`);
    const data = await proxyToJamie('POST', '/api/corpus/people/episodes', {
      name, limit,
    });
    printLog(`[GATEWAY] get-person-episodes: ${data.episodes?.length || 0} results (${Date.now() - start}ms)`);
    res.json(data);
  } catch (err) {
    printLog(`[GATEWAY] get-person-episodes ERROR: ${err.message}`);
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
