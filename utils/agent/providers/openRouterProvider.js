/**
 * OpenRouter provider adapter (OpenAI-compatible chat completions).
 *
 * OpenRouter is a routing broker — it forwards requests to upstream providers
 * (Novita, Fireworks, DeepInfra, etc.) and passes pricing through. We use it
 * here as a way to access models like DeepSeek V4 that aren't yet hosted on
 * Tinfoil.
 *
 * Tradeoff vs Tinfoil: cheaper / earlier access to new models, but no
 * confidential-enclave guarantees — every request is plaintext-visible to
 * OpenRouter and the upstream provider it routes to. If the same model
 * eventually lands on Tinfoil, register it there as a separate model entry
 * (e.g. `deepseek-v4-flash-tinfoil`) so callers can pick the routing they want.
 */

const crypto = require('crypto');

const DEFAULT_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = parseInt(process.env.OPENROUTER_REQUEST_TIMEOUT_MS || '90000', 10);
const DEFAULT_REFERER = process.env.OPENROUTER_HTTP_REFERER || 'https://pullthatupjamie.ai';
const DEFAULT_TITLE = process.env.OPENROUTER_X_TITLE || 'PullThatUpJamie';

// Reasoning control for models that support inline reasoning (DeepSeek V4, etc.).
// `exclude` drops the reasoning tokens from the response payload (we still pay for them).
// Effort values supported by OpenRouter: 'low' | 'medium' | 'high'.
const DEFAULT_REASONING_EFFORT = process.env.OPENROUTER_REASONING_EFFORT || null;
const DEFAULT_REASONING_EXCLUDE = process.env.OPENROUTER_REASONING_EXCLUDE === 'true';

// Upstream provider routing — OpenRouter brokers to multiple hosts (Together,
// DeepInfra, Novita, etc.). Tool-call support varies by upstream and changes
// over time; the public `supports_tool_parameter` flag is often wrong.
// Empirical (2026-04 on DeepSeek V4 family):
//   - Together hosts V4-Pro and accepts tools (404s for V4-Flash since it
//     doesn't host that model — order naturally falls through).
//   - DeepInfra hosts V4-Flash and tries tools but is chronically pool-limited.
//   - Novita hosts V4-Flash but rejects tool requests.
// Comma-separated env list controls preference; set OPENROUTER_PROVIDER_ONLY=true
// to *only* use those hosts (no fallback chain).
const PROVIDER_ORDER = (process.env.OPENROUTER_PROVIDER_ORDER || 'Together,DeepInfra,Novita,SiliconFlow')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const PROVIDER_ONLY = process.env.OPENROUTER_PROVIDER_ONLY === 'true';

function convertToolsToOpenAi(tools = []) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function convertMessagesToOpenAi(messages = []) {
  const out = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    if (msg.role === 'assistant') {
      const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
      const toolCalls = msg.content
        .filter(b => b.type === 'tool_use')
        .map((b, idx) => ({
          id: b.id || `call_${idx + 1}`,
          type: 'function',
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input || {}),
          },
        }));

      out.push({
        role: 'assistant',
        content: textParts || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (msg.role === 'user') {
      const toolResults = msg.content.filter(b => b.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          out.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || {}),
          });
        }
      }
    }
  }

  return out;
}

function normalizeOpenAiResponse(payload) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (typeof message.content === 'string' && message.content.trim()) {
    content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    const text = message.content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
    if (text.trim()) content.push({ type: 'text', text });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let parsedInput = {};
      try {
        parsedInput = JSON.parse(tc.function?.arguments || '{}');
      } catch {}
      content.push({
        type: 'tool_use',
        id: tc.id || `tool_${crypto.randomUUID()}`,
        name: tc.function?.name,
        input: parsedInput,
      });
    }
  }

  const stopReason = content.some(c => c.type === 'tool_use')
    ? 'tool_use'
    : (choice.finish_reason || 'end_turn');

  return {
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: payload?.usage?.prompt_tokens || 0,
      output_tokens: payload?.usage?.completion_tokens || 0,
      // OpenRouter returns actual upstream cost in USD when available.
      // We expose it for diagnostics; the route still recomputes from the rate card.
      provider_reported_cost_usd: payload?.usage?.cost ?? null,
      reasoning_tokens: payload?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    },
  };
}

class OpenRouterProvider {
  constructor() {
    this.baseUrl = DEFAULT_BASE_URL.replace(/\/$/, '');
    this._validated = null;
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY || ''}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': DEFAULT_REFERER,
      'X-Title': DEFAULT_TITLE,
    };
  }

  async validate() {
    if (this._validated !== null) return this._validated;
    if (!process.env.OPENROUTER_API_KEY) {
      this._validated = false;
      return this._validated;
    }

    try {
      const resp = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.authHeaders(),
      });
      this._validated = resp.ok;
    } catch {
      this._validated = false;
    }
    return this._validated;
  }

  async createResponse({ model, maxTokens, system, messages, tools, requestId }) {
    const openAiMessages = [
      { role: 'system', content: system },
      ...convertMessagesToOpenAi(messages),
    ];

    const payload = {
      model,
      messages: openAiMessages,
      max_tokens: maxTokens,
      stream: false,
    };

    // Only attach tools/tool_choice when at least one tool is supplied — empty
    // tools + tool_choice: 'auto' is rejected by upstream providers, and the
    // orchestrator relies on this to issue tool-less synthesis calls after a
    // hard cap exit.
    const convertedTools = convertToolsToOpenAi(tools);
    if (convertedTools.length > 0) {
      payload.tools = convertedTools;
      payload.tool_choice = 'auto';
    }

    if (DEFAULT_REASONING_EFFORT || DEFAULT_REASONING_EXCLUDE) {
      payload.reasoning = {};
      if (DEFAULT_REASONING_EFFORT) payload.reasoning.effort = DEFAULT_REASONING_EFFORT;
      if (DEFAULT_REASONING_EXCLUDE) payload.reasoning.exclude = true;
    }

    if (PROVIDER_ORDER.length > 0) {
      payload.provider = PROVIDER_ONLY
        ? { only: PROVIDER_ORDER }
        : { order: PROVIDER_ORDER, allow_fallbacks: true };
    }

    const url = `${this.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const started = Date.now();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err?.name === 'AbortError') {
        throw new Error(`OpenRouter request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms (${requestId || 'no-req-id'})`);
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenRouter request failed (${resp.status}) after ${Date.now() - started}ms: ${body.substring(0, 300)}`);
    }

    const data = await resp.json();
    return normalizeOpenAiResponse(data);
  }
}

module.exports = OpenRouterProvider;
