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

const fs = require('fs');
const { resolveModelSelection } = require('../../constants/agentModels');
const { createProvider } = require('../../utils/agent/providers');
const { sanitizeAgentText, createStreamSanitizer } = require('../../utils/agent/sanitizeOutput');
const { VALID_KINDS, systemPromptFor, buildUserMessage, validateKindCompliance, EMPTY_SENTINEL, TICKERS_MARKER, PROMPT_VERSION } = require('./tapePrompts');
const { extractTickers } = require('./tickerExtract');
const { buildAliases } = require('./tickerResolver');
const { assessConfidence } = require('./confidence');
const { getCached, setCached, addAndGet } = require('./tapeStore');
const { TIER, synTtlSec, buildFreshnessMeta } = require('./tapeFreshness');
const { tapeError, tapeRateLimited, TapeHttpError } = require('./tapeErrors');
const { checkRateLimit, logTape } = require('./tapeEndpoint');
const { hashBody } = require('./tapeShared');
const { printLog } = require('../../constants');

// Headroom for REASONING models (DeepSeek V4, gpt-5-nano): they spend
// reasoning_content tokens before emitting visible text, so a low cap makes
// them hit max_tokens mid-think and return zero prose. 8k leaves room to reason
// AND answer; non-reasoning models (Haiku, gpt-4o-mini) stop when done and don't
// approach it, so the only cost effect is on reasoning models (still cheap).
const MAX_TOKENS = parseInt(process.env.TAPE_SYN_MAX_TOKENS || '8000', 10);
const DAILY_TOKEN_CAP = parseInt(process.env.TAPE_DAILY_OUTPUT_TOKEN_CAP || '5000000', 10);
const DAILY_USD_CAP = process.env.TAPE_DAILY_USD_CAP ? parseFloat(process.env.TAPE_DAILY_USD_CAP) : null;
const HOURLY_LIMIT = parseInt(process.env.TAPE_SYN_HOURLY_LIMIT || '30', 10);
const NOCACHE_ENABLED = process.env.TAPE_NOCACHE_ENABLED === 'true';

const CLIP_RE = /\{\{clip:([^}]+)\}\}/g;
const TICKERS_HEADER_RE = new RegExp(`#{1,3}\\s*${TICKERS_MARKER}\\b`, 'i');

/**
 * Streaming gate: suppress everything from the `## TICKERS` header onward so the
 * parsed-off block never reaches the client as text_delta. Holds back a short
 * tail each feed so a marker split across deltas is still caught.
 */
function createMarkerCut(headerRe) {
  let full = '';
  let emitted = 0;
  let cut = false;
  const HOLD = 16;
  return {
    feed(delta) {
      if (cut) return '';
      full += delta || '';
      const m = full.match(headerRe);
      if (m && m.index != null) {
        const out = full.slice(emitted, Math.max(emitted, m.index));
        emitted = full.length;
        cut = true;
        return out;
      }
      const safeEnd = Math.max(emitted, full.length - HOLD);
      const out = full.slice(emitted, safeEnd);
      emitted = safeEnd;
      return out;
    },
    flush() {
      if (cut) return '';
      const out = full.slice(emitted);
      emitted = full.length;
      return out;
    },
  };
}

/** Strip {{clip:id}} tokens whose id was not in the provided candidate set. */
function stripUnknownClipTokens(text, validIds) {
  if (typeof text !== 'string') return text;
  return text.replace(CLIP_RE, (m, id) => (validIds.has(id.trim()) ? m : ''));
}

/**
 * Sanitize the raw model output and detect a GENUINELY empty result (blank or
 * the explicit EMPTY_SENTINEL). Kind-contract conformance is NOT judged here —
 * that's `validateKindCompliance` in `produce`, which can retry on a violation
 * rather than silently emptying a wrong-shaped (but non-empty) result.
 * Returns { text, synthesizedEmpty, reason }.
 */
function finalizeText(rawText, kind, validIds) {
  const sanitized = stripUnknownClipTokens(sanitizeAgentText(rawText) || '', validIds);
  const trimmed = sanitized.trim();
  if (!trimmed || trimmed.replace(/[.\s]+$/, '').toUpperCase() === EMPTY_SENTINEL) {
    return { text: '', synthesizedEmpty: true, reason: 'candidates did not contain enough on-topic material' };
  }
  return { text: sanitized, synthesizedEmpty: false, reason: null };
}

