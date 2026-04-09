const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { printLog } = require('../constants.js');
const { SYSTEM_PROMPT, TOOL_DEFINITIONS } = require('../setup-agent');

const GATEWAY_URL = process.env.AGENT_GATEWAY_URL || 'http://localhost:3456';
const GATEWAY_KEY = process.env.AGENT_GATEWAY_KEY || 'jamie_agent_poc_key';
const MAX_TOOL_ROUNDS = 10;

const AGENT_MODELS = {
  fast:    { id: 'claude-haiku-4-5-20251001', inputPer1M: 1.00, outputPer1M: 5.00, label: 'Haiku 4.5' },
  quality: { id: 'claude-sonnet-4-6',         inputPer1M: 3.00, outputPer1M: 15.00, label: 'Sonnet 4.6' },
};
const DEFAULT_AGENT_MODEL = 'fast';

let anthropic;
let anthropicKeyValid = false;

// Validate API key at startup via read-only /v1/models endpoint (zero tokens)
(async () => {
  try {
    anthropic = new Anthropic();
    const resp = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
    });
    if (resp.ok) {
      anthropicKeyValid = true;
      console.log('\x1b[32m%s\x1b[0m', '[AGENT] ✔ Anthropic API key validated successfully');
    } else {
      const body = await resp.text();
      console.log('\x1b[31m%s\x1b[0m', `[AGENT] ✘ Anthropic API key invalid (${resp.status}). /api/chat/agent will not work.`);
      printLog(`[AGENT] Detail: ${body.substring(0, 200)}`);
    }
  } catch (err) {
    console.log('\x1b[33m%s\x1b[0m', `[AGENT] ⚠ Could not reach Anthropic API: ${err.message}. /api/chat/agent may not work.`);
  }
})();

// Map tool names to gateway endpoints
const TOOL_ENDPOINT_MAP = {
  search_quotes:        '/api/search-quotes',
  search_chapters:      '/api/search-chapters',
  discover_podcasts:    '/api/discover-podcasts',
  find_person:          '/api/find-person',
  get_person_episodes:  '/api/get-person-episodes',
};

async function callToolViaGateway(toolName, toolInput, sessionId) {
  const endpoint = TOOL_ENDPOINT_MAP[toolName];
  if (!endpoint) {
    return { error: `Unknown tool: ${toolName}` };
  }

  const resp = await fetch(`${GATEWAY_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_KEY}`,
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify(toolInput),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { error: `Gateway ${resp.status}: ${text}` };
  }
  return resp.json();
}

