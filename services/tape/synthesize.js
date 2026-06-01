/**
 * synthesize (spec §4) — the direct LLM writer.
 *
 * Takes pre-filtered candidates from person-quotes / topic-quotes and runs ONE
 * synthesis pass (no tools, no agent loop, no re-search) grounded strictly on
 * those candidates. Deterministic for a fixed (candidates + input + model +
 * prompt version), so the result is content-addressed and cached aggressively.
 *
 * Reuses the existing provider abstraction (createProvider) + model routing
 * (resolveModelSelection) + clip-token sanitizers.
 */

const { resolveModelSelection } = require('../../constants/agentModels');
const { createProvider } = require('../../utils/agent/providers');
const { sanitizeAgentText, createStreamSanitizer } = require('../../utils/agent/sanitizeOutput');
const { VALID_KINDS, systemPromptFor, buildUserMessage, PROMPT_VERSION } = require('./tapePrompts');
const { getCached, setCached, addAndGet } = require('./tapeStore');
const { TIER, synTtlSec, buildFreshnessMeta } = require('./tapeFreshness');
const { tapeError, tapeRateLimited, TapeHttpError } = require('./tapeErrors');
const { checkRateLimit, logTape } = require('./tapeEndpoint');
const { hashBody } = require('./tapeShared');
const { printLog } = require('../../constants');

const MAX_TOKENS = parseInt(process.env.TAPE_SYN_MAX_TOKENS || '2048', 10);
const DAILY_TOKEN_CAP = parseInt(process.env.TAPE_DAILY_OUTPUT_TOKEN_CAP || '5000000', 10);
const DAILY_USD_CAP = process.env.TAPE_DAILY_USD_CAP ? parseFloat(process.env.TAPE_DAILY_USD_CAP) : null;
const HOURLY_LIMIT = parseInt(process.env.TAPE_SYN_HOURLY_LIMIT || '30', 10);
const NOCACHE_ENABLED = process.env.TAPE_NOCACHE_ENABLED === 'true';

const CLIP_RE = /\{\{clip:([^}]+)\}\}/g;

/** Strip {{clip:id}} tokens whose id was not in the provided candidate set. */
function stripUnknownClipTokens(text, validIds) {
  if (typeof text !== 'string') return text;
  return text.replace(CLIP_RE, (m, id) => (validIds.has(id.trim()) ? m : ''));
}

function utcDateKey() { return new Date().toISOString().slice(0, 10); }
function secondsUntilUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(60, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/** One synthesis pass. Returns { rawText, usage }. */
async function runSynthesis({ kind, input, candidates, modelConfig, onDelta }) {
  const provider = createProvider(modelConfig.provider);
  const ready = await provider.validate();
  if (!ready) {
    throw new TapeHttpError(502, 'upstream-failure', 'Synthesis provider unavailable',
      `Provider ${modelConfig.provider} for model ${modelConfig.label} is not configured.`);
  }
  const result = await provider.createResponse({
    model: modelConfig.id,
    maxTokens: modelConfig.maxSynthesisTokens || MAX_TOKENS,
    system: systemPromptFor(kind),
    messages: [{ role: 'user', content: buildUserMessage({ kind, input, candidates }) }],
    tools: undefined,
    toolChoice: 'none',
    temperature: 0.4,
    onTextDelta: onDelta || (() => {}),
    aborted: () => false,
  });
  const rawText = (result.contentBlocks || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { rawText, usage: result.usage || { input_tokens: 0, output_tokens: 0 } };
}

async function recordCost(usage, modelConfig, dayKey, ttlDay) {
  const outTok = usage.output_tokens || 0;
  if (DAILY_TOKEN_CAP > 0) await addAndGet(`tape:syn:tok:${dayKey}`, outTok, ttlDay);
  if (DAILY_USD_CAP) {
    const cost = ((usage.input_tokens || 0) * (modelConfig.inputPer1M || 0)
      + outTok * (modelConfig.outputPer1M || 0)) / 1e6;
    await addAndGet(`tape:syn:usd:${dayKey}`, Math.round(cost * 1e6), ttlDay);
  }
}

function costUsd(usage, modelConfig) {
  return parseFloat((((usage.input_tokens || 0) * (modelConfig.inputPer1M || 0)
    + (usage.output_tokens || 0) * (modelConfig.outputPer1M || 0)) / 1e6).toFixed(4));
}

// --- SSE helpers (same event shape as /api/pull) ---
function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.socket?.setNoDelay?.(true);
}
function sseSend(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* client gone */ }
}

