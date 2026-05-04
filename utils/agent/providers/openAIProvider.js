/**
 * Direct OpenAI provider adapter (OpenAI chat completions).
 *
 * Uses OPENAI_API_KEY directly — no intermediary broker. Supports streaming
 * via the SSE-based chunk protocol and honors the same onTextDelta / aborted /
 * timeoutMs interface as the other providers so the agent loop is agnostic.
 */

const crypto = require('crypto');

const DEFAULT_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = parseInt(process.env.OPENAI_REQUEST_TIMEOUT_MS || '90000', 10);

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
      .filter(p => p?.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n');
    if (text.trim()) content.push({ type: 'text', text });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let parsedInput = {};
      try { parsedInput = JSON.parse(tc.function?.arguments || '{}'); } catch {}
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
      provider_reported_cost_usd: null,
      reasoning_tokens: payload?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    },
  };
}

async function parseOpenAiStream(resp, onTextDelta, aborted) {
  const decoder = new TextDecoder();
  let sseBuffer = '';

  let fullText = '';
  const toolCallAccumulator = {};
  let finishReason = null;
  let usage = null;

  try {
    for await (const rawChunk of resp.body) {
      if (aborted && aborted()) break;

      sseBuffer += decoder.decode(rawChunk, { stream: true });
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop();

      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;

          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }

          if (parsed?.usage) usage = parsed.usage;

          const choice = parsed?.choices?.[0];
          if (!choice) continue;

          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta || {};

          if (typeof delta.content === 'string' && delta.content) {
            fullText += delta.content;
            if (typeof onTextDelta === 'function') onTextDelta(delta.content);
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallAccumulator[idx]) {
                toolCallAccumulator[idx] = { id: '', name: '', arguments: '' };
              }
              if (tc.id) toolCallAccumulator[idx].id += tc.id;
              if (tc.function?.name) toolCallAccumulator[idx].name += tc.function.name;
              if (tc.function?.arguments) toolCallAccumulator[idx].arguments += tc.function.arguments;
            }
          }
        }
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') throw err;
  }

  const content = [];
  if (fullText.trim()) content.push({ type: 'text', text: fullText });

  for (const tc of Object.values(toolCallAccumulator)) {
    let parsedInput = {};
    try { parsedInput = JSON.parse(tc.arguments || '{}'); } catch {}
    content.push({
      type: 'tool_use',
      id: tc.id || `tool_${crypto.randomUUID()}`,
      name: tc.name,
      input: parsedInput,
    });
  }

  const hasToolUse = content.some(c => c.type === 'tool_use');
  const stopReason = hasToolUse ? 'tool_use' : (finishReason || 'end_turn');

  return {
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
      provider_reported_cost_usd: null,
      reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    },
  };
}

class OpenAIProvider {
  constructor() {
    this.baseUrl = DEFAULT_BASE_URL.replace(/\/$/, '');
    this._validated = null;
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
      'Content-Type': 'application/json',
    };
  }

  async validate() {
    if (this._validated !== null) return this._validated;
    this._validated = !!process.env.OPENAI_API_KEY;
    return this._validated;
  }

  async createResponse({ model, maxTokens, system, messages, tools, toolChoice, onTextDelta, aborted, timeoutMs, reasoningEffort, requestId }) {
    const openAiMessages = [
      { role: 'system', content: system },
      ...convertMessagesToOpenAi(messages),
    ];

    const useStreaming = typeof onTextDelta === 'function';
    const payload = {
      model,
      messages: openAiMessages,
      max_completion_tokens: maxTokens,
      stream: useStreaming,
      ...(useStreaming ? { stream_options: { include_usage: true } } : {}),
      // reasoning_effort caps internal chain-of-thought tokens, preventing the
      // model from consuming the entire token budget on reasoning before writing
      // any visible output. 'low' is fast and sufficient for synthesis tasks.
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    };

    const convertedTools = convertToolsToOpenAi(tools);
    if (toolChoice === 'none') {
      payload.tool_choice = 'none';
      if (convertedTools.length > 0) payload.tools = convertedTools;
    } else if (convertedTools.length > 0) {
      payload.tools = convertedTools;
      payload.tool_choice = 'auto';
    }

    const url = `${this.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const effectiveTimeout = timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    const started = Date.now();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeout);

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
        throw new Error(`OpenAI request timed out after ${effectiveTimeout}ms (${requestId || 'no-req-id'})`);
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenAI request failed (${resp.status}) after ${Date.now() - started}ms: ${body.substring(0, 300)}`);
    }

    if (!useStreaming) {
      const data = await resp.json();
      return normalizeOpenAiResponse(data);
    }

    return parseOpenAiStream(resp, onTextDelta, aborted);
  }
}

module.exports = OpenAIProvider;
