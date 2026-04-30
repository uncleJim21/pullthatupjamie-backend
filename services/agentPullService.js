/**
 * Internal callable for the /api/pull agent loop.
 *
 * The real /api/pull endpoint is `serviceHmac → entitlementMiddleware
 * → agentChatRouter('/agent')`. This service replays only the last leg
 * — it constructs minimal Express-like req/res objects, sets the
 * non-streaming flag, and invokes the existing router. The bot
 * pre-debits the npub-keyed pull entitlement on its own before
 * calling here, so we skip the middleware entirely.
 *
 * Returns:
 *   { ok: true,  sessionId, text, suggestedActions, session? }
 *   { ok: false, status, error }
 *
 * Streams are explicitly disabled (we force `_defaultStream = false`
 * and don't accept SSE). The agent's `res.status(...).json(...)` call
 * fires once at the end and resolves the outer promise.
 *
 * NOTE: the agent handler creates its own provider clients per
 * invocation; we don't need to inject anything beyond the openai
 * dependency the router already holds. To keep the bot independent of
 * the live Express app, we lazily build a router instance on first
 * call.
 */

const createAgentChatRoutes = require('../routes/agentChatRoutes');

let cachedRouter = null;
function getRouter() {
  if (cachedRouter) return cachedRouter;
  const { OpenAI } = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  cachedRouter = createAgentChatRoutes({ openai });
  return cachedRouter;
}

function buildFakeReq({ message, history, context, sessionId, identity }) {
  return {
    method: 'POST',
    url: '/agent',
    path: '/agent',
    originalUrl: '/api/pull',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    query: {},
    body: {
      message,
      history: Array.isArray(history) ? history : undefined,
      context: context || undefined,
      sessionId: sessionId || undefined,
      stream: false,
      bypassTriage: false,
    },
    identity: identity || undefined,
    entitlement: { type: 'pull', isLightning: false, source: 'nostr-bot' },
    _defaultStream: false,
    ip: '127.0.0.1',
    on() {},
  };
}

function buildFakeRes(resolve) {
  const headers = {};
  let statusCode = 200;
  let settled = false;
  const closeListeners = [];

  const finalize = (body) => {
    if (settled) return;
    settled = true;
    resolve({ statusCode, body, headers });
  };

  return {
    headersSent: false,
    statusCode,
    status(code) {
      statusCode = code;
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return headers[String(name).toLowerCase()]; },
    removeHeader(name) { delete headers[String(name).toLowerCase()]; },
    json(body) {
      this.headersSent = true;
      finalize(body);
      return this;
    },
    send(body) {
      this.headersSent = true;
      try {
        finalize(typeof body === 'string' ? JSON.parse(body) : body);
      } catch (_) {
        finalize({ raw: String(body) });
      }
      return this;
    },
    write() { /* swallowed — non-streaming */ },
    writeHead() { /* swallowed — non-streaming */ },
    end() {
      if (!settled) finalize({ ended: true });
    },
    on(event, cb) {
      if (event === 'close') closeListeners.push(cb);
    },
    emit(event) {
      if (event === 'close') {
        for (const cb of closeListeners) {
          try { cb(); } catch (_) { /* ignore */ }
        }
      }
    },
  };
}

/**
 * Run a single non-streaming pull and return the captured agent
 * response.
 *
 * @param {Object} params
 * @param {string} params.message              user prompt
 * @param {Object} [params.identity]           pre-resolved identity
 * @param {Array}  [params.history]            prior turns [{role,content}]
 * @param {Object} [params.context]            follow-up context hints
 * @param {string} [params.sessionId]
 * @param {number} [params.timeoutMs=180000]   abort if the agent doesn't finish
 *
 * @returns {Promise<{ok:true,sessionId,text,suggestedActions,session?}
 *                 | {ok:false,status,error}>}
 */
async function runPull({
  message,
  identity,
  history,
  context,
  sessionId,
  timeoutMs = 3 * 60 * 1000,
}) {
  if (!message || typeof message !== 'string' || !message.trim()) {
    return { ok: false, status: 400, error: 'message is required' };
  }

  const router = getRouter();
  const responsePromise = new Promise((resolve) => {
    const req = buildFakeReq({ message, history, context, sessionId, identity });
    const res = buildFakeRes(resolve);

    let timer = setTimeout(() => {
      // Mimic client disconnect so the agent's res.on('close') hook fires.
      try { res.emit('close'); } catch (_) { /* ignore */ }
      // Then resolve with a timeout error.
      resolve({ statusCode: 504, body: { error: 'agent timeout', timeoutMs } });
    }, timeoutMs);

    // Patch res.json to also clear the timer.
    const origJson = res.json.bind(res);
    res.json = (body) => {
      clearTimeout(timer);
      return origJson(body);
    };

    try {
      router(req, res, (err) => {
        clearTimeout(timer);
        if (err) resolve({ statusCode: 500, body: { error: err.message } });
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ statusCode: 500, body: { error: err.message } });
    }
  });

  const { statusCode, body } = await responsePromise;

  if (statusCode >= 200 && statusCode < 300) {
    return {
      ok: true,
      sessionId: body.sessionId,
      text: body.text || '',
      suggestedActions: Array.isArray(body.suggestedActions) ? body.suggestedActions : [],
      session: body.session || null,
    };
  }
  return {
    ok: false,
    status: statusCode,
    error: body && body.error ? body.error : `agent returned status ${statusCode}`,
  };
}

module.exports = { runPull };
