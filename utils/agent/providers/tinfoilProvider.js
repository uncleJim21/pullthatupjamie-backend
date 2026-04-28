const crypto = require('crypto');

const DEFAULT_TINFOIL_BASE_URL = process.env.TINFOIL_BASE_URL || 'https://inference.tinfoil.sh/v1';
const CHAT_PATH_CANDIDATES = [
  process.env.TINFOIL_CHAT_COMPLETIONS_PATH,
  '/chat/completions',
  '/chat/completion',
].filter(Boolean);
const DEFAULT_REQUEST_TIMEOUT_MS = parseInt(process.env.TINFOIL_REQUEST_TIMEOUT_MS || '90000', 10);

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
    // Handle multimodal-style content arrays when providers return them.
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
    },
  };
}

class TinfoilProvider {
  constructor() {
    this.baseUrl = DEFAULT_TINFOIL_BASE_URL.replace(/\/$/, '');
    this._validated = null;
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${process.env.TINFOIL_API_KEY || ''}`,
      'Content-Type': 'application/json',
    };
  }

  async validate() {
    if (this._validated !== null) return this._validated;
    if (!process.env.TINFOIL_API_KEY) {
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

  async createResponse({ model, maxTokens, system, messages, tools, toolChoice, requestId }) {
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

    // See docs/AGENT_SYNTHESIS_PASS.md for the rationale behind toolChoice:
    //   • toolChoice === 'none' (synthesis pass): force `tool_choice: 'none'`
    //     and keep the tool schemas attached so the model stays anchored to
    //     the same tool-aware context it saw during the main loop.
    //   • Otherwise: only attach tools+'auto' when at least one tool is
    //     supplied (empty tools + 'auto' is rejected by the OpenAI spec).
    const convertedTools = convertToolsToOpenAi(tools);
    if (toolChoice === 'none') {
      payload.tool_choice = 'none';
      if (convertedTools.length > 0) payload.tools = convertedTools;
    } else if (convertedTools.length > 0) {
      payload.tools = convertedTools;
      payload.tool_choice = 'auto';
    }

    let lastError = null;
    for (const path of CHAT_PATH_CANDIDATES) {
      const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
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
          throw new Error(`Tinfoil request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms (${requestId || 'no-req-id'}) at ${path}`);
        }
        throw err;
      }
      clearTimeout(timeout);

      if (!resp.ok) {
        const body = await resp.text();
        lastError = `Tinfoil request failed at ${path} (${resp.status}) after ${Date.now() - started}ms: ${body.substring(0, 200)}`;
        if (resp.status === 404) continue;
        throw new Error(lastError);
      }

      const data = await resp.json();
      return normalizeOpenAiResponse(data);
    }

    throw new Error(lastError || 'Tinfoil request failed: no valid chat completion endpoint found');
  }
}

module.exports = TinfoilProvider;
