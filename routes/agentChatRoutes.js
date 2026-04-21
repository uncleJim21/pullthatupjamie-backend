const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { printLog } = require('../constants.js');
const { SYSTEM_PROMPT, TOOL_DEFINITIONS } = require('../setup-agent');
const { PROFILES, VALID_INTENTS, DEFAULT_INTENT, CLASSIFIER_PROMPT } = require('../setup-agent-profiles');
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

const MAX_TOOL_ROUNDS = 6;
const COST_BUDGET_SOFT = 0.055;  // triggers "wrap up" guidance based on LLM cost only
const COST_BUDGET_HARD = 0.08;   // hard ceiling — forces loop exit, LLM cost only
const MAX_HISTORY_MESSAGES = 4; // 2 prior turns (user + assistant each)

/**
 * Running cost tracker scoped to a single agent request.
 * Separates LLM and tool costs using model-specific pricing.
 */
function createCostTracker(modelConfig) {
  const tracker = {
    llm:   { inputTokens: 0, outputTokens: 0, cost: 0 },
    tools: { calls: 0, cost: 0 },
    get total() { return this.llm.cost + this.tools.cost; },

    addLlmUsage(inputTokens, outputTokens) {
      this.llm.inputTokens += inputTokens;
      this.llm.outputTokens += outputTokens;
      this.llm.cost = (this.llm.inputTokens * modelConfig.inputPer1M / 1_000_000)
                    + (this.llm.outputTokens * modelConfig.outputPer1M / 1_000_000);
    },

    addToolCall(toolName) {
      this.tools.calls++;
      this.tools.cost += TOOL_COSTS[toolName] || 0;
    },

    budgetNote() {
      const spend = this.llm.cost;
      if (spend > COST_BUDGET_HARD) {
        return `\n\n[HARD BUDGET LIMIT: $${spend.toFixed(3)} LLM cost of $${COST_BUDGET_HARD} limit. You MUST deliver your answer NOW. Do NOT call any more tools.]`;
      }
      if (spend > COST_BUDGET_SOFT) {
        return `\n\n[BUDGET WARNING: $${spend.toFixed(3)} LLM cost of $${COST_BUDGET_SOFT} soft limit. Finish searching and deliver your best answer now.]`;
      }
      return '';
    },

    summary() {
      return {
        claude: parseFloat(this.llm.cost.toFixed(6)),
        tools: parseFloat(this.tools.cost.toFixed(4)),
        total: parseFloat(this.total.toFixed(6)),
      };
    },
  };
  return tracker;
}

// --- Step F: Tool result compaction ---
// Strips fields the LLM doesn't need for reasoning. Raw results are still logged & emitted to frontend.

const SEARCH_QUOTES_KEEP = new Set(['quote', 'shareLink', 'episode', 'creator', 'date', 'summary', 'headline']);
const FIND_PERSON_KEEP = new Set(['name', 'role', 'appearances', 'feeds', 'recentEpisodes']);
const DISCOVER_KEEP_FEED = new Set(['title', 'feedId', 'feedGuid', 'transcriptAvailable', 'matchedEpisodes', 'nextSteps']);
const DISCOVER_KEEP_EP = new Set(['title', 'guid', 'feedGuid', 'feedId', 'transcriptAvailable', 'image', 'publishedDate']);

function compactSearchQuotesResult(r, i) {
  const c = { _i: i };
  for (const k of SEARCH_QUOTES_KEEP) {
    if (r[k] !== undefined && r[k] !== null) c[k] = r[k];
  }
  if (r.additionalFields) {
    if (r.additionalFields.guid) c.guid = r.additionalFields.guid;
    if (r.additionalFields.feedId) c.feedId = r.additionalFields.feedId;
  }
  return c;
}

function compactDiscoverResult(r, i) {
  const c = { _i: i };
  for (const k of DISCOVER_KEEP_FEED) {
    if (k === 'matchedEpisodes' && Array.isArray(r[k])) {
      c[k] = r[k].map(ep => {
        const slim = {};
        for (const ek of DISCOVER_KEEP_EP) {
          if (ep[ek] !== undefined) slim[ek] = ep[ek];
        }
        return slim;
      });
    } else if (r[k] !== undefined) {
      c[k] = r[k];
    }
  }
  return c;
}

function compactFindPersonResult(r) {
  const c = {};
  for (const k of FIND_PERSON_KEEP) {
    if (r[k] !== undefined) c[k] = r[k];
  }
  return c;
}

const MAX_COMPACT_DESCRIPTION = 200;

function compactEpisode(ep) {
  if (!ep) return ep;
  const keep = ['title', 'guid', 'feedId', 'feedTitle', 'publishedDate', 'creator', 'guests', 'duration', 'description'];
  const c = {};
  for (const k of keep) {
    if (ep[k] !== undefined) c[k] = ep[k];
  }
  if (c.description && c.description.length > MAX_COMPACT_DESCRIPTION) {
    c.description = c.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, MAX_COMPACT_DESCRIPTION) + '…';
  }
  return c;
}

