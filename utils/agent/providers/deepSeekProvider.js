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

  async createResponse({ model, maxTokens, system, messages, tools, toolChoice, onTextDelta, aborted, requestId, timeoutMs }) {
    const openAiMessages = [
      { role: 'system', content: system },
      ...convertMessagesToOpenAi(messages),
    ];

    const payload = {
      model,
      messages: openAiMessages,
      max_tokens: maxTokens,
      stream: true,
      // include_usage tells DeepSeek (and any OpenAI-compatible upstream) to
      // emit a final chunk with prompt/completion token counts. Without it,
      // the streaming response has no usage info and our cost tracker undercounts.
      stream_options: { include_usage: true },
    };

    // Tool advertising rules:
    //   • Default (toolChoice undefined): attach tools+`tool_choice: 'auto'`
    //     only when at least one tool is supplied. Empty tools + 'auto' is
    //     rejected by the OpenAI spec.
    //   • toolChoice === 'none' (synthesis pass): attach `tool_choice: 'none'`
    //     AND include the tool schemas if available. DeepSeek's documented
    //     behavior is that 'none' explicitly forbids invocation but still
    //     anchors the model to the same world it saw in earlier rounds —
    //     critical to prevent it from inlining its native DSML tool-call
    //     markup as a fallback when tools vanish from the request shape.
    //     See docs/AGENT_SYNTHESIS_PASS.md.
    const convertedTools = convertToolsToOpenAi(tools);
    if (toolChoice === 'none') {
      payload.tool_choice = 'none';
      if (convertedTools.length > 0) payload.tools = convertedTools;
    } else if (convertedTools.length > 0) {
      payload.tools = convertedTools;
      payload.tool_choice = 'auto';
    }

    if (DEFAULT_REASONING_EFFORT) {
      payload.reasoning_effort = DEFAULT_REASONING_EFFORT;
    }

    const safeOnTextDelta = typeof onTextDelta === 'function' ? onTextDelta : () => {};
    const safeAborted = typeof aborted === 'function' ? aborted : () => false;

    const effectiveTimeoutMs = (Number.isFinite(timeoutMs) && timeoutMs > 0)
      ? Math.floor(timeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;

    const url = `${this.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const started = Date.now();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { ...this.authHeaders(), Accept: 'text/event-stream' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err?.name === 'AbortError') {
        throw new Error(`DeepSeek request timed out after ${effectiveTimeoutMs}ms (${requestId || 'no-req-id'})`);
      }
      throw err;
    }

    if (!resp.ok) {
      clearTimeout(timeout);
      const body = await resp.text();
      throw new Error(`DeepSeek request failed (${resp.status}) after ${Date.now() - started}ms: ${body.substring(0, 300)}`);
    }

    // SSE consumption. DeepSeek's chat completions stream is OpenAI-compatible:
    //   data: {...delta...}\n\n
    //   data: {...delta...}\n\n
    //   data: [DONE]\n\n
    // Each delta carries one or more of: content (text), reasoning_content
    // (V4 thinking-mode tokens), tool_calls (incremental, indexed). The final
    // chunk before [DONE] carries the usage object when stream_options.include_usage
    // is set. We reconstruct the same {content, stop_reason, usage} shape the
    // orchestrator expects from the non-streaming path.
    const decoder = new TextDecoder();
    let buffer = '';
    let textParts = '';
    let reasoningParts = '';
    const toolCallsByIndex = new Map();
    let finishReason = null;
    let usage = null;

    try {
      for await (const chunk of resp.body) {
        if (safeAborted()) {
          // Pull the plug — controller.abort() will surface as an AbortError
          // upstream which we swallow at the loop boundary.
          controller.abort();
          break;
        }
        buffer += decoder.decode(chunk, { stream: true });

        let nlIdx;
        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line) continue;
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]' || data.length === 0) continue;

          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            // Partial / malformed chunk — skip; the next chunk will likely
            // round it out via the buffered split above.
            continue;
          }

          const choice = parsed.choices?.[0];
          if (choice) {
            const delta = choice.delta || {};
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              textParts += delta.content;
              if (!safeAborted()) safeOnTextDelta(delta.content);
            }
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
              reasoningParts += delta.reasoning_content;
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                if (!toolCallsByIndex.has(idx)) {
                  toolCallsByIndex.set(idx, {
                    id: tc.id || `tool_${crypto.randomUUID()}`,
                    type: tc.type || 'function',
                    function: { name: '', arguments: '' },
                  });
                }
                const acc = toolCallsByIndex.get(idx);
                if (tc.id && acc.id.startsWith('tool_')) acc.id = tc.id;
                if (tc.type) acc.type = tc.type;
                if (typeof tc.function?.name === 'string') acc.function.name += tc.function.name;
                if (typeof tc.function?.arguments === 'string') acc.function.arguments += tc.function.arguments;
              }
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
          if (parsed.usage) usage = parsed.usage;
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    const content = [];
    if (reasoningParts.trim()) content.push({ type: 'thinking', text: reasoningParts });
    if (textParts.trim()) content.push({ type: 'text', text: textParts });
    for (const tc of toolCallsByIndex.values()) {
      let parsedInput = {};
      try { parsedInput = JSON.parse(tc.function.arguments || '{}'); } catch {}
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      });
    }

    const stopReason = content.some(c => c.type === 'tool_use')
      ? 'tool_use'
      : (finishReason || 'end_turn');

    return {
      content,
      stop_reason: stopReason,
      usage: {
        input_tokens: usage?.prompt_tokens || 0,
        output_tokens: usage?.completion_tokens || 0,
        cached_input_tokens: usage?.prompt_cache_hit_tokens ?? null,
        reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
      },
    };
  }
}

module.exports = DeepSeekProvider;