/** Express handler for POST /api/tape/synthesize. */
function createSynthesizeHandler() {
  return async (req, res) => {
    const startedAt = Date.now();
    const body = req.body || {};
    const stream = body.stream === true;

    try {
      if (!(await checkRateLimit(req, res, 'synthesize', HOURLY_LIMIT))) return;

      const { kind, input = {}, candidates = [], model = 'fast' } = body;
      if (!VALID_KINDS.includes(kind)) {
        throw new TapeHttpError(400, 'bad-request', 'Bad request', `kind must be one of: ${VALID_KINDS.join(', ')}`);
      }
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new TapeHttpError(400, 'bad-request', 'Bad request', 'candidates must be a non-empty array');
      }

      const { modelConfig } = resolveModelSelection({ model });
      const validIds = new Set(candidates.map((c) => c.pineconeId).filter(Boolean));

      const keyHash = hashBody({
        candidates: candidates.map((c) => ({ id: c.pineconeId, text: c.text })),
        input, model: modelConfig.id, pv: PROMPT_VERSION,
      });
      const cacheKey = `tape:syn:v1:${kind}:${keyHash}`;
      const ttl = synTtlSec();
      const noCache = NOCACHE_ENABLED && body._nocache === true;
      // User-facing "force re-synthesize": bypasses the cache READ so a fresh
      // pass is generated, but still WRITES the result back (unlike _nocache,
      // which is a gated debug bypass of both read and write). Spends tokens
      // and counts against the daily cap.
      //
      // TODO(beta): cap force-resynthesize per user (e.g. N/day) once we have a
      // baseline. Left UNLIMITED during beta on purpose — we only measure it
      // for now (see the `tape:syn:resynth:*` counters + the `forced` log
      // field) so the limit we pick before GA is grounded in real usage.
      const refresh = body.refresh === true;

      // --- cache hit (free; no LLM tokens) ---
      if (!noCache && !refresh) {
        const prior = await getCached(cacheKey);
        if (prior) {
          const cachedBody = {
            ...prior.value,
            _meta: {
              ...(prior.value._meta || {}),
              ...buildFreshnessMeta({
                tier: TIER.QUALITATIVE, cached: true, cachedAt: prior.cachedAt,
                fetchedAt: prior.value._meta?.fetchedAt, ttlSec: ttl,
              }),
            },
          };
          logTape({ endpoint: 'synthesize', kind, jwt_sub: req.tape?.sub, cache: 'hit', tokens: { input: 0, output: 0 }, status: 200, elapsed_ms: Date.now() - startedAt });
          if (stream) {
            sseInit(res);
            sseSend(res, 'status', { message: 'Cached', kind });
            sseSend(res, 'text', { text: cachedBody.text });
            sseSend(res, 'done', { kind, model: cachedBody.model, tokens: cachedBody.tokens, cached: true });
            return res.end();
          }
          return res.status(200).json(cachedBody);
        }
      }

      // --- global daily cap (check before spending) ---
      const dayKey = utcDateKey();
      const ttlDay = secondsUntilUtcMidnight();
      if (DAILY_TOKEN_CAP > 0) {
        const tot = await addAndGet(`tape:syn:tok:${dayKey}`, 0, ttlDay);
        if (tot >= DAILY_TOKEN_CAP) {
          console.warn(`[tape:synthesize] DAILY OUTPUT TOKEN CAP reached (${tot}/${DAILY_TOKEN_CAP}) — refusing until next UTC day`);
          logTape({ endpoint: 'synthesize', kind, jwt_sub: req.tape?.sub, status: 429, error: 'daily-cap', elapsed_ms: Date.now() - startedAt });
          return tapeRateLimited(res, { detail: 'Daily synthesis token cap reached; resets at UTC midnight.', retryAfterSec: ttlDay });
        }
      }
      if (DAILY_USD_CAP) {
        const micro = await addAndGet(`tape:syn:usd:${dayKey}`, 0, ttlDay);
        if (micro / 1e6 >= DAILY_USD_CAP) {
          console.warn(`[tape:synthesize] DAILY USD CAP reached ($${(micro / 1e6).toFixed(2)}/$${DAILY_USD_CAP})`);
          return tapeRateLimited(res, { detail: 'Daily synthesis cost cap reached; resets at UTC midnight.', retryAfterSec: ttlDay });
        }
      }

      // Measure force-resynthesize usage (beta: unlimited, measured only — see
      // the TODO above). Per-user + global daily counters so we can see who is
      // hammering it and the overall volume before setting a cap.
      if (refresh) {
        const sub = req.tape?.sub || 'anon';
        const perUser = await addAndGet(`tape:syn:resynth:${sub}:${dayKey}`, 1, ttlDay);
        await addAndGet(`tape:syn:resynth:all:${dayKey}`, 1, ttlDay);
        printLog(`[tape:synthesize] forced re-synthesize by ${sub} (#${perUser} today, kind=${kind})`);
      }

      // --- run synthesis ---
      const fetchedAt = new Date().toISOString();

      if (stream) {
        sseInit(res);
        sseSend(res, 'status', { message: 'Synthesizing…', kind });
        const sanitizer = createStreamSanitizer();
        const onDelta = (d) => { const safe = sanitizer.feed(d); if (safe) sseSend(res, 'text_delta', { text: safe }); };

        const { rawText, usage } = await runSynthesis({ kind, input, candidates, modelConfig, onDelta });
        const tail = sanitizer.flush();
        if (tail) sseSend(res, 'text_delta', { text: tail });
        const finalText = stripUnknownClipTokens(sanitizeAgentText(rawText), validIds);

        const outBody = {
          kind, text: finalText,
          tokens: { input: usage.input_tokens, output: usage.output_tokens },
          model: modelConfig.id, elapsedMs: Date.now() - startedAt,
          _meta: { fetchedAt },
        };
        outBody._meta = { ...outBody._meta, forced: refresh, ...buildFreshnessMeta({ tier: TIER.QUALITATIVE, cached: false, cachedAt: fetchedAt, fetchedAt, ttlSec: ttl }) };
        if (!noCache) await setCached(cacheKey, outBody, ttl);
        await recordCost(usage, modelConfig, dayKey, ttlDay);

        sseSend(res, 'text', { text: finalText });
        sseSend(res, 'done', { kind, model: modelConfig.id, tokens: outBody.tokens, cached: false, forced: refresh });
        logTape({ endpoint: 'synthesize', kind, jwt_sub: req.tape?.sub, cache: 'miss', forced: refresh, tokens: outBody.tokens, model: modelConfig.id, cost_usd_est: costUsd(usage, modelConfig), status: 200, elapsed_ms: Date.now() - startedAt });
        return res.end();
      }

      // non-stream
      const { rawText, usage } = await runSynthesis({ kind, input, candidates, modelConfig });
      const finalText = stripUnknownClipTokens(sanitizeAgentText(rawText), validIds);
      const outBody = {
        kind, text: finalText,
        tokens: { input: usage.input_tokens, output: usage.output_tokens },
        model: modelConfig.id, elapsedMs: Date.now() - startedAt,
        _meta: { fetchedAt },
      };
      outBody._meta = { ...outBody._meta, forced: refresh, ...buildFreshnessMeta({ tier: TIER.QUALITATIVE, cached: false, cachedAt: fetchedAt, fetchedAt, ttlSec: ttl }) };
      if (!noCache) await setCached(cacheKey, outBody, ttl);
      await recordCost(usage, modelConfig, dayKey, ttlDay);

      logTape({ endpoint: 'synthesize', kind, jwt_sub: req.tape?.sub, cache: 'miss', forced: refresh, tokens: outBody.tokens, model: modelConfig.id, cost_usd_est: costUsd(usage, modelConfig), status: 200, elapsed_ms: Date.now() - startedAt });
      return res.status(200).json(outBody);
    } catch (err) {
      if (res.headersSent) {
        // streaming already started — surface as an SSE error and close.
        sseSend(res, 'error', { error: err instanceof TapeHttpError ? err.detail || err.title : err.message });
        return res.end();
      }
      if (err instanceof TapeHttpError) {
        logTape({ endpoint: 'synthesize', jwt_sub: req.tape?.sub, status: err.status, error: err.slug, elapsed_ms: Date.now() - startedAt });
        return tapeError(res, err.status, err.slug, err.title, err.detail, err.extra);
      }
      printLog(`[tape:synthesize] error: ${err.message}`);
      logTape({ endpoint: 'synthesize', jwt_sub: req.tape?.sub, status: 502, error: 'upstream', detail: err.message, elapsed_ms: Date.now() - startedAt });
      return tapeError(res, 502, 'upstream-failure', 'Upstream failure', err.message);
    }
  };
}

module.exports = { createSynthesizeHandler, runSynthesis, stripUnknownClipTokens };