function utcDateKey() { return new Date().toISOString().slice(0, 10); }
function secondsUntilUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(60, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/**
 * Resolve a ticker the user typed (input.ticker for readin, input.topic for
 * split/brief) to a company name — pure/curated lookup, no network — so the
 * synthesis model picks sector-correct peers (e.g. APP → AppLovin → adtech).
 * Returns "APP = AppLovin" or null.
 */
function companyHintFor(input = {}) {
  const cand = [input.ticker, input.topic].find(
    (v) => typeof v === 'string' && /^[A-Z]{1,5}$/.test(v.trim()),
  );
  if (!cand) return null;
  const tk = cand.trim();
  const { name } = buildAliases(tk);
  return name && name.toLowerCase() !== tk.toLowerCase() ? `${tk} = ${name}` : null;
}

/** One synthesis pass. Returns { rawText, usage }. `reflection` is appended to
 *  the user message on a compliance-retry to nudge the model back on-contract. */
async function runSynthesis({ kind, input, candidates, modelConfig, onDelta, reflection }) {
  const companyHint = companyHintFor(input);
  const provider = createProvider(modelConfig.provider);
  const ready = await provider.validate();
  if (!ready) {
    throw new TapeHttpError(502, 'upstream-failure', 'Synthesis provider unavailable',
      `Provider ${modelConfig.provider} for model ${modelConfig.label} is not configured.`);
  }
  let userMsg = buildUserMessage({ kind, input, candidates, companyHint });
  if (reflection) userMsg += `\n\n${reflection}`;
  const result = await provider.createResponse({
    model: modelConfig.id,
    maxTokens: modelConfig.maxSynthesisTokens || MAX_TOKENS,
    system: systemPromptFor(kind),
    messages: [{ role: 'user', content: userMsg }],
    tools: undefined,
    // No tools on the synthesis path. Don't send tool_choice:'none' — OpenAI
    // rejects tool_choice without tools (400); omitting it works across all
    // providers (no tools ⇒ nothing to call anyway).
    toolChoice: undefined,
    temperature: 0.4,
    onTextDelta: onDelta || (() => {}),
    aborted: () => false,
  });
  // Provider returns { content: [...blocks], usage, stop_reason } — the blocks
  // live under `content`, not `contentBlocks`.
  const rawText = (result.content || [])
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

/**
 * Log a kind-compliance failure (input + offending output) for the prompt-
 * hardening / eval dataset. Always emits a structured stdout line; also appends
 * to TAPE_COMPLIANCE_LOG_FILE (JSONL) when set, for local fixture collection.
 */
function logCompliance(ctx, info) {
  const entry = {
    event: 'kind-compliance-fail',
    ts: new Date().toISOString(),
    endpoint: 'synthesize',
    jwt_sub: ctx.sub || null,
    model: ctx.model || null,
    kind: info.kind,
    attempt: info.attempt,
    reason: info.reason,
    missing: !!info.missing,
    leaked: info.leaked || [],
    input: info.input || null,
    candidatePineconeIds: (info.candidates || []).map((c) => c.pineconeId).filter(Boolean),
    offendingText: info.offendingText || '',
  };
  try { printLog(`[tape:kind-compliance] ${JSON.stringify(entry)}`); } catch (_) { /* never throw */ }
  console.warn(`[tape:kind-compliance] kind=${info.kind} attempt=${info.attempt} reason="${info.reason}"`);
  const file = process.env.TAPE_COMPLIANCE_LOG_FILE;
  if (file) { try { fs.appendFile(file, `${JSON.stringify(entry)}\n`, () => {}); } catch (_) { /* best-effort */ } }
}

/**
 * Generate a synthesis, validate it against the kind contract, and auto-retry
 * once with a reflection nudge on failure. Returns the validated result, or
 * throws TapeHttpError(502, 'kind-compliance') if the retry also violates the
 * contract — we never serve malformed text. A legitimately empty result
 * (sentinel / sparse candidates) is returned as-is (valid render state).
 *
 * @returns {Promise<{finalText:string, tickers:string[], synthesizedEmpty:boolean,
 *                    reason?:string, usage:object, attempts:number, recovered?:boolean}>}
 */
async function produce({ kind, input, candidates, modelConfig, validIds, onDelta, ctx, runner = runSynthesis }) {
  const a1 = await runner({ kind, input, candidates, modelConfig, onDelta });
  const e1 = extractTickers(a1.rawText);
  const f1 = finalizeText(e1.cleanedText, kind, validIds);
  if (f1.synthesizedEmpty) {
    return { finalText: '', tickers: [], synthesizedEmpty: true, reason: f1.reason, usage: a1.usage, attempts: 1 };
  }
  const v1 = validateKindCompliance(kind, f1.text);
  if (v1.ok) {
    return { finalText: f1.text, tickers: e1.tickers, synthesizedEmpty: false, usage: a1.usage, attempts: 1 };
  }

  logCompliance(ctx, { attempt: 1, kind, input, candidates, reason: v1.reason, missing: v1.missing, leaked: v1.leaked, offendingText: f1.text });

  // One auto-retry with an explicit reflection (no streaming on the retry).
  const reflection = `Your previous output used the wrong markers (${v1.reason}). `
    + `Produce ONLY the marker contract for kind: ${kind}. Do NOT use any markers from other kinds.`;
  const a2 = await runner({ kind, input, candidates, modelConfig, reflection });
  const usage = {
    input_tokens: (a1.usage.input_tokens || 0) + (a2.usage.input_tokens || 0),
    output_tokens: (a1.usage.output_tokens || 0) + (a2.usage.output_tokens || 0),
  };
  const e2 = extractTickers(a2.rawText);
  const f2 = finalizeText(e2.cleanedText, kind, validIds);
  if (!f2.synthesizedEmpty) {
    const v2 = validateKindCompliance(kind, f2.text);
    if (v2.ok) {
      return { finalText: f2.text, tickers: e2.tickers, synthesizedEmpty: false, usage, attempts: 2, recovered: true };
    }
    logCompliance(ctx, { attempt: 2, kind, input, candidates, reason: v2.reason, missing: v2.missing, leaked: v2.leaked, offendingText: f2.text });
    const e = new TapeHttpError(502, 'kind-compliance', 'Synthesizer output violated kind contract', `${kind}: ${v2.reason}`);
    e.usage = usage;
    throw e;
  }
  logCompliance(ctx, { attempt: 2, kind, input, candidates, reason: 'retry produced empty/sentinel after a wrong-kind attempt', missing: true, leaked: [] });
  const e = new TapeHttpError(502, 'kind-compliance', 'Synthesizer output violated kind contract', `${kind}: retry failed to produce conformant output`);
  e.usage = usage;
  throw e;
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
            tickers: Array.isArray(prior.value.tickers) ? prior.value.tickers : [],
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
            sseSend(res, 'done', { kind, model: cachedBody.model, tokens: cachedBody.tokens, tickers: cachedBody.tickers, cached: true });
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

      // --- run synthesis (generate → validate kind contract → retry once → 502) ---
      const fetchedAt = new Date().toISOString();
      const complianceCtx = { sub: req.tape?.sub, model: modelConfig.id };

      // Stream attempt-1 tokens live (gating the `## TICKERS` block); on the
      // rare compliance-retry the corrected text arrives via the final `text`
      // event, which the client treats as authoritative.
      let onDelta;
      if (stream) {
        sseInit(res);
        sseSend(res, 'status', { message: 'Synthesizing…', kind });
        const sanitizer = createStreamSanitizer();
        const cut = createMarkerCut(TICKERS_HEADER_RE);
        onDelta = (d) => {
          const pre = cut.feed(d);
          if (pre) { const safe = sanitizer.feed(pre); if (safe) sseSend(res, 'text_delta', { text: safe }); }
        };
      }

      let r;
      try {
        r = await produce({ kind, input, candidates, modelConfig, validIds, onDelta, ctx: complianceCtx });
      } catch (e) {
        // Record tokens already spent across the failed attempts before bubbling.
        if (e && e.usage) await recordCost(e.usage, modelConfig, dayKey, ttlDay);
        throw e;
      }

      // Confidence tier (deterministic, all kinds). windowDays/windowExpanded
      // come from the Brief retrieval response if the client forwards them.
      const windowDays = input.windowDays ?? body.windowDays ?? null;
      const windowExpanded = input.windowExpanded ?? body.windowExpanded ?? false;
      const conf = assessConfidence({
        kind, candidates, finalText: r.finalText,
        synthesizedEmpty: r.synthesizedEmpty, emptyReason: r.reason,
        windowDays, windowExpanded,
      });

      const outBody = {
        kind, text: r.finalText, tickers: r.synthesizedEmpty ? [] : r.tickers,
        tokens: { input: r.usage.input_tokens, output: r.usage.output_tokens },
        model: modelConfig.id, elapsedMs: Date.now() - startedAt,
        _meta: {
          fetchedAt, forced: refresh,
          confidence: conf.confidence,
          confidenceReason: conf.confidenceReason,
          candidateCount: conf.candidateCount,
          ...(windowExpanded ? { windowDays, windowExpanded: true } : {}),
          ...(r.synthesizedEmpty ? { synthesizedEmpty: true, reason: r.reason } : {}),
          ...(r.recovered ? { complianceRecovered: true } : {}),
        },
      };
      outBody._meta = { ...outBody._meta, ...buildFreshnessMeta({ tier: TIER.QUALITATIVE, cached: false, cachedAt: fetchedAt, fetchedAt, ttlSec: ttl }) };
      // Don't cache empties — temperature>0 means a retry may yet produce content.
      if (!noCache && !r.synthesizedEmpty) await setCached(cacheKey, outBody, ttl);
      await recordCost(r.usage, modelConfig, dayKey, ttlDay);

      const logBase = { endpoint: 'synthesize', kind, jwt_sub: req.tape?.sub, cache: 'miss', forced: refresh, synthesizedEmpty: r.synthesizedEmpty, confidence: conf.confidence, complianceRecovered: !!r.recovered, attempts: r.attempts, tickers: outBody.tickers.length, tokens: outBody.tokens, model: modelConfig.id, cost_usd_est: costUsd(r.usage, modelConfig), status: 200, elapsed_ms: Date.now() - startedAt };

      if (stream) {
        sseSend(res, 'text', { text: r.finalText });
        sseSend(res, 'done', { kind, model: modelConfig.id, tokens: outBody.tokens, tickers: outBody.tickers, confidence: conf.confidence, confidenceReason: conf.confidenceReason, cached: false, forced: refresh, synthesizedEmpty: r.synthesizedEmpty });
        logTape(logBase);
        return res.end();
      }
      logTape(logBase);
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

module.exports = { createSynthesizeHandler, runSynthesis, produce, stripUnknownClipTokens };