function measureMessages(messages) {
  let userChars = 0, assistantChars = 0, toolResultChars = 0;
  for (const msg of messages) {
    const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const len = raw.length;
    if (msg.role === 'user') {
      const isToolResult = Array.isArray(msg.content) && msg.content[0]?.type === 'tool_result';
      if (isToolResult) toolResultChars += len;
      else userChars += len;
    } else if (msg.role === 'assistant') {
      assistantChars += len;
    }
  }
  return { userChars, assistantChars, toolResultChars, totalChars: userChars + assistantChars + toolResultChars };
}

function compactToolResult(toolName, result) {
  try {
    switch (toolName) {
      case 'search_quotes':
        if (result.results) {
          return { results: result.results.map((r, i) => compactSearchQuotesResult(r, i)) };
        }
        return result;

      case 'search_chapters':
        if (result.data) {
          return { data: result.data.map((r, i) => ({ _i: i, ...r, embedding: undefined })) };
        }
        return result;

      case 'discover_podcasts':
        if (result.results) {
          return { results: result.results.map((r, i) => compactDiscoverResult(r, i)) };
        }
        return result;

      case 'find_person':
        if (result.people) {
          const compact = { people: result.people.map(compactFindPersonResult) };
          if (result.hostedFeeds?.length) compact.hostedFeeds = result.hostedFeeds;
          if (result.searchStrategy) compact.searchStrategy = result.searchStrategy;
          return compact;
        }
        return result;

      case 'get_person_episodes':
        if (result.episodes) {
          return { episodes: result.episodes.map(compactEpisode) };
        }
        return result;

      case 'get_episode':
        if (result.episode) {
          return { episode: compactEpisode(result.episode) };
        }
        return result;

      case 'get_feed':
        if (result.feed) {
          const { title, feedId, description, episodeCount, imageUrl, hosts, feedType } = result.feed;
          return { feed: { title, feedId, description, episodeCount, imageUrl, hosts, feedType } };
        }
        return result;

      case 'get_feed_episodes':
        if (result.episodes) {
          return { episodes: result.episodes.map(compactEpisode) };
        }
        return result;

      case 'get_adjacent_paragraphs': {
        const compact = {};
        for (const section of ['before', 'current', 'after']) {
          if (!result[section]) continue;
          if (Array.isArray(result[section])) {
            compact[section] = result[section].map(p => ({ text: p.text || p.quote, shareLink: p.shareLink || p.id }));
          } else {
            compact[section] = { text: result[section].text || result[section].quote, shareLink: result[section].shareLink || result[section].id };
          }
        }
        return compact;
      }

      default:
        return result;
    }
  } catch {
    return result;
  }
}

