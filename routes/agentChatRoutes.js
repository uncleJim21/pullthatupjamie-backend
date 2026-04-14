const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { printLog } = require('../constants.js');
const { SYSTEM_PROMPT, TOOL_DEFINITIONS } = require('../setup-agent');
const { executeAgentTool, TOOL_COSTS } = require('../utils/agentToolHandler');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

const AGENT_LOG_DIR = path.join(__dirname, '..', 'logs', 'agent');
try { fs.mkdirSync(AGENT_LOG_DIR, { recursive: true }); } catch {}

function writeAgentLog(requestId, sessionId, logData) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${ts}_${requestId}.json`;
    fs.writeFileSync(
      path.join(AGENT_LOG_DIR, filename),
      JSON.stringify(logData, null, 2),
    );
  } catch (err) {
    printLog(`[AGENT-LOG] Failed to write log: ${err.message}`);
  }
}

const MAX_TOOL_ROUNDS = 10;
const TOKEN_BUDGET_SOFT = 12000;
const MAX_HISTORY_MESSAGES = 4; // 2 prior turns (user + assistant each)

// --- Dynamic feed lookup table ---
let feedLookupTable = null;
let feedLookupPromptSection = '';

async function buildFeedLookup() {
  if (feedLookupTable) return;
  try {
    const feeds = await JamieVectorMetadata.find({ type: 'feed' })
      .select('feedId metadataRaw.title')
      .sort({ 'metadataRaw.title': 1 })
      .lean();

    feedLookupTable = {};
    const lines = [];
    for (const f of feeds) {
      const title = f.metadataRaw?.title || 'Unknown';
      const fid = String(f.feedId);
      feedLookupTable[title.toLowerCase()] = fid;
      lines.push(`${fid}: ${title}`);
    }
    feedLookupPromptSection = `\n\n## Feed ID Lookup\n\nWhen filtering search_quotes by feedIds, you MUST use numeric feed IDs — not show names or URLs. Here is the complete list:\n\n${lines.join('\n')}\n\nIf the user mentions a show name, look it up here. When a person IS a host (e.g. Joe Rogan → The Joe Rogan Experience), use their show's feedId directly with search_quotes instead of find_person.`;
    printLog(`[AGENT] Feed lookup table built: ${feeds.length} feeds`);
  } catch (err) {
    printLog(`[AGENT] Feed lookup build failed (non-fatal): ${err.message}`);
    feedLookupPromptSection = '';
  }
}

const AGENT_MODELS = {
  fast:    { id: 'claude-haiku-4-5-20251001', inputPer1M: 1.00, outputPer1M: 5.00, label: 'Haiku 4.5' },
  quality: { id: 'claude-sonnet-4-6',         inputPer1M: 3.00, outputPer1M: 15.00, label: 'Sonnet 4.6' },
};
const DEFAULT_AGENT_MODEL = 'fast';

let anthropic;
let anthropicKeyValid = false;

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
      console.log('\x1b[31m%s\x1b[0m', `[AGENT] ✘ Anthropic API key invalid (${resp.status}). Agent routes will not work.`);
      printLog(`[AGENT] Detail: ${body.substring(0, 200)}`);
    }
  } catch (err) {
    console.log('\x1b[33m%s\x1b[0m', `[AGENT] ⚠ Could not reach Anthropic API: ${err.message}. Agent routes may not work.`);
  }
})();

function handleSuggestAction(toolInput, emit) {
  const { type, reason, ...params } = toolInput;
  emit('suggested_action', { type, reason, ...params });
  return { acknowledged: true, message: `Action "${type}" suggested to user. Continue your response — the user will decide whether to approve.` };
}

/**
 * Consume a streaming Claude response, emitting text_delta SSE events for
 * final (non-tool-use) rounds. Returns a shape compatible with the
 * non-streaming messages.create() response.
 */