function createAgentChatRoutes() {
  const router = express.Router();

  /**
   * POST /agent
   * Send a message to the Claude-powered agent. Streams SSE back.
   *
   * Body: { message: string, sessionId?: string, model?: "fast"|"quality" }
   */
  router.post('/agent', async (req, res) => {
    const { message } = req.body;
    const modelKey = (req.body.model === 'quality') ? 'quality' : DEFAULT_AGENT_MODEL;
    const modelConfig = AGENT_MODELS[modelKey];
    const sessionId = req.body.sessionId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestId = `AGENT-${sessionId.slice(-8)}`;
    const startTime = Date.now();

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    if (!anthropicKeyValid) {
      return res.status(503).json({ error: 'Anthropic API key is not configured or invalid. Check ANTHROPIC_API_KEY in .env' });
    }

    printLog(`[${requestId}] POST /api/chat/agent — model=${modelConfig.label}, "${message.substring(0, 100)}"`);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const emit = (eventType, data) => {
      try {
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (e) { /* client disconnected */ }
    };

    let aborted = false;
    res.on('close', () => { aborted = true; });

    try {
      emit('status', { message: 'Analyzing your request...', sessionId });

      const messages = [{ role: 'user', content: message }];
      let toolCalls = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let round = 0;

      // Claude tool-use loop
      while (round < MAX_TOOL_ROUNDS && !aborted) {
        round++;
        console.log(`[${requestId}] === ROUND ${round} START === (aborted=${aborted})`);

        console.log(`[${requestId}] Calling Claude API (model=${modelConfig.id}, messages=${messages.length})...`);
        const response = await anthropic.messages.create({
          model: modelConfig.id,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages,
          tools: TOOL_DEFINITIONS,
        });

        console.log(`[${requestId}] Claude response: stop_reason="${response.stop_reason}", content_blocks=${response.content.length}, types=[${response.content.map(b => b.type).join(',')}]`);
        console.log(`[${requestId}] Tokens this round: input=${response.usage?.input_tokens}, output=${response.usage?.output_tokens}`);

        totalInputTokens  += response.usage?.input_tokens || 0;
        totalOutputTokens += response.usage?.output_tokens || 0;

        // Process response content blocks
        const assistantContent = response.content;
        messages.push({ role: 'assistant', content: assistantContent });

        // Emit any text blocks
        for (const block of assistantContent) {
          if (block.type === 'text') {
            console.log(`[${requestId}] Emitting text block (${block.text.length} chars): "${block.text.substring(0, 120)}..."`);
            emit('text', { text: block.text });
          }
        }

        // If Claude is done (no tool use), break
        if (response.stop_reason !== 'tool_use') {
          console.log(`[${requestId}] stop_reason="${response.stop_reason}" — breaking loop`);
          break;
        }

        // Execute tool calls
        const toolUseBlocks = assistantContent.filter(b => b.type === 'tool_use');
        console.log(`[${requestId}] ${toolUseBlocks.length} tool_use blocks to execute`);
        const toolResults = [];

        for (const toolUse of toolUseBlocks) {
          const toolStart = Date.now();
          console.log(`[${requestId}] Executing tool: ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 150)})`);

          emit('tool_call', {
            tool: toolUse.name,
            input: toolUse.input,
            round,
          });

          const result = await callToolViaGateway(toolUse.name, toolUse.input, sessionId);
          const toolLatency = Date.now() - toolStart;

          const resultCount = result.results?.length
            || result.episodes?.length
            || result.people?.length
            || result.chapters?.length
            || 0;

          const resultSize = JSON.stringify(result).length;
          console.log(`[${requestId}] Tool ${toolUse.name}: ${resultCount} results, ${resultSize} chars JSON, ${toolLatency}ms`);

          emit('tool_result', {
            tool: toolUse.name,
            resultCount,
            latencyMs: toolLatency,
            round,
          });

          toolCalls.push({
            name: toolUse.name,
            input: toolUse.input,
            resultCount,
            latencyMs: toolLatency,
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        }

        console.log(`[${requestId}] Pushing ${toolResults.length} tool results to messages. Total messages now: ${messages.length + 1}`);
        messages.push({ role: 'user', content: toolResults });
        console.log(`[${requestId}] === ROUND ${round} END === looping back (aborted=${aborted})`);
      }
      console.log(`[${requestId}] === LOOP EXITED === round=${round}, aborted=${aborted}`);

      const latencyMs = Date.now() - startTime;

      const claudeCost = (totalInputTokens * modelConfig.inputPer1M / 1_000_000) + (totalOutputTokens * modelConfig.outputPer1M / 1_000_000);
      const gatewayCost = toolCalls.reduce((sum, tc) => {
        const costs = { search_quotes: 0.004, search_chapters: 0.004, discover_podcasts: 0.005, find_person: 0.001, get_person_episodes: 0.001 };
        return sum + (costs[tc.name] || 0);
      }, 0);

      printLog(`[${requestId}] Complete: ${round} rounds, ${toolCalls.length} tool calls, ${totalInputTokens}+${totalOutputTokens} tokens, $${claudeCost.toFixed(4)} LLM, ${latencyMs}ms`);

      emit('done', {
        sessionId,
        model: modelConfig.label,
        rounds: round,
        toolCalls: toolCalls.map(tc => ({ name: tc.name, resultCount: tc.resultCount, latencyMs: tc.latencyMs })),
        tokens: { input: totalInputTokens, output: totalOutputTokens },
        cost: {
          claude: parseFloat(claudeCost.toFixed(6)),
          gateway: parseFloat(gatewayCost.toFixed(4)),
          total: parseFloat((claudeCost + gatewayCost).toFixed(6)),
        },
        latencyMs,
      });

      res.end();

    } catch (error) {
      printLog(`[${requestId}] ERROR: ${error.message}`);
      console.error(`[${requestId}] Stack:`, error.stack);
      emit('error', { error: error.message });
      res.end();
    }
  });

  return router;
}

module.exports = createAgentChatRoutes;
