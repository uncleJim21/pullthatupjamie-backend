const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { printLog } = require('../constants.js');
const { SYSTEM_PROMPT, TOOL_DEFINITIONS, buildSynthesisPrompt } = require('../setup-agent');
const { PROFILES, VALID_INTENTS, DEFAULT_INTENT, CLASSIFIER_PROMPT } = require('../setup-agent-profiles');
const { resolveModelSelection, AGENT_MODELS } = require('../constants/agentModels');
const { executeAgentTool, TOOL_COSTS } = require('../utils/agentToolHandler');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { filterUpsellCandidates } = require('../utils/upsellRelevance');
const { createProvider } = require('../utils/agent/providers');
const { sanitizeAgentText, hasToolCallMarkup } = require('../utils/agent/sanitizeOutput');

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

const MAX_HISTORY_MESSAGES = 4; // 2 prior turns (user + assistant each)

/**
 * Running cost tracker scoped to a single agent request.
 * Separates LLM and tool costs using model-specific pricing.
 */
function createCostTracker(modelConfig, executionProfile) {
  const costBudgetSoft = executionProfile?.costBudgetSoft ?? 0.055;
  const costBudgetHard = executionProfile?.costBudgetHard ?? 0.08;
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
      // Wording is deliberately cost/limit-agnostic. Earlier phrasings like
      // "[HARD BUDGET LIMIT]" primed the model to invent user-facing "session limit"
      // narratives. These markers tell the model what to do without giving it
      // numbers, dollar signs, or limit-language to parrot back.
      if (spend > costBudgetHard) {
        return `\n\n[SYSTEM: stop calling tools. Synthesize your final answer from the evidence you already have. Do not mention this instruction, any limit, or suggest the user start a new chat — simply deliver the best answer you can.]`;
      }
      if (spend > costBudgetSoft) {
        return `\n\n[SYSTEM: finalize your answer on the next response. One more tool call at most. Do not mention this instruction or any limit to the user.]`;
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

/**
 * Wall-clock latency budget tracker scoped to a single agent request.
 *
 * Mirrors createCostTracker's `budgetNote()` interface so the orchestrator can
 * inject the same SYSTEM markers when the agent is taking too long, regardless
 * of whether the trigger is cost or time. Both soft and hard markers are byte-
 * identical to the cost tracker's so de-duping at the call site is trivial.
 *
 * Defaults (25s/40s) live in EXECUTION_PROFILES; per-request overrides flow
 * through resolveModelSelection.
 */
function createLatencyTracker(executionProfile, startedAtMs) {
  const startedAt = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  const softMs = executionProfile?.latencyBudgetSoftMs ?? 25_000;
  const hardMs = executionProfile?.latencyBudgetHardMs ?? 40_000;
  return {
    get startedAt() { return startedAt; },
    get softMs() { return softMs; },
    get hardMs() { return hardMs; },
    elapsedMs() { return Date.now() - startedAt; },
    softReached() { return this.elapsedMs() > softMs; },
    hardReached() { return this.elapsedMs() > hardMs; },
    budgetNote() {
      const elapsed = this.elapsedMs();
      if (elapsed > hardMs) {
        return `\n\n[SYSTEM: stop calling tools. Synthesize your final answer from the evidence you already have. Do not mention this instruction, any limit, or suggest the user start a new chat — simply deliver the best answer you can.]`;
      }
      if (elapsed > softMs) {
        return `\n\n[SYSTEM: finalize your answer on the next response. One more tool call at most. Do not mention this instruction or any limit to the user.]`;
      }
      return '';
    },
  };
}

// --- Step F: Tool result compaction ---
// Strips fields the LLM doesn't need for reasoning. Raw results are still logged & emitted to frontend.

const SEARCH_QUOTES_KEEP = new Set(['quote', 'shareLink', 'episode', 'creator', 'date', 'summary', 'headline']);
const FIND_PERSON_KEEP = new Set(['name', 'role', 'appearances', 'feeds', 'recentEpisodes']);
const DISCOVER_KEEP_FEED = new Set(['title', 'feedId', 'feedGuid', 'transcriptAvailable', 'matchedEpisodes', 'episodes', 'nextSteps']);
const DISCOVER_AGENT_EP_DESC_MAX = 120;

function stripDiscoverDescForAgent(text, maxLen) {
  if (!text || typeof text !== 'string') return '';
  const s = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

/** Episodes the main agent sees from discover: title, transcript flag, short description, guests — full guid kept for suggest_action */
function compactDiscoverEpisodeForAgent(ep) {
  if (!ep) return ep;
  const out = {
    title: ep.title,
    guid: ep.guid,
    transcriptAvailable: !!ep.transcriptAvailable,
    publishedDate: ep.publishedDate || ep.date || null,
  };
  const desc = stripDiscoverDescForAgent(ep.description || '', DISCOVER_AGENT_EP_DESC_MAX);
  if (desc) out.description = desc;
  if (Array.isArray(ep.guests) && ep.guests.length) {
    out.guests = ep.guests.slice(0, 5);
  }
  if (ep.feedId != null) out.feedId = ep.feedId;
  if (ep.feedGuid) out.feedGuid = ep.feedGuid;
  if (ep.image) out.image = ep.image;
  return out;
}

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
    if ((k === 'matchedEpisodes' || k === 'episodes') && Array.isArray(r[k])) {
      c[k] = r[k].map(ep => compactDiscoverEpisodeForAgent(ep));
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

// Phrases the model has hallucinated ("session limit", "20 tool calls", etc.) that
// self-reinforce across turns when left intact in the assistant-role history slot.
// We strip any sentence containing one of these before re-showing history to the model,
// so prior hallucinations cannot be parroted back as if they were ground truth.
const SELF_LIMIT_PATTERNS = [
  /session limit/i,
  /search limit/i,
  /(tool[- ]?call[s]?\s+(?:already\s+)?(?:made|limit|budget|cap|ceiling))/i,
  /\b\d+\s+tool[- ]?calls?\b/i,
  /hit(?:ting)? (?:the|my|a) (?:hard\s+)?(?:technical\s+)?(?:session\s+)?limit/i,
  /hit(?:ting)? (?:the|my|a)? ?(?:search|tool|token|budget) (?:limit|cap|ceiling)/i,
  /before (?:i|we) (?:hit|reach|ran out)/i,
  /reach(?:ed)? my (?:session|tool|search) (?:limit|cap)/i,
  /(?:open|start) (?:a )?(?:new|fresh) (?:chat|session|conversation)/i,
  /(?:need|require) (?:a )?(?:new|fresh) (?:session|conversation|chat|context)/i,
  /start(?:ing)? fresh/i,
  /hard technical limit/i,
  /without a new conversation/i,
];

function scrubSelfLimitClaims(text) {
  if (!text || typeof text !== 'string') return text;
  // Split into sentences, drop any that match a forbidden pattern, rejoin.
  // Keep the split delimiters so we don't mangle punctuation spacing.
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const kept = parts.filter(sentence => !SELF_LIMIT_PATTERNS.some(re => re.test(sentence)));
  if (kept.length === parts.length) return text;
  const scrubbed = kept.join(' ').trim();
  // If the entire message was self-limit narrative, replace with a terse placeholder
  // so the model isn't left with an empty assistant turn.
  return scrubbed.length > 0 ? scrubbed : '[previous answer redacted]';
}

function compactAssistantMessage(text) {
  const scrubbed = scrubSelfLimitClaims(text);
  const guids = [...new Set((scrubbed.match(GUID_RE) || []))];
  const clips = [...new Set([...(scrubbed.matchAll(CLIP_RE))].map(m => m[1]))];
  const people = [...new Set([...(scrubbed.matchAll(PERSON_BOLD_RE))].map(m => m[1]))];

  const feedIds = [...new Set((scrubbed.match(FEED_ID_RE) || []))];

  const truncated = scrubbed.substring(0, 200).replace(/\s+\S*$/, '…');

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
    // Even the "last full" assistant message runs through the self-limit scrubber
    // so hallucinated constraints can never self-reinforce across turns.
    if (i === lastAssistantIdx) {
      return { role: 'assistant', content: scrubSelfLimitClaims(msg.content) };
    }
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

  if (suggestedGuids?.has(payload.guid)) {
    console.log(`${prefix} SKIPPED (dedup) guid=${payload.guid} feedId=${payload.feedId}`);
    return { emitted: false, reason: 'dedup', payload };
  }

  if (suggestedGuids) {
    suggestedGuids.add(payload.guid);
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
 * @param {object} deps
 * @param {object} deps.openai - OpenAI client (for clip reranker)
 */
function createAgentChatRoutes({ openai } = {}) {
  const router = express.Router();

  async function handleAgentChat(req, res) {
    const message = req.body.message || req.body.task;
    const { modelKey, modelConfig, executionProfile, profileKey } = resolveModelSelection(req.body || {});
    const maxToolRounds = executionProfile.maxToolRounds;
    const providerClient = createProvider(modelConfig.provider);
    const sessionId = req.body.sessionId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestId = `AGENT-${sessionId.slice(-8)}`;
    const startTime = Date.now();
    const bypassTriage = req.body.bypassTriage === true;
    const triageEnabled = process.env.AGENT_TRIAGE_ENABLED !== 'false';
    const compactResults = req.body.compactResults !== undefined ? req.body.compactResults !== false : process.env.AGENT_COMPACT_RESULTS !== 'false';
    const compactHistoryEnabled = req.body.compactHistory !== undefined ? req.body.compactHistory !== false : process.env.AGENT_COMPACT_HISTORY !== 'false';
    // When the orchestrator loop exits without a natural finish (cost/latency
    // hard cap, max-rounds), fire one final tool-less LLM call to synthesize an
    // answer from the evidence already gathered. Default true; override via
    // body.synthesizeOnExit=false to preserve the legacy hard-cap behavior
    // (loop exits silently with no text emitted).
    const synthesizeOnExit = req.body.synthesizeOnExit !== undefined
      ? req.body.synthesizeOnExit !== false
      : process.env.AGENT_SYNTHESIZE_ON_EXIT !== 'false';
    // Internal-only flag driven by env. When false (default / production),
    // SSE emits are stripped of model, cost, tokens, intent, tool inputs,
    // round numbers, etc. Set AGENT_INCLUDE_METRICS=true in .env on internal
    // environments (local dev, benchmarks) to receive the full payload.
    const includeMetrics = process.env.AGENT_INCLUDE_METRICS === 'true' || req.body?.includeMetrics === true;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message (or task) is required' });
    }

    const providerReady = await providerClient.validate();
    if (!providerReady) {
      const envKeyByProvider = {
        tinfoil: 'TINFOIL_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
      };
      const envKey = envKeyByProvider[modelConfig.provider] || 'ANTHROPIC_API_KEY';
      return res.status(503).json({
        error: `${modelConfig.provider} provider is not configured or unavailable. Check ${envKey} in .env`,
      });
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

    printLog(`[${requestId}] POST ${req.path} — provider=${modelConfig.provider}, model=${modelConfig.label} (${modelKey}), profile=${profileKey}, history=${history.length}, compact=${compactResults}/${compactHistoryEnabled}, stream=${streaming}, "${message.substring(0, 100)}"`);

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
      done:        new Set(['provider', 'model', 'modelKey', 'executionProfile', 'intent', 'rounds', 'toolCalls', 'tokens', 'cost', 'latencyMs']),
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
      // Defensive sanitization for text events: strip provider-specific
      // tool-call markup (DSML, function_calls XML, etc.) before it ever
      // reaches the client. This is a safety net in case a model ignores
      // the synthesis-prompt instructions and inlines tool DSL as plaintext.
      // Any drop is logged once so we know if a model is misbehaving in prod.
      if ((eventType === 'text_delta' || eventType === 'text_done')
          && data && typeof data.text === 'string'
          && hasToolCallMarkup(data.text)) {
        const cleaned = sanitizeAgentText(data.text);
        console.warn(`[${requestId}] Stripped tool-call markup from ${eventType}: ${data.text.length} → ${cleaned.length} chars`);
        data = { ...data, text: cleaned };
      }
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
      const classifierAvailable = anthropicKeyValid;
      if (triageEnabled && !bypassTriage && classifierAvailable) {
        const result = await classifyIntent(message, history);
        intent = result.intent;
        classifierTokens = result.classifierTokens;
      } else {
        printLog(`[${requestId}] Triage bypassed (enabled=${triageEnabled}, bypassTriage=${bypassTriage}, classifierAvailable=${classifierAvailable})`);
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
      const costs = createCostTracker(modelConfig, executionProfile);
      const latency = createLatencyTracker(executionProfile, startTime);
      let round = 0;
      let hasExecutedTools = false;
      // Hoisted so the post-loop synthesis path can tell whether the loop
      // exited via a natural `break` (model said it was done) or via the guard
      // (cost/latency hard cap, max rounds).
      let naturalCompletion = false;
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

      while (
        round < maxToolRounds
        && !_aborted
        && costs.llm.cost < executionProfile.costBudgetHard
        && !latency.hardReached()
      ) {
        round++;
        console.log(`[${requestId}] === ROUND ${round} START === (elapsed ${latency.elapsedMs()}ms)`);

        if (hasExecutedTools) {
          emit('status', { message: 'Composing your answer...', sessionId });
        }

        const msgMetrics = measureMessages(messages);
        const systemChars = effectiveSystemPrompt.length;
        const totalInputChars = systemChars + msgMetrics.totalChars;
        printLog(`[${requestId}] Round ${round} input: system=${systemChars}c (~${Math.ceil(systemChars/4)}tok), messages=${msgMetrics.totalChars}c (user=${msgMetrics.userChars}, assistant=${msgMetrics.assistantChars}, toolResults=${msgMetrics.toolResultChars}), total=~${Math.ceil(totalInputChars/4)}tok est`);

        const response = await providerClient.createResponse({
          model: modelConfig.id,
          maxTokens: 4096,
          system: effectiveSystemPrompt,
          messages,
          tools: effectiveTools,
          aborted,
          onTextDelta: (text) => emit('text_delta', { text }),
          requestId,
        });

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
          naturalCompletion = true;
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
          const costNote = costs.budgetNote();
          const latencyNote = latency.budgetNote();
          const budgetNote = costNote === latencyNote
            ? costNote
            : Array.from(new Set([costNote, latencyNote].filter(Boolean))).join('');

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
      console.log(`[${requestId}] === LOOP EXITED === round=${round}, natural=${naturalCompletion}`);

      // --- Forced final synthesis on non-natural exit ---
      // When the loop exits via guard (cost/latency hard cap or max rounds)
      // rather than the model's own `stop_reason`, the user gets no `text_done`
      // and the request returns empty text. To avoid that, fire one last
      // tool-less LLM call so the model can synthesize from whatever evidence
      // is already in `messages` (the final user turn already carries the
      // SYSTEM "stop calling tools" marker on its tool results).
      //
      // Skipped when the user aborted (don't burn tokens for a closed connection)
      // or when synthesizeOnExit is explicitly disabled via API/env.
      let synthesisExitReason = null;
      if (!naturalCompletion && !_aborted && synthesizeOnExit) {
        synthesisExitReason = costs.llm.cost >= executionProfile.costBudgetHard
          ? 'cost_hard_cap'
          : latency.hardReached()
            ? 'latency_hard_cap'
            : round >= maxToolRounds
              ? 'max_rounds'
              : 'unknown';
        console.log(`[${requestId}] === SYNTHESIS START === reason=${synthesisExitReason}, elapsed=${latency.elapsedMs()}ms`);
        emit('status', { message: 'Composing your answer...', sessionId });

        let streamedSynthesis = '';
        try {
          // Use a synthesis-only prompt that explicitly forbids tool-call
          // markup. The default search prompt advertises tools and tells the
          // model to use them — when paired with `tools: []`, some providers
          // (DeepSeek observed in production) react by emitting their native
          // tool-call DSL as plaintext, which then leaks straight to the user.
          // The synthesis prompt overrides those rules and reasserts: write
          // plain prose, cite only what's already in evidence, no markup.
          const synthesisSystemPrompt = buildSynthesisPrompt(intent);
          const synthesisResponse = await providerClient.createResponse({
            model: modelConfig.id,
            maxTokens: 2048,
            system: synthesisSystemPrompt,
            messages,
            // Empty tools → providers skip the `tools`/`tool_choice` fields,
            // forcing the model to produce text only.
            tools: [],
            aborted,
            onTextDelta: (text) => {
              streamedSynthesis += text;
              emit('text_delta', { text });
            },
            requestId,
          });

          costs.addLlmUsage(
            synthesisResponse.usage?.input_tokens || 0,
            synthesisResponse.usage?.output_tokens || 0,
          );

          // Some providers (e.g. DeepSeek non-streaming) don't fire onTextDelta;
          // pull the text off the content blocks and emit it as one delta so
          // streaming clients still see it before text_done.
          const blocksText = (synthesisResponse.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');
          if (!streamedSynthesis && blocksText) {
            streamedSynthesis = blocksText;
            emit('text_delta', { text: blocksText });
          }

          if (streamedSynthesis.length > 0) {
            accumulatedTextByRound.push({ round: round + 1, text: streamedSynthesis });
          }
          agentLog.rounds.push({
            round: round + 1,
            type: 'synthesis',
            tokens: synthesisResponse.usage,
            reason: synthesisExitReason,
          });

          const fullText = accumulatedTextByRound.map(r => r.text).join('\n\n');
          agentLog.finalText = fullText;
          emit('text_done', { text: fullText });
          console.log(`[${requestId}] === SYNTHESIS DONE === ${streamedSynthesis.length} chars synthesized, ${fullText.length} total`);
        } catch (err) {
          console.error(`[${requestId}] === SYNTHESIS FAILED === ${err.message}`);
          // Best-effort: emit any accumulated intermediate text so the user
          // gets *something* rather than an empty response.
          if (accumulatedTextByRound.length > 0) {
            const fallback = accumulatedTextByRound.map(r => r.text).join('\n\n');
            agentLog.finalText = fallback;
            emit('text_done', { text: fallback });
          }
        }
      }

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
        naturalCompletion,
        synthesisExitReason,
      };
      writeAgentLog(requestId, sessionId, agentLog);

      // Auto-upsell: surface untranscribed episodes from discover results the agent didn't suggest.
      // Before emitting, run each candidate through a tiered relevance filter
      // (language + token overlap, then optional gpt-4o-mini batch classification)
      // to avoid surfacing irrelevant shows (e.g. a Spanish-language podcast for an English query).
      const AUTO_UPSELL_MAX = 2;
      let autoUpsellEmitted = 0;
      let autoUpsellAttempted = 0;
      let autoUpsellDropped = 0;
      let autoUpsellDeduped = 0;

      const allCandidates = [];
      for (const feed of discoverResults) {
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
          allCandidates.push({ feed, episode: ep, feedFallback });
        }
      }

      let filterResult = {
        approved: allCandidates,
        totalCandidates: allCandidates.length,
        filteredByLang: 0,
        filteredByOverlap: 0,
        filteredByLLM: 0,
        llmSkipped: true,
        llmReason: 'no-candidates',
        latencyMs: 0,
      };
      if (allCandidates.length > 0) {
        filterResult = await filterUpsellCandidates({
          query: message,
          candidates: allCandidates,
          openai,
          requestId,
        });
      }

      for (const cand of filterResult.approved) {
        if (autoUpsellEmitted >= AUTO_UPSELL_MAX) break;
        autoUpsellAttempted++;
        const feed = cand.feed || {};
        const ep = cand.episode || {};
        const result = emitSubmitOnDemand(
          {
            reason: `${feed.title || 'This show'} has untranscribed episodes that may be relevant.`,
            guid: ep.guid || null,
            feedGuid: ep.feedGuid || null,
            feedId: ep.feedId != null ? String(ep.feedId) : null,
            episodeTitle: ep.title || null,
            image: ep.image || null,
          },
          { emit, episodeCache, suggestedGuids, requestId, feedFallback: cand.feedFallback, origin: 'auto-upsell' },
        );
        if (result.emitted) autoUpsellEmitted++;
        else if (result.reason === 'dedup') autoUpsellDeduped++;
        else autoUpsellDropped++;
      }

      const anyFilterActivity = filterResult.filteredByLang || filterResult.filteredByOverlap || filterResult.filteredByLLM;
      if (autoUpsellAttempted > 0 || anyFilterActivity) {
        console.log(
          `[${requestId}] Auto-upsell summary: ` +
          `totalCandidates=${filterResult.totalCandidates} ` +
          `filteredByLang=${filterResult.filteredByLang} ` +
          `filteredByOverlap=${filterResult.filteredByOverlap} ` +
          `filteredByLLM=${filterResult.filteredByLLM} ` +
          `approved=${filterResult.approved.length} ` +
          `attempted=${autoUpsellAttempted} emitted=${autoUpsellEmitted} ` +
          `dropped=${autoUpsellDropped} deduped=${autoUpsellDeduped} ` +
          `llmSkipped=${filterResult.llmSkipped}${filterResult.llmReason ? `(${filterResult.llmReason})` : ''} ` +
          `filterMs=${filterResult.latencyMs} ` +
          `(max=${AUTO_UPSELL_MAX}, from ${discoverResults.length} discover feed(s))`
        );
      } else if (discoverResults.length > 0) {
        console.log(`[${requestId}] Auto-upsell: 0 candidates from ${discoverResults.length} discover feed(s) — no untranscribed matchedEpisodes`);
      }

      emit('done', {
        sessionId,
        provider: modelConfig.provider,
        model: modelConfig.label,
        modelKey,
        executionProfile: profileKey,
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
        naturalCompletion,
        synthesisExitReason,
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
            provider: modelConfig.provider,
            model: modelConfig.label,
            modelKey,
            executionProfile: profileKey,
            intent,
            rounds: round,
            toolCalls: buffered.toolCalls,
            tokens: { input: costs.llm.inputTokens, output: costs.llm.outputTokens },
            cost: { claude: claudeCost, tools: toolCost, total: totalCost },
            latencyMs,
            naturalCompletion,
            synthesisExitReason,
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