async function consumeStream(stream, { emit, aborted, requestId }) {
  const contentBlocks = [];
  let stopReason = null;
  let inputTokens = 0;
  let outputTokens = 0;

  let currentBlockType = null;
  let currentBlockText = '';
  let currentToolInput = '';
  let currentToolId = '';
  let currentToolName = '';
  let hasToolUse = false;

  for await (const event of stream) {
    if (aborted()) break;

    switch (event.type) {
      case 'message_start':
        inputTokens = event.message?.usage?.input_tokens || 0;
        break;

      case 'content_block_start':
        currentBlockType = event.content_block.type;
        currentBlockText = '';
        currentToolInput = '';
        if (currentBlockType === 'tool_use') {
          hasToolUse = true;
          currentToolId = event.content_block.id;
          currentToolName = event.content_block.name;
        }
        break;

      case 'content_block_delta':
        if (event.delta.type === 'text_delta') {
          currentBlockText += event.delta.text;
          if (!hasToolUse && !aborted()) {
            emit('text_delta', { text: event.delta.text });
          }
        } else if (event.delta.type === 'input_json_delta') {
          currentToolInput += event.delta.partial_json;
        }
        break;

      case 'content_block_stop':
        if (currentBlockType === 'text') {
          contentBlocks.push({ type: 'text', text: currentBlockText });
        } else if (currentBlockType === 'tool_use') {
          let parsedInput = {};
          try { parsedInput = JSON.parse(currentToolInput); } catch { /* empty input */ }
          contentBlocks.push({
            type: 'tool_use',
            id: currentToolId,
            name: currentToolName,
            input: parsedInput,
          });
        }
        currentBlockType = null;
        break;

      case 'message_delta':
        stopReason = event.delta?.stop_reason || stopReason;
        outputTokens = event.usage?.output_tokens || outputTokens;
        break;
    }
  }

  return {
    content: contentBlocks,
    stop_reason: stopReason,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

/**
 * @param {object} deps
 * @param {object} deps.openai - OpenAI client (for clip reranker)
 */
function createAgentChatRoutes({ openai } = {}) {
  const router = express.Router();

  async function handleAgentChat(req, res) {
    const message = req.body.message || req.body.task;
    const modelKey = (req.body.model === 'quality') ? 'quality' : DEFAULT_AGENT_MODEL;
    const modelConfig = AGENT_MODELS[modelKey];
    const sessionId = req.body.sessionId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestId = `AGENT-${sessionId.slice(-8)}`;
    const startTime = Date.now();

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message (or task) is required' });
    }

    if (!anthropicKeyValid) {
      return res.status(503).json({ error: 'Anthropic API key is not configured or invalid. Check ANTHROPIC_API_KEY in .env' });
    }

    const rawHistory = req.body.history || [];
    const history = Array.isArray(rawHistory)
      ? rawHistory
          .filter(m => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role))
          .slice(-MAX_HISTORY_MESSAGES)
      : [];

    printLog(`[${requestId}] POST ${req.path} — model=${modelConfig.label}, history=${history.length}, "${message.substring(0, 100)}"`);

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

    let _aborted = false;
    res.on('close', () => { _aborted = true; });
    const aborted = () => _aborted;

    try {
      await buildFeedLookup();
      emit('status', { message: 'Analyzing your request...', sessionId });

      const effectiveSystemPrompt = SYSTEM_PROMPT + feedLookupPromptSection;

      const messages = [...history, { role: 'user', content: message }];
      let toolCalls = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let round = 0;
      let hasExecutedTools = false;
      const agentLog = {
        requestId, sessionId, model: modelConfig.label,
        query: message, startedAt: new Date().toISOString(),
        rounds: [],
        finalText: null, error: null,
      };

      while (round < MAX_TOOL_ROUNDS && !_aborted) {
        round++;
        console.log(`[${requestId}] === ROUND ${round} START ===`);

        if (hasExecutedTools) {
          emit('status', { message: 'Composing your answer...', sessionId });
        }

        console.log(`[${requestId}] Calling Claude API streaming (model=${modelConfig.id}, messages=${messages.length})...`);
        const stream = await anthropic.messages.create({
          model: modelConfig.id,
          max_tokens: 4096,
          system: effectiveSystemPrompt,
          messages,
          tools: TOOL_DEFINITIONS,
          stream: true,
        });

        const response = await consumeStream(stream, { emit, aborted, requestId });

        console.log(`[${requestId}] Claude response: stop_reason="${response.stop_reason}", content_blocks=${response.content.length}, types=[${response.content.map(b => b.type).join(',')}]`);
        console.log(`[${requestId}] Tokens this round: input=${response.usage?.input_tokens}, output=${response.usage?.output_tokens}`);

        totalInputTokens  += response.usage?.input_tokens || 0;
        totalOutputTokens += response.usage?.output_tokens || 0;

        const assistantContent = response.content;
        messages.push({ role: 'assistant', content: assistantContent });

        const isFinalResponse = response.stop_reason !== 'tool_use';

        if (isFinalResponse) {
          const fullText = assistantContent
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');
          console.log(`[${requestId}] Final text streamed (${fullText.length} chars)`);
          agentLog.rounds.push({ round, type: 'final', tokens: response.usage });
          agentLog.finalText = fullText;
          emit('text_done', { text: fullText });
          break;
        }

        // Suppress any intermediate text that was streamed (shouldn't happen with our prompt)
        const intermediateText = assistantContent.filter(b => b.type === 'text').map(b => b.text).join('');
        if (intermediateText.length > 0) {
          console.log(`[${requestId}] Intermediate text suppressed (${intermediateText.length} chars): "${intermediateText.substring(0, 80)}..."`);
        }

        const toolUseBlocks = assistantContent.filter(b => b.type === 'tool_use');
        console.log(`[${requestId}] ${toolUseBlocks.length} tool_use blocks to execute`);
        hasExecutedTools = true;
        const toolResults = [];

        for (const toolUse of toolUseBlocks) {
          const toolStart = Date.now();
          console.log(`[${requestId}] Executing tool: ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 150)})`);

          emit('tool_call', {
            tool: toolUse.name,
            input: toolUse.input,
            round,
          });

          const result = toolUse.name === 'suggest_action'
            ? handleSuggestAction(toolUse.input, emit)
            : await executeAgentTool(toolUse.name, toolUse.input, { openai, sessionId });
          const toolLatency = Date.now() - toolStart;

          const resultCount = result.results?.length
            || result.episodes?.length
            || result.people?.length
            || result.chapters?.length
            || (result.episode ? 1 : 0)
            || (result.feed ? 1 : 0)
            || (result.before?.length != null ? result.before.length + (result.current ? 1 : 0) + (result.after?.length || 0) : 0)
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

          const budgetUsed = totalInputTokens + totalOutputTokens;
          const budgetNote = budgetUsed > TOKEN_BUDGET_SOFT
            ? `\n\n[BUDGET WARNING: ${budgetUsed} tokens used of ~${TOKEN_BUDGET_SOFT} soft limit. Deliver your best answer now with available evidence.]`
            : `\n\n[Token usage: ${budgetUsed}/${TOKEN_BUDGET_SOFT}]`;

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result) + budgetNote,
          });
        }

        agentLog.rounds.push({
          round,
          type: 'tool_use',
          tokens: response.usage,
          tools: toolUseBlocks.map((tu, i) => ({
            name: tu.name,
            input: tu.input,
            resultCount: toolCalls[toolCalls.length - toolUseBlocks.length + i]?.resultCount,
            latencyMs: toolCalls[toolCalls.length - toolUseBlocks.length + i]?.latencyMs,
          })),
        });

        console.log(`[${requestId}] Pushing ${toolResults.length} tool results to messages`);
        messages.push({ role: 'user', content: toolResults });
        console.log(`[${requestId}] === ROUND ${round} END ===`);
      }
      console.log(`[${requestId}] === LOOP EXITED === round=${round}`);

      const latencyMs = Date.now() - startTime;

      const claudeCost = (totalInputTokens * modelConfig.inputPer1M / 1_000_000) + (totalOutputTokens * modelConfig.outputPer1M / 1_000_000);
      const toolCost = toolCalls.reduce((sum, tc) => sum + (TOOL_COSTS[tc.name] || 0), 0);

      printLog(`[${requestId}] Complete: ${round} rounds, ${toolCalls.length} tool calls, ${totalInputTokens}+${totalOutputTokens} tokens, $${claudeCost.toFixed(4)} LLM, ${latencyMs}ms`);

      agentLog.completedAt = new Date().toISOString();
      agentLog.summary = {
        rounds: round,
        toolCalls: toolCalls.map(tc => ({ name: tc.name, input: tc.input, resultCount: tc.resultCount, latencyMs: tc.latencyMs })),
        tokens: { input: totalInputTokens, output: totalOutputTokens },
        cost: { claude: parseFloat(claudeCost.toFixed(6)), tools: parseFloat(toolCost.toFixed(4)), total: parseFloat((claudeCost + toolCost).toFixed(6)) },
        latencyMs,
      };
      writeAgentLog(requestId, sessionId, agentLog);

      emit('done', {
        sessionId,
        model: modelConfig.label,
        rounds: round,
        toolCalls: toolCalls.map(tc => ({ name: tc.name, resultCount: tc.resultCount, latencyMs: tc.latencyMs })),
        tokens: { input: totalInputTokens, output: totalOutputTokens },
        cost: {
          claude: parseFloat(claudeCost.toFixed(6)),
          tools: parseFloat(toolCost.toFixed(4)),
          total: parseFloat((claudeCost + toolCost).toFixed(6)),
        },
        latencyMs,
      });

      res.end();

    } catch (error) {
      printLog(`[${requestId}] ERROR: ${error.message}`);
      console.error(`[${requestId}] Stack:`, error.stack);
      agentLog.error = error.message;
      agentLog.completedAt = new Date().toISOString();
      writeAgentLog(requestId, sessionId, agentLog);
      emit('error', { error: error.message });
      res.end();
    }
  }

  router.post('/agent', handleAgentChat);
  router.post('/workflow', handleAgentChat);

  return router;
}

module.exports = createAgentChatRoutes;