// --- Step B: History compaction ---
// Compresses older assistant messages, preserving structural data (GUIDs, feedIds, clips).

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FEED_ID_RE = /\b(\d{5,8})\b/g;
const CLIP_RE = /\{\{clip:([^}]+)\}\}/g;
const PERSON_BOLD_RE = /\*\*([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\*\*/g;

function compactAssistantMessage(text) {
  const guids = [...new Set((text.match(GUID_RE) || []))];
  const clips = [...new Set([...(text.matchAll(CLIP_RE))].map(m => m[1]))];
  const people = [...new Set([...(text.matchAll(PERSON_BOLD_RE))].map(m => m[1]))];

  const feedIds = [...new Set((text.match(FEED_ID_RE) || []))];

  const truncated = text.substring(0, 200).replace(/\s+\S*$/, '…');

  const parts = [truncated];
  if (people.length) parts.push(`[people: ${people.join(', ')}]`);
  if (guids.length) parts.push(`[guids: ${guids.join(', ')}]`);
  if (feedIds.length) parts.push(`[feedIds: ${feedIds.join(', ')}]`);
  if (clips.length) parts.push(`[clips: ${clips.join(', ')}]`);

  return parts.join('\n');
}

function compactHistory(history) {
  if (history.length <= 2) return history;

  const lastAssistantIdx = history.reduce((acc, m, i) => m.role === 'assistant' ? i : acc, -1);

  return history.map((msg, i) => {
    if (msg.role !== 'assistant') return msg;
    if (i === lastAssistantIdx) return msg;
    return { role: 'assistant', content: compactAssistantMessage(msg.content) };
  });
}

// --- Dynamic feed lookup table ---
let feedLookupTable = null;
let feedLookupPromptSection = '';

const FEED_TABLE_MIN_EPISODES = 50;

async function buildFeedLookup() {
  if (feedLookupTable) return;
  try {
    const [feeds, epCounts] = await Promise.all([
      JamieVectorMetadata.find({ type: 'feed' })
        .select('feedId metadataRaw.title')
        .lean(),
      JamieVectorMetadata.aggregate([
        { $match: { type: 'episode' } },
        { $group: { _id: '$feedId', count: { $sum: 1 } } },
      ]),
    ]);

    const countMap = new Map(epCounts.map(e => [String(e._id), e.count]));

    feedLookupTable = {};
    const lines = [];
    for (const f of feeds) {
      const title = f.metadataRaw?.title || 'Unknown';
      const fid = String(f.feedId);
      feedLookupTable[title.toLowerCase()] = fid;
      const transcribed = countMap.get(fid) || 0;
      if (transcribed >= FEED_TABLE_MIN_EPISODES) {
        lines.push(`${fid}: ${title}`);
      }
    }
    lines.sort();
    feedLookupPromptSection = `\n\n## Feed ID Lookup\nUse numeric feed IDs with search_quotes feedIds filter. Not exhaustive — use search_quotes or find_person for unlisted shows.\n${lines.join('\n')}`;
    printLog(`[AGENT] Feed lookup table built: ${lines.length}/${feeds.length} feeds (${FEED_TABLE_MIN_EPISODES}+ transcribed episodes)`);
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
const CLASSIFIER_MODEL = AGENT_MODELS.fast.id;

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

async function classifyIntent(message, history) {
  try {
    const userContext = history.length > 0
      ? `Previous messages:\n${history.map(m => `${m.role}: ${m.content}`).join('\n')}\n\nCurrent message: ${message}`
      : message;

    const resp = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 30,
      system: CLASSIFIER_PROMPT,
      messages: [{ role: 'user', content: userContext }],
    });

    const text = (resp.content[0]?.text || '').trim();
    const match = text.match(/"intent"\s*:\s*"(\w+)"/);
    const intent = match ? match[1] : null;

    if (intent && VALID_INTENTS.includes(intent)) {
      printLog(`[TRIAGE] Classified intent: "${intent}" (tokens: ${resp.usage?.input_tokens}+${resp.usage?.output_tokens})`);
      return { intent, classifierTokens: resp.usage };
    }

    printLog(`[TRIAGE] Unknown intent "${intent}" from response "${text}", falling back to ${DEFAULT_INTENT}`);
    return { intent: DEFAULT_INTENT, classifierTokens: resp.usage };
  } catch (err) {
    printLog(`[TRIAGE] Classifier failed: ${err.message}, falling back to ${DEFAULT_INTENT}`);
    return { intent: DEFAULT_INTENT, classifierTokens: null };
  }
}

function sanitizeSuggestAction(toolInput) {
  const clean = { ...toolInput };

  // Haiku sometimes embeds XML parameter tags inside JSON string values.
  // Scan every string field: extract any <parameter name="key">value</parameter> or
  // </key>\n<parameter name="key">value patterns and hoist them to top-level keys.
  const xmlParamRe = /<\/?[\w]+>?\s*<parameter\s+name="(\w+)">([\s\S]*?)(?:<\/parameter>|$)/g;
  for (const [field, val] of Object.entries(clean)) {
    if (typeof val !== 'string') continue;
    let match;
    let stripped = val;
    while ((match = xmlParamRe.exec(val)) !== null) {
      const [fullMatch, extractedKey, extractedVal] = match;
      if (!clean[extractedKey]) {
        clean[extractedKey] = extractedVal.trim();
      }
      stripped = stripped.replace(fullMatch, '');
    }
    // Also handle the simpler </field>\n<parameter name="key">value (no closing tag)
    const simpleRe = /<\/\w+>\s*<parameter\s+name="(\w+)">([\s\S]*)/;
    const simpleMatch = stripped.match(simpleRe);
    if (simpleMatch) {
      const [fullMatch, extractedKey, extractedVal] = simpleMatch;
      if (!clean[extractedKey]) {
        clean[extractedKey] = extractedVal.replace(/<\/parameter>\s*$/, '').trim();
      }
      stripped = stripped.replace(fullMatch, '');
    }
    if (stripped !== val) {
      clean[field] = stripped.trim();
    }
  }

  // If image is still missing, check all string values for an image URL
  if (!clean.image) {
    for (const [field, val] of Object.entries(clean)) {
      if (typeof val !== 'string' || field === 'image') continue;
      const urlMatch = val.match(/(https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)\S*)/i);
      if (urlMatch) {
        clean.image = urlMatch[1];
        clean[field] = val.replace(urlMatch[0], '').replace(/<[^>]*>/g, '').trim();
        break;
      }
    }
  }

  return clean;
}

function buildSubmitOnDemandPayload(input, { episodeCache, feedFallback } = {}) {
  const payload = {
    type: 'submit-on-demand',
    reason: input.reason || '',
    guid: input.guid || undefined,
    feedGuid: input.feedGuid || undefined,
    feedId: input.feedId != null && input.feedId !== '' ? String(input.feedId) : undefined,
    episodeTitle: input.episodeTitle || undefined,
    image: input.image || undefined,
  };
  const source = {
    guid: payload.guid ? 'input' : 'missing',
    feedGuid: payload.feedGuid ? 'input' : 'missing',
    feedId: payload.feedId ? 'input' : 'missing',
    episodeTitle: payload.episodeTitle ? 'input' : 'missing',
    image: payload.image ? 'input' : 'missing',
  };

  if (payload.guid && episodeCache?.has(payload.guid)) {
    const cached = episodeCache.get(payload.guid);
    if (!payload.feedGuid && cached.feedGuid) { payload.feedGuid = cached.feedGuid; source.feedGuid = 'cache'; }
    if (!payload.feedId && cached.feedId) { payload.feedId = String(cached.feedId); source.feedId = 'cache'; }
    if (!payload.episodeTitle && cached.episodeTitle) { payload.episodeTitle = cached.episodeTitle; source.episodeTitle = 'cache'; }
    if (!payload.image && cached.image) { payload.image = cached.image; source.image = 'cache'; }
  }

  if (feedFallback) {
    if (!payload.feedGuid && feedFallback.feedGuid) { payload.feedGuid = feedFallback.feedGuid; source.feedGuid = 'feed'; }
    if (!payload.feedId && feedFallback.feedId) { payload.feedId = String(feedFallback.feedId); source.feedId = 'feed'; }
    if (!payload.image && feedFallback.image) { payload.image = feedFallback.image; source.image = 'feed'; }
  }

  return { payload, source };
}

function emitSubmitOnDemand(input, { emit, episodeCache, suggestedGuids, requestId, feedFallback, origin = 'llm' } = {}) {
  const { payload, source } = buildSubmitOnDemandPayload(input, { episodeCache, feedFallback });

  const missing = [];
  if (!payload.guid) missing.push('guid');
  if (!payload.feedGuid) missing.push('feedGuid');
  if (!payload.feedId) missing.push('feedId');

  const titlePreview = payload.episodeTitle ? payload.episodeTitle.substring(0, 60) : '';
  const prefix = `[${requestId || 'SUGGEST'}] submit-on-demand[${origin}]`;

  if (missing.length > 0) {
    console.log(`${prefix} DROPPED — missing ${missing.join(',')} | guid=${payload.guid || 'null'}(${source.guid}) feedGuid=${payload.feedGuid || 'null'}(${source.feedGuid}) feedId=${payload.feedId || 'null'}(${source.feedId}) title="${titlePreview}"`);
    return { emitted: false, missing, payload };
  }

  if (suggestedGuids?.has(payload.guid) || (payload.feedId && suggestedGuids?.has(payload.feedId))) {
    console.log(`${prefix} SKIPPED (dedup) guid=${payload.guid} feedId=${payload.feedId}`);
    return { emitted: false, reason: 'dedup', payload };
  }

  if (suggestedGuids) {
    suggestedGuids.add(payload.guid);
    if (payload.feedId) suggestedGuids.add(payload.feedId);
  }

  emit('suggested_action', payload);
  console.log(`${prefix} EMITTED guid=${payload.guid}(${source.guid}) feedGuid=${payload.feedGuid}(${source.feedGuid}) feedId=${payload.feedId}(${source.feedId}) title="${titlePreview}"(${source.episodeTitle}) image=${payload.image ? 'yes' : 'no'}(${source.image})`);
  return { emitted: true, payload };
}

function handleSuggestAction(toolInput, emit, { episodeCache, suggestedGuids, requestId } = {}) {
  const sanitized = sanitizeSuggestAction(toolInput);
  const { type, reason, ...params } = sanitized;

  if (type === 'submit-on-demand') {
    const result = emitSubmitOnDemand(
      { reason, ...params },
      { emit, episodeCache, suggestedGuids, requestId, origin: 'llm' },
    );
    if (!result.emitted) {
      if (result.reason === 'dedup') {
        return { acknowledged: false, message: 'Already surfaced this transcription suggestion earlier in the response. Skip — do not retry.' };
      }
      return {
        acknowledged: false,
        message: `Skipped: submit-on-demand requires a guid from a recent discover_podcasts or get_feed_episodes result. Missing: ${(result.missing || []).join(', ')}. The server auto-fills feedGuid/feedId/title/image from the cache, but nothing in the cache matched guid "${params.guid || 'none'}".`,
      };
    }
    return {
      acknowledged: true,
      message: `Transcription suggestion surfaced for "${result.payload.episodeTitle || result.payload.guid}". Continue your response naturally; do not narrate this suggestion to the user.`,
    };
  }

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
    // TEMPORARILY DEPRECATED: fast vs quality mode selection.
    // The `model` field in req.body is intentionally ignored — all requests
    // use DEFAULT_AGENT_MODEL. To re-enable dual-mode, restore:
    //   const modelKey = (req.body.model === 'quality') ? 'quality' : DEFAULT_AGENT_MODEL;
    // and re-expose the `model` param in the frontend / API docs.
    const modelKey = DEFAULT_AGENT_MODEL;
    const modelConfig = AGENT_MODELS[modelKey];
    const sessionId = req.body.sessionId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestId = `AGENT-${sessionId.slice(-8)}`;
    const startTime = Date.now();
    const bypassTriage = req.body.bypassTriage === true;
    const triageEnabled = process.env.AGENT_TRIAGE_ENABLED !== 'false';
    const compactResults = req.body.compactResults !== undefined ? req.body.compactResults !== false : process.env.AGENT_COMPACT_RESULTS !== 'false';
    const compactHistoryEnabled = req.body.compactHistory !== undefined ? req.body.compactHistory !== false : process.env.AGENT_COMPACT_HISTORY !== 'false';
    // Internal-only flag driven by env. When false (default / production),
    // SSE emits are stripped of model, cost, tokens, intent, tool inputs,
    // round numbers, etc. Set AGENT_INCLUDE_METRICS=true in .env on internal
    // environments (local dev, benchmarks) to receive the full payload.
    const includeMetrics = process.env.AGENT_INCLUDE_METRICS === 'true';

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

    // Streaming decision — precedence:
    //   1. req.body.stream (explicit opt-in/out from caller)
    //   2. Accept: text/event-stream header
    //   3. req._defaultStream (set by route wrappers — /api/pull sets false)
    //   4. Default true (preserves legacy /api/chat/* frontend behavior)
    const acceptHeader = String(req.headers.accept || '').toLowerCase();
    const acceptWantsSse = acceptHeader.includes('text/event-stream');
    const streaming = typeof req.body.stream === 'boolean'
      ? req.body.stream
      : acceptWantsSse
        ? true
        : typeof req._defaultStream === 'boolean'
          ? req._defaultStream
          : true;

    printLog(`[${requestId}] POST ${req.path} — model=${modelConfig.label}, history=${history.length}, compact=${compactResults}/${compactHistoryEnabled}, stream=${streaming}, "${message.substring(0, 100)}"`);

    if (streaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }

    // Non-streaming accumulator. Populated by emit() when !streaming.
    const buffered = {
      text: '',
      suggestedActions: [],
      toolCalls: [],
      session: null,
      error: null,
    };

    // Fields stripped from SSE payloads when includeMetrics=false (default).
    // Keys = event type, values = set of top-level fields to drop.
    const INTERNAL_FIELDS = {
      status:      new Set(['intent']),
      tool_call:   new Set(['input', 'round']),
      tool_result: new Set(['resultCount', 'latencyMs', 'round']),
      done:        new Set(['model', 'intent', 'rounds', 'toolCalls', 'tokens', 'cost', 'latencyMs']),
    };

    const sanitize = (eventType, data) => {
      if (includeMetrics) return data;
      const stripKeys = INTERNAL_FIELDS[eventType];
      if (!stripKeys || !data || typeof data !== 'object') return data;
      const out = {};
      for (const k of Object.keys(data)) {
        if (!stripKeys.has(k)) out[k] = data[k];
      }
      return out;
    };

    const emit = (eventType, data) => {
      const payload = sanitize(eventType, data);
      if (streaming) {
        try {
          res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
        } catch (e) { /* client disconnected */ }
        return;
      }
      // Non-streaming: accumulate for the final JSON response.
      // text_delta is ignored — text_done carries the full final text.
      switch (eventType) {
        case 'text_done':
          if (payload && typeof payload.text === 'string') buffered.text = payload.text;
          break;
        case 'suggested_action':
          if (payload) buffered.suggestedActions.push(payload);
          break;
        case 'tool_result':
          if (payload) buffered.toolCalls.push(payload);
          break;
        case 'session_created':
          if (payload) buffered.session = payload;
          break;
        case 'error':
          if (payload && payload.error) buffered.error = payload.error;
          break;
        // text_delta, tool_call, status, done — intentionally dropped in non-streaming mode
      }
    };

    let _aborted = false;
    res.on('close', () => { _aborted = true; });
    const aborted = () => _aborted;

    let agentLog = null;

    try {
      await buildFeedLookup();

      let intent = DEFAULT_INTENT;
      let classifierTokens = null;
      if (triageEnabled && !bypassTriage) {
        const result = await classifyIntent(message, history);
        intent = result.intent;
        classifierTokens = result.classifierTokens;
      } else {
        printLog(`[${requestId}] Triage bypassed (enabled=${triageEnabled}, bypassTriage=${bypassTriage})`);
      }

      const profile = PROFILES[intent];
      const followUpContext = req.body.context;
      const MAX_HINT_LENGTH = 500;
      let contextSection = '';
      if (followUpContext && typeof followUpContext === 'object') {
        const parts = [];
        if (followUpContext.guids?.length) parts.push(`GUIDs: ${followUpContext.guids.join(', ')}`);
        if (followUpContext.feedIds?.length) parts.push(`Feed IDs: ${followUpContext.feedIds.join(', ')}`);
        if (followUpContext.persons?.length) parts.push(`People: ${followUpContext.persons.join(', ')}`);
        if (typeof followUpContext.hint === 'string' && followUpContext.hint.trim()) {
          parts.push(`Additional context: ${followUpContext.hint.trim().substring(0, MAX_HINT_LENGTH)}`);
        }
        if (parts.length > 0) {
          contextSection = `\n\n## Pre-resolved context from previous turn\nThe following was already resolved — use it directly instead of re-resolving:\n${parts.join('\n')}`;
          printLog(`[${requestId}] Follow-up context: ${parts.join(', ')}`);
        }
      }
      const effectiveSystemPrompt = profile.buildPrompt() + feedLookupPromptSection + contextSection;
      const effectiveTools = profile.tools();

      emit('status', { message: 'Analyzing your request...', sessionId, intent });
      printLog(`[${requestId}] Intent: ${intent}, tools: ${effectiveTools.map(t => t.name).join(', ')}`);

      const effectiveHistory = compactHistoryEnabled ? compactHistory(history) : history;
      const messages = [...effectiveHistory, { role: 'user', content: message }];
      const clipCache = new Map(); // shareLink → raw clip metadata, populated by search_quotes results
      let toolCalls = [];
      const costs = createCostTracker(modelConfig);
      let round = 0;
      let hasExecutedTools = false;
      const discoverResults = [];
      const suggestedGuids = new Set();
      const accumulatedTextByRound = [];
      const episodeCache = new Map();

      const cacheEpisode = (ep, feedFallback = {}) => {
        if (!ep || !ep.guid) return;
        const existing = episodeCache.get(ep.guid) || {};
        episodeCache.set(ep.guid, {
          guid: ep.guid,
          feedGuid: existing.feedGuid || ep.feedGuid || feedFallback.feedGuid || null,
          feedId: existing.feedId || (ep.feedId != null ? String(ep.feedId) : null) || (feedFallback.feedId != null ? String(feedFallback.feedId) : null),
          episodeTitle: existing.episodeTitle || ep.title || ep.episodeTitle || null,
          image: existing.image || ep.image || feedFallback.image || null,
        });
      };
      agentLog = {
        requestId, sessionId, model: modelConfig.label, intent,
        query: message, startedAt: new Date().toISOString(),
        classifierTokens,
        rounds: [],
        finalText: null, error: null,
      };

      while (round < MAX_TOOL_ROUNDS && !_aborted && costs.llm.cost < COST_BUDGET_HARD) {
        round++;
        console.log(`[${requestId}] === ROUND ${round} START ===`);

        if (hasExecutedTools) {
          emit('status', { message: 'Composing your answer...', sessionId });
        }

        const msgMetrics = measureMessages(messages);
        const systemChars = effectiveSystemPrompt.length;
        const totalInputChars = systemChars + msgMetrics.totalChars;
        printLog(`[${requestId}] Round ${round} input: system=${systemChars}c (~${Math.ceil(systemChars/4)}tok), messages=${msgMetrics.totalChars}c (user=${msgMetrics.userChars}, assistant=${msgMetrics.assistantChars}, toolResults=${msgMetrics.toolResultChars}), total=~${Math.ceil(totalInputChars/4)}tok est`);

        const stream = await anthropic.messages.create({
          model: modelConfig.id,
          max_tokens: 4096,
          system: effectiveSystemPrompt,
          messages,
          tools: effectiveTools,
          stream: true,
        });

        const response = await consumeStream(stream, { emit, aborted, requestId });

        console.log(`[${requestId}] Claude response: stop_reason="${response.stop_reason}", content_blocks=${response.content.length}, types=[${response.content.map(b => b.type).join(',')}]`);
        console.log(`[${requestId}] Tokens this round: input=${response.usage?.input_tokens}, output=${response.usage?.output_tokens}`);

        costs.addLlmUsage(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0);

        const assistantContent = response.content;
        messages.push({ role: 'assistant', content: assistantContent });

        const isFinalResponse = response.stop_reason !== 'tool_use';

        const roundText = assistantContent
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('');
        if (roundText.length > 0) {
          accumulatedTextByRound.push({ round, text: roundText });
        }

        if (isFinalResponse) {
          const fullText = accumulatedTextByRound.map(r => r.text).join('\n\n');
          console.log(`[${requestId}] Final text streamed: ${fullText.length} chars across ${accumulatedTextByRound.length} round(s) (round ${round} contributed ${roundText.length} chars)`);
          agentLog.rounds.push({ round, type: 'final', tokens: response.usage });
          agentLog.finalText = fullText;
          emit('text_done', { text: fullText });
          break;
        }

        if (roundText.length > 0) {
          console.log(`[${requestId}] Intermediate text captured (${roundText.length} chars) for final text_done: "${roundText.substring(0, 80)}..."`);
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

          let result;
          if (toolUse.name === 'suggest_action') {
            result = handleSuggestAction(toolUse.input, emit, { episodeCache, suggestedGuids, requestId });
          } else if (toolUse.name === 'create_research_session') {
            result = await executeAgentTool(toolUse.name, toolUse.input, { openai, sessionId, req, clipCache });
            if (result.sessionId && result.url) {
              emit('session_created', { sessionId: result.sessionId, url: result.url, itemCount: result.itemCount });
            }
          } else {
            result = await executeAgentTool(toolUse.name, toolUse.input, { openai, sessionId });
          }

          if (toolUse.name === 'search_quotes' && result.results) {
            const dupes = [];
            for (const r of result.results) {
              if (r.shareLink) {
                if (clipCache.has(r.shareLink)) dupes.push(r.shareLink);
                clipCache.set(r.shareLink, r);
              }
            }
            printLog(`[${requestId}] search_quotes shareLinks: ${result.results.map(r => {
              const q = (r.quote || '').substring(0, 60).replace(/\n/g, ' ');
              return `${r.shareLink} "${q}…"`;
            }).join(' | ')}`);
            if (dupes.length > 0) {
              printLog(`[${requestId}] ⚠ DUPLICATE shareLinks across parallel search_quotes calls: ${dupes.join(', ')}`);
            }
          }
          if (toolUse.name === 'discover_podcasts' && result.results) {
            discoverResults.push(...result.results);
            for (const feed of result.results) {
              const feedFallback = { feedGuid: feed.feedGuid, feedId: feed.feedId, image: feed.image };
              for (const ep of (feed.matchedEpisodes || [])) cacheEpisode(ep, feedFallback);
              for (const ep of (feed.episodes || [])) cacheEpisode(ep, feedFallback);
            }
          }
          if (toolUse.name === 'get_feed_episodes' && result.episodes) {
            const feedFallback = { feedId: result.feed?.feedId || result.feedId, feedGuid: result.feed?.feedGuid, image: result.feed?.image };
            for (const ep of result.episodes) cacheEpisode(ep, feedFallback);
          }
          if (toolUse.name === 'get_person_episodes' && result.episodes) {
            for (const ep of result.episodes) cacheEpisode(ep);
          }
          const toolLatency = Date.now() - toolStart;

          const resultCount = result.results?.length
            || result.episodes?.length
            || (result.people?.length || 0) + (result.hostedFeeds?.length || 0)
            || result.chapters?.length
            || (result.episode ? 1 : 0)
            || (result.feed ? 1 : 0)
            || (result.sessionId ? result.itemCount || 1 : 0)
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

          costs.addToolCall(toolUse.name);
          const budgetNote = costs.budgetNote();

          const llmResult = compactResults ? compactToolResult(toolUse.name, result) : result;
          if (compactResults) {
            const compactedSize = JSON.stringify(llmResult).length;
            if (compactedSize < resultSize) {
              console.log(`[${requestId}] Compacted ${toolUse.name}: ${resultSize} → ${compactedSize} chars (saved ${resultSize - compactedSize})`);
            }
          }
          if (toolUse.name === 'search_quotes' && llmResult.results) {
            printLog(`[${requestId}] LLM receives search_quotes: ${llmResult.results.map(r => {
              const q = (r.quote || '').substring(0, 50).replace(/\n/g, ' ');
              return `[${r._i}] ${r.shareLink} "${q}…"`;
            }).join(' | ')}`);
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(llmResult) + budgetNote,
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

      const { claude: claudeCost, tools: toolCost, total: totalCost } = costs.summary();

      const finalMetrics = measureMessages(messages);
      printLog(`[${requestId}] Token budget breakdown: system=~${Math.ceil(effectiveSystemPrompt.length/4)}tok, user=~${Math.ceil(finalMetrics.userChars/4)}tok, assistant=~${Math.ceil(finalMetrics.assistantChars/4)}tok, toolResults=~${Math.ceil(finalMetrics.toolResultChars/4)}tok | actual=${costs.llm.inputTokens}in+${costs.llm.outputTokens}out`);
      printLog(`[${requestId}] Complete: ${round} rounds, ${toolCalls.length} tool calls, ${costs.llm.inputTokens}+${costs.llm.outputTokens} tokens, $${claudeCost.toFixed(4)} LLM + $${toolCost.toFixed(4)} tools = $${totalCost.toFixed(4)}, ${latencyMs}ms`);

      agentLog.completedAt = new Date().toISOString();
      agentLog.summary = {
        rounds: round,
        toolCalls: toolCalls.map(tc => ({ name: tc.name, input: tc.input, resultCount: tc.resultCount, latencyMs: tc.latencyMs })),
        tokens: { input: costs.llm.inputTokens, output: costs.llm.outputTokens },
        cost: costs.summary(),
        latencyMs,
      };
      writeAgentLog(requestId, sessionId, agentLog);

      // Auto-upsell: surface untranscribed episodes from discover results the agent didn't suggest
      const AUTO_UPSELL_MAX = 2;
      let autoUpsellEmitted = 0;
      let autoUpsellAttempted = 0;
      let autoUpsellDropped = 0;
      let autoUpsellDeduped = 0;
      outer: for (const feed of discoverResults) {
        const feedFallback = {
          feedGuid: feed.feedGuid || feed.podcastGuid || null,
          feedId: feed.feedId != null ? String(feed.feedId) : null,
          image: feed.image || feed.artwork || feed.imageUrl || null,
        };
        // For transcribed feeds, untranscribed episodes live in matchedEpisodes (flagged transcriptAvailable=false).
        // For untranscribed feeds, all episodes live in feed.episodes (always untranscribed).
        const candidateEpisodes = [
          ...(feed.matchedEpisodes || []).filter(ep => !ep.transcriptAvailable),
          ...(feed.episodes || []),
        ];
        for (const ep of candidateEpisodes) {
          if (autoUpsellEmitted >= AUTO_UPSELL_MAX) break outer;
          autoUpsellAttempted++;
          const result = emitSubmitOnDemand(
            {
              reason: `${feed.title || 'This show'} has untranscribed episodes that may be relevant.`,
              guid: ep.guid || null,
              feedGuid: ep.feedGuid || null,
              feedId: ep.feedId != null ? String(ep.feedId) : null,
              episodeTitle: ep.title || null,
              image: ep.image || null,
            },
            { emit, episodeCache, suggestedGuids, requestId, feedFallback, origin: 'auto-upsell' },
          );
          if (result.emitted) autoUpsellEmitted++;
          else if (result.reason === 'dedup') autoUpsellDeduped++;
          else autoUpsellDropped++;
        }
      }
      if (autoUpsellAttempted > 0) {
        printLog(`[${requestId}] Auto-upsell summary: attempted=${autoUpsellAttempted} emitted=${autoUpsellEmitted} dropped=${autoUpsellDropped} deduped=${autoUpsellDeduped} (max=${AUTO_UPSELL_MAX}, from ${discoverResults.length} discover feed(s))`);
      } else if (discoverResults.length > 0) {
        printLog(`[${requestId}] Auto-upsell: 0 candidates from ${discoverResults.length} discover feed(s) — no untranscribed matchedEpisodes`);
      }

      emit('done', {
        sessionId,
        model: modelConfig.label,
        intent,
        rounds: round,
        toolCalls: toolCalls.map(tc => ({ name: tc.name, resultCount: tc.resultCount, latencyMs: tc.latencyMs })),
        tokens: { input: costs.llm.inputTokens, output: costs.llm.outputTokens },
        cost: {
          claude: claudeCost,
          tools: toolCost,
          total: totalCost,
        },
        latencyMs,
      });

      if (streaming) {
        res.end();
      } else {
        const responseBody = {
          sessionId,
          text: buffered.text,
          suggestedActions: buffered.suggestedActions,
        };
        if (buffered.session) responseBody.session = buffered.session;
        if (includeMetrics) {
          responseBody.metrics = {
            model: modelConfig.label,
            intent,
            rounds: round,
            toolCalls: buffered.toolCalls,
            tokens: { input: costs.llm.inputTokens, output: costs.llm.outputTokens },
            cost: { claude: claudeCost, tools: toolCost, total: totalCost },
            latencyMs,
          };
        }
        res.status(200).json(responseBody);
      }

    } catch (error) {
      printLog(`[${requestId}] ERROR: ${error.message}`);
      console.error(`[${requestId}] Stack:`, error.stack);
      try {
        if (!agentLog) {
          agentLog = {
            requestId, sessionId, model: modelConfig.label,
            query: message, startedAt: new Date().toISOString(),
            rounds: [], finalText: null,
          };
        }
        agentLog.error = error.message;
        agentLog.completedAt = new Date().toISOString();
        writeAgentLog(requestId, sessionId, agentLog);
      } catch (logErr) {
        console.error(`[${requestId}] Failed to write agent log:`, logErr.message);
      }
      if (streaming) {
        emit('error', { error: error.message });
        res.end();
      } else if (!res.headersSent) {
        res.status(500).json({ sessionId, error: error.message });
      } else {
        res.end();
      }
    }
  }

  router.post('/agent', handleAgentChat);
  router.post('/workflow', handleAgentChat);

  return router;
}

module.exports = createAgentChatRoutes;
