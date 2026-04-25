/**
 * DeepSeek direct API provider adapter (OpenAI-compatible chat completions).
 *
 * This talks to DeepSeek's first-party endpoint at api.deepseek.com — the
 * model is open-weight but this routing sends user query content directly to
 * DeepSeek (a Hangzhou-based company). Use registry entries with this provider
 * deliberately; the privacy positioning differs from Tinfoil-routed inference.
 *
 * For US-vendor routing of the same model, use the OpenRouter provider instead
 * (which forwards through Together / DeepInfra / Novita).
 */

const crypto = require('crypto');

const DEFAULT_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = parseInt(process.env.DEEPSEEK_REQUEST_TIMEOUT_MS || '90000', 10);

// Reasoning control: V4 family emits inline reasoning tokens (billed as
// completion tokens). Per DeepSeek's docs the API doesn't expose a switch to
// disable reasoning on V4 — it's part of the model. We expose the toggle
// surface for forward compatibility.
const DEFAULT_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || null;

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
      // V4 thinking mode requires reasoning_content from prior turns to be
      // echoed back; we stash it on a `thinking` content block at response time.
      const reasoningContent = msg.content
        .filter(b => b.type === 'thinking')
        .map(b => b.text)
        .join('\n\n') || undefined;
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
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
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

  // V4 thinking mode emits inline reasoning that must be echoed back on
  // subsequent turns. We surface it as a `thinking` content block so the
  // orchestrator preserves it in conversation history; convertMessagesToOpenAi
  // turns it back into reasoning_content for follow-up requests.
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
    content.push({ type: 'thinking', text: message.reasoning_content });
  }

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
      cached_input_tokens: payload?.usage?.prompt_cache_hit_tokens ?? null,
      reasoning_tokens: payload?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    },
  };
}

class DeepSeekProvider {
  constructor() {
    this.baseUrl = DEFAULT_BASE_URL.replace(/\/$/, '');
    this._validated = null;
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY || ''}`,
      'Content-Type': 'application/json',
    };
  }

  async validate() {
    if (this._validated !== null) return this._validated;
    if (!process.env.DEEPSEEK_API_KEY) {
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

    // Only attach tools/tool_choice when at least one tool is supplied. The
    // OpenAI spec rejects an empty tools array with tool_choice: 'auto', and
    // omitting both fields is also how the orchestrator forces a tool-less
    // synthesis call after a hard cap exit.
    const convertedTools = convertToolsToOpenAi(tools);
    if (convertedTools.length > 0) {
      payload.tools = convertedTools;
      payload.tool_choice = 'auto';
    }

    if (DEFAULT_REASONING_EFFORT) {
      payload.reasoning_effort = DEFAULT_REASONING_EFFORT;
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
        throw new Error(`DeepSeek request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms (${requestId || 'no-req-id'})`);
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`DeepSeek request failed (${resp.status}) after ${Date.now() - started}ms: ${body.substring(0, 300)}`);
    }

    const data = await resp.json();
    return normalizeOpenAiResponse(data);
  }
}

module.exports = DeepSeekProvider;
