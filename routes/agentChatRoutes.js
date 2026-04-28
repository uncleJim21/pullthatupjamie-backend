const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { printLog } = require('../constants.js');
const {
  SYSTEM_PROMPT,
  TOOL_DEFINITIONS,
  buildSynthesisPrompt,
  buildStrictSynthesisPrompt,
  TIER3_FALLBACK_MESSAGE,
} = require('../setup-agent');
const { PROFILES, VALID_INTENTS, DEFAULT_INTENT, CLASSIFIER_PROMPT } = require('../setup-agent-profiles');
const { resolveModelSelection, AGENT_MODELS, HELPER_LLM_PRICES } = require('../constants/agentModels');
const { executeAgentTool } = require('../utils/agentToolHandler');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { filterUpsellCandidates } = require('../utils/upsellRelevance');
const { createProvider } = require('../utils/agent/providers');
const { sanitizeAgentText, hasToolCallMarkup } = require('../utils/agent/sanitizeOutput');
const { evaluateSynthesisOutput } = require('../utils/agent/synthesisQuality');

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
 *
 * Tracks ONLY external paid API spend:
 *   - llm:     the orchestrator model (DeepSeek / Haiku / Sonnet / etc.)
 *   - helpers: small helper LLMs and embeddings invoked from within tool
 *              execution + classifier + Tier 2 fallback (gpt-4o-mini reranker
 *              + expansion, text-embedding-ada-002, Haiku classifier, Haiku
 *              fallback). Each call resolves its model through HELPER_LLM_PRICES.
 *   - tools:   call counter only. Internal infra (Pinecone, MongoDB, Atlas,
 *              etc.) is $0 marginal and intentionally NOT priced — earlier
 *              flat per-tool fees were a fiction that polluted the dollar
 *              total. Kept as a counter so we still know how many tools fired.
 *
 * `total` = llm.cost + helpers.cost. Internal infra contributes nothing.
 */
function createCostTracker(modelConfig, executionProfile) {
  const costBudgetSoft = executionProfile?.costBudgetSoft ?? 0.055;
  const costBudgetHard = executionProfile?.costBudgetHard ?? 0.08;
  const tracker = {
    llm:     { inputTokens: 0, outputTokens: 0, cost: 0, modelKey: modelConfig?.key, modelLabel: modelConfig?.label },
    helpers: { calls: 0, cost: 0, byModel: {} },
    tools:   { calls: 0 },
    get total() { return this.llm.cost + this.helpers.cost; },

    addLlmUsage(inputTokens, outputTokens) {
      this.llm.inputTokens += inputTokens;
      this.llm.outputTokens += outputTokens;
      this.llm.cost = (this.llm.inputTokens * modelConfig.inputPer1M / 1_000_000)
                    + (this.llm.outputTokens * modelConfig.outputPer1M / 1_000_000);
    },

    /**
     * Record usage for a helper LLM / embedding call (e.g. gpt-4o-mini
     * reranker, text-embedding-ada-002, Haiku classifier). Resolves price via
     * HELPER_LLM_PRICES; unknown models still increment the call counter so
     * we can spot omissions, but their cost is recorded as 0 (with a warning
     * log so we don't silently miss new helper additions).
     */
    addHelperLlmUsage(modelId, inputTokens, outputTokens) {
      const price = HELPER_LLM_PRICES[modelId];
      const safeInput = Number.isFinite(inputTokens) ? inputTokens : 0;
      const safeOutput = Number.isFinite(outputTokens) ? outputTokens : 0;
      let callCost = 0;
      if (price) {
        callCost = (safeInput * price.inputPer1M / 1_000_000)
                 + (safeOutput * price.outputPer1M / 1_000_000);
      } else if (modelId) {
        printLog(`[CostTracker] No HELPER_LLM_PRICES entry for "${modelId}" — recording call but charging $0 (add to constants/agentModels.js if this is a paid model)`);
      }
      this.helpers.calls++;
      this.helpers.cost += callCost;
      const key = modelId || 'unknown';
      const entry = this.helpers.byModel[key] || (this.helpers.byModel[key] = {
        calls: 0, inputTokens: 0, outputTokens: 0, cost: 0,
      });
      entry.calls++;
      entry.inputTokens += safeInput;
      entry.outputTokens += safeOutput;
      entry.cost += callCost;
    },

    addToolCall(_toolName) {
      // Counter only. See class doc — internal infra is $0 marginal and
      // contributes nothing to `total`.
      this.tools.calls++;
    },

    budgetNote() {
      // Budget is now the total real out-of-pocket spend (orchestrator + helpers).
      const spend = this.total;
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
      const helpersByModel = {};
      for (const [k, v] of Object.entries(this.helpers.byModel)) {
        helpersByModel[k] = {
          calls: v.calls,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
          cost: parseFloat(v.cost.toFixed(6)),
        };
      }
      return {
        // Legacy field name preserved for log compatibility — semantically
        // this is the orchestrator model's cost (whatever modelConfig was).
        claude: parseFloat(this.llm.cost.toFixed(6)),
        llm: {
          modelKey: this.llm.modelKey,
          modelLabel: this.llm.modelLabel,
          inputTokens: this.llm.inputTokens,
          outputTokens: this.llm.outputTokens,
          cost: parseFloat(this.llm.cost.toFixed(6)),
        },
        helpers: {
          calls: this.helpers.calls,
          cost: parseFloat(this.helpers.cost.toFixed(6)),
          byModel: helpersByModel,
        },
        // Legacy field name. Now $0 by design — kept so existing dashboards
        // / log parsers don't break. `tools.calls` is the real number.
        tools: 0,
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
    /**
     * Always-on time-budget header for the per-round system prompt. Lets the
     * model self-pace tool exploration vs. answer composition without waiting
     * for the soft/hard markers to fire (which is too late — by hard cap
     * we've already lost the round to forced synthesis).
     *
     * Wording is action-oriented: "you have N seconds, narrow now" rather
     * than "elapsed Xs of Ys" so the model gets a directive, not just data.
     */
    budgetHeader() {
      const elapsed = this.elapsedMs();
      const remainingSoft = Math.max(0, softMs - elapsed);
      const remainingHard = Math.max(0, hardMs - elapsed);
      const elapsedPct = Math.min(100, Math.round((elapsed / hardMs) * 100));
      let directive;
      if (elapsed > hardMs) {
        directive = 'STOP calling tools. Synthesize from existing evidence on the next response.';
      } else if (elapsed > softMs) {
        directive = 'WRAP UP. One focused tool call at most, then synthesize. Do not start a new line of investigation.';
      } else if (elapsedPct >= 50) {
        directive = 'NARROW. You should be confirming details now, not opening new threads. Prefer at most 1 more tool call before synthesizing.';
      } else if (elapsedPct >= 25) {
        directive = 'FOCUS. Pick the single most informative next call. Avoid wide adjacent-paragraph windows (windowSize > 5 burns budget fast).';
      } else {
        directive = 'EXPLORE freely; you have plenty of budget.';
      }
      return [
        '',
        '## TIME BUDGET (real-time, updated each round)',
        `Elapsed ${(elapsed/1000).toFixed(1)}s of ${(hardMs/1000).toFixed(0)}s hard cap (${elapsedPct}% used). ${(remainingSoft/1000).toFixed(1)}s until soft wrap-up nudge, ${(remainingHard/1000).toFixed(1)}s until forced synthesis.`,
        `Directive: ${directive}`,
        'After the hard cap fires, you do NOT get to write a long answer — synthesis runs on a tight 15s budget and will truncate mid-sentence if you leave it nothing to work with.',
        'Do not mention this budget, the elapsed time, or any limit to the user.',
        '',
      ].join('\n');
    },
    /**
     * Recommend a synthesis output size given remaining time. Used when the
     * orchestrator builds the synthesis-pass system prompt so the model can
     * scale its answer to whatever budget is actually available.
     *
     * Targets are deliberately conservative — observed in the 41-query
     * regression: model overshoots length guidance by ~30% on average
     * (told 600, writes 800) and gets cut by the synthesis deadline mid-
     * sentence. Asking for 350 words with the goal of getting 450
     * actually leaves ~10-15% safety margin for the tail to land on a
     * terminal sentence.
     */
    synthesisGuidance(synthesisBudgetMs) {
      const budget = Number.isFinite(synthesisBudgetMs) ? synthesisBudgetMs : 15_000;
      if (budget >= 12_000) {
        return { lengthHint: '300-450 words, 2-4 clip citations', urgency: 'normal' };
      }
      if (budget >= 8_000) {
        return { lengthHint: '200-320 words, 2-3 clip citations', urgency: 'tight' };
      }
      return { lengthHint: '100-180 words, 1-2 clip citations — prioritize completeness over depth, NEVER end mid-sentence', urgency: 'urgent' };
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

// Per-tool result-count map. Each handler in utils/agentToolHandler.js returns a
// distinct shape; deriving the count by sniffing field names (e.g. result.results,
// result.chapters) is fragile and silently maps to 0 when a tool's array key
// doesn't match any branch (search_chapters returns its array at `result.data`,
// which previously fell through every branch and reported 0 results in the SSE
// `tool_result` event even when 10 chapters were found).
function computeToolResultCount(toolName, result) {
  if (!result || typeof result !== 'object') return 0;
  switch (toolName) {
    case 'search_quotes':
    case 'discover_podcasts':
      return result.results?.length || 0;

    case 'search_chapters':
      return result.data?.length || 0;

    case 'find_person':
      return (result.people?.length || 0) + (result.hostedFeeds?.length || 0);

    case 'get_person_episodes':
    case 'get_feed_episodes':
      return result.episodes?.length || 0;

    case 'list_episode_chapters':
      return result.chapters?.length || 0;

    case 'get_episode':
      return result.episode ? 1 : 0;

    case 'get_feed':
      return result.feed ? 1 : 0;

    case 'get_adjacent_paragraphs':
      return (result.before?.length || 0)
        + (result.current ? 1 : 0)
        + (result.after?.length || 0);

    case 'create_research_session':
      return result.sessionId ? (result.itemCount || 1) : 0;

    case 'suggest_action':
      return result.action ? 1 : 0;

    default:
      return 0;
  }
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

/**
 * Strip provider-private content blocks from assistant messages so the
 * conversation can be safely forwarded to Anthropic in the Tier 2
 * cross-provider re-synthesis step.
 *
 * Why: when the primary provider is DeepSeek (or anything with a private
 * reasoning channel), assistant turns may contain blocks like
 *   { type: 'thinking', text: '...' }
 * which are *not* Anthropic-native — Anthropic's `thinking` block requires
 * a `thinking` field (plus a `signature`), and unknown types 400 the
 * request. We keep only the Anthropic-supported block shapes:
 *   - text:        { type: 'text', text: string }
 *   - tool_use:    { type: 'tool_use', id, name, input }
 *   - tool_result: { type: 'tool_result', tool_use_id, content } (user role)
 * String-content messages pass through unchanged.
 */
function sanitizeMessagesForAnthropic(messages) {
  if (!Array.isArray(messages)) return messages;
  const ALLOWED_ASSISTANT_TYPES = new Set(['text', 'tool_use']);
  const ALLOWED_USER_TYPES = new Set(['text', 'tool_result', 'image']);

  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg;
    if (typeof msg.content === 'string') return msg;
    if (!Array.isArray(msg.content)) return msg;

    const allowed = msg.role === 'assistant' ? ALLOWED_ASSISTANT_TYPES : ALLOWED_USER_TYPES;
    const cleanContent = msg.content.filter(block => block && allowed.has(block.type));

    // Anthropic rejects assistant turns with empty content arrays. If we
    // stripped everything (e.g. a turn that was only a thinking block),
    // replace with a placeholder text block so the conversation stays valid.
    if (msg.role === 'assistant' && cleanContent.length === 0) {
      return { role: 'assistant', content: [{ type: 'text', text: '[reasoning omitted]' }] };
    }

    return { ...msg, content: cleanContent };
  });
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
    //   4. Default true (defensive fallback; today the only entry point is the
    //      internal /agent dispatch from /api/pull, which sets _defaultStream
    //      = false so JSON wins unless the caller opts into SSE explicitly)
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
    //
    // NOTE: tool_call.input / tool_call.round / tool_result.resultCount /
    // tool_result.latencyMs / tool_result.round are NOT stripped — the
    // frontend uses them for subtitle rendering ("Searching defense tech..."),
    // result-count chips ("[7 results]"), and round-keyed call/result
    // matching in multi-round runs. These match the OpenAPI spec for these
    // events. Only `status.intent` and the rich `done` summary remain gated
    // (those are genuine internal telemetry).
    const INTERNAL_FIELDS = {
      status: new Set(['intent']),
      done:   new Set(['provider', 'model', 'modelKey', 'executionProfile', 'intent', 'rounds', 'toolCalls', 'tokens', 'cost', 'latencyMs']),
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
      // Classifier (Haiku) ran before the cost tracker existed, so backfill its
      // usage now that we have the channel.
      if (classifierTokens) {
        costs.addHelperLlmUsage(
          CLASSIFIER_MODEL,
          classifierTokens.input_tokens || 0,
          classifierTokens.output_tokens || 0,
        );
      }
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

      // Per-session ceiling on `get_adjacent_paragraphs`. Rationale: the
      // 2026-04-27 regression (e.g. "PayPal Mafia members" query) showed
      // DeepSeek over-pulling adjacent context — 7 calls in a single
      // session — and burning the latency budget before producing prose.
      // The cap is a hard ceiling that doesn't depend on prompt
      // compliance: once exhausted, calls return a "blocked" stub instead
      // of executing, which both saves time and signals to the model to
      // synthesize. Most clean queries used 0-3 expansions, so 4 is
      // generous; tune via env if needed.
      const adjacentParagraphCap = parseInt(process.env.AGENT_ADJACENT_PARAGRAPHS_CAP || '4', 10);
      let adjacentParagraphCount = 0;

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

        // Belt-and-suspenders for the latency soft/hard cap nudge.
        // `latency.budgetNote()` is already appended to every tool_result
        // content (see ~30 lines down), but burying it inside JSON-ish
        // tool-result payloads gives it weak attention weight on some
        // models (DeepSeek under pressure observed ignoring it).
        // Mirroring the same SYSTEM marker into the system prompt for the
        // round costs nothing for clean queries (note is empty until soft
        // cap is reached) and surfaces it in a higher-priority slot when
        // it matters.
        //
        // budgetHeader() is the *proactive* complement to budgetNote():
        // always-on real-time elapsed/remaining + a directive scaled to
        // current usage (EXPLORE / FOCUS / NARROW / WRAP UP / STOP). Lets
        // the model self-pace tool exploration before the soft cap fires
        // — without it, the model has no time signal until 25s in, by
        // which point it can't course-correct. Failure case it prevents:
        // model burns the whole 40s budget on wide adjacent_paragraphs
        // calls, then synthesis runs on 15s and truncates mid-sentence.
        const roundSystemPrompt = effectiveSystemPrompt + latency.budgetHeader() + latency.budgetNote();

        const response = await providerClient.createResponse({
          model: modelConfig.id,
          maxTokens: 4096,
          system: roundSystemPrompt,
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

        // ---- Parallel tool execution within a single round ----
        // The LLM emits multiple tool_use blocks per response intending them as
        // parallel work. We run them concurrently with Promise.all to avoid the
        // serialization tax (e.g. 9 search_quotes × 3s sequential = 27s vs ~4s
        // wall when parallelized). All shared-state mutation (clipCache,
        // discoverResults, episodeCache, toolCalls, toolResults, costs) is
        // applied *after* the gather, in input order, so emit/log ordering and
        // cost/latency bookkeeping stay deterministic.
        //
        // Pre-emit `tool_call` events synchronously so the UI can show all
        // tools as "in flight" before any await. Each handler still wraps its
        // own try/catch and resolves to a result object — Promise.all is safe
        // (no rejecting paths).

        // Decide adjacent-paragraph blocking up front to preserve cap semantics
        // under parallel execution. If the round contains more get_adjacent_paragraphs
        // calls than remaining slots, the overflow gets a blocked stub.
        const apBlocked = new Set();
        let apSlotsRemaining = Math.max(0, adjacentParagraphCap - adjacentParagraphCount);
        for (let i = 0; i < toolUseBlocks.length; i++) {
          if (toolUseBlocks[i].name !== 'get_adjacent_paragraphs') continue;
          if (apSlotsRemaining > 0) {
            apSlotsRemaining--;
            adjacentParagraphCount++;
          } else {
            apBlocked.add(i);
          }
        }

        for (const toolUse of toolUseBlocks) {
          console.log(`[${requestId}] Executing tool: ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 150)})`);
          emit('tool_call', {
            tool: toolUse.name,
            input: toolUse.input,
            round,
          });
        }

        // Bound to this request's cost tracker. Helpers (reranker, embedding,
        // proper-noun expansion) call into this so their real spend lands in
        // the same `helpers` channel as the classifier and Tier 2 fallback.
        const recordHelperLlmUsage = (modelId, inputTokens, outputTokens) => {
          costs.addHelperLlmUsage(modelId, inputTokens || 0, outputTokens || 0);
        };

        const settled = await Promise.all(toolUseBlocks.map(async (toolUse, i) => {
          const toolStart = Date.now();
          let result;
          try {
            if (toolUse.name === 'suggest_action') {
              result = handleSuggestAction(toolUse.input, emit, { episodeCache, suggestedGuids, requestId });
            } else if (toolUse.name === 'create_research_session') {
              result = await executeAgentTool(toolUse.name, toolUse.input, { openai, sessionId, req, clipCache, recordHelperLlmUsage });
              if (result.sessionId && result.url) {
                emit('session_created', { sessionId: result.sessionId, url: result.url, itemCount: result.itemCount });
              }
            } else if (apBlocked.has(i)) {
              // Hard ceiling reached. Return a blocked stub instead of executing —
              // saves real time on the upstream call and (more importantly) gives
              // the model an explicit signal that it has enough context and
              // should synthesize. See `adjacentParagraphCap` declaration above
              // for rationale.
              result = {
                blocked: true,
                reason: `Adjacent-paragraph budget exhausted (${adjacentParagraphCount}/${adjacentParagraphCap}). Stop expanding context — synthesize the answer from the search_quotes results you already have.`,
              };
              console.log(`[${requestId}] get_adjacent_paragraphs BLOCKED — cap ${adjacentParagraphCap} reached`);
            } else {
              result = await executeAgentTool(toolUse.name, toolUse.input, { openai, sessionId, req, clipCache, recordHelperLlmUsage });
            }
          } catch (toolErr) {
            printLog(`[${requestId}] Tool ${toolUse.name} exception (recovered for LLM): ${toolErr.message}`);
            result = {
              error: String(toolErr.message || toolErr),
              toolExecutionFailed: true,
              hint: 'Fix tool arguments or try another tool. If this was search_quotes, ensure `query` is a non-empty string.',
            };
          }
          return { toolUse, result, toolLatency: Date.now() - toolStart };
        }));

        // Process settled results in input order: preserves emit order, log
        // ordering, cache writes, and the toolCalls ↔ toolResults alignment
        // that the agentLog round entry below depends on.
        for (const { toolUse, result, toolLatency } of settled) {
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

          const resultCount = computeToolResultCount(toolUse.name, result);
          // `_meta` is a side-channel populated by some handlers (currently
          // search_quotes) describing what actually happened internally —
          // lexical vs vector hits, expansion variants, reranker stats, etc.
          // Surface it on the SSE event so the UI can render the real
          // breakdown instead of a single generic "Searching quotes" line,
          // then strip it from the result so the LLM never sees it (it's
          // visible-only telemetry, not search content).
          const resultMeta = result && typeof result === 'object' ? result._meta : null;
          if (result && typeof result === 'object' && '_meta' in result) {
            delete result._meta;
          }
          const resultSize = JSON.stringify(result).length;
          console.log(`[${requestId}] Tool ${toolUse.name}: ${resultCount} results, ${resultSize} chars JSON, ${toolLatency}ms`);

          emit('tool_result', {
            tool: toolUse.name,
            resultCount,
            latencyMs: toolLatency,
            round,
            ...(resultMeta ? { meta: resultMeta } : {}),
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

        // Bound the synthesis call by its own short deadline. By the time we
        // get here we already have all the tool results in `messages` —
        // synthesis is just composing prose, it should not run another 25s
        // and blow past the latency hard cap. Default 15s, env-overridable.
        // The deadline is enforced two ways:
        //   1. Wrapped `aborted` predicate that streaming providers check
        //      per chunk, so partial text already streamed to the client is
        //      preserved and the loop exits cleanly.
        //   2. `timeoutMs` passed to the provider, which becomes the fetch's
        //      AbortController timeout, killing non-streaming or hung calls.
        // DIAGNOSTIC (2026-04-28): default raised from 15s to 300s so primary
        // synthesis always runs to completion when measuring true wall-clock
        // performance under unbounded loop budgets. Bring this back to ~15s
        // once we have baselines and have decided on per-intent budgets.
        const synthesisBudgetMs = parseInt(process.env.AGENT_SYNTHESIS_BUDGET_MS || '300000', 10);
        const synthesisDeadlineMs = Date.now() + synthesisBudgetMs;
        const synthesisAborted = () => _aborted || Date.now() >= synthesisDeadlineMs;

        // Build size guidance for the synthesis pass. The model can scale
        // its own output ("write 200 words" vs "write 500 words") if you
        // tell it explicitly — without this, it defaults to the verbose
        // response-format spec and runs past the synthesis deadline mid-
        // sentence on tight budgets. See latency.synthesisGuidance for
        // the elapsed → length-target mapping.
        const synthesisGuidance = latency.synthesisGuidance(synthesisBudgetMs);
        console.log(`[${requestId}] Synthesis guidance: ${synthesisGuidance.urgency} (${synthesisGuidance.lengthHint})`);

        let streamedSynthesis = '';
        let primaryOutputTokens = 0;
        let primarySynthesisError = null;
        try {
          // Use a synthesis-only prompt that explicitly forbids tool-call
          // markup. The default search prompt advertises tools and tells the
          // model to use them — when paired with `tools: []`, some providers
          // (DeepSeek observed in production) react by emitting their native
          // tool-call DSL as plaintext, which then leaks straight to the user.
          // The synthesis prompt overrides those rules and reasserts: write
          // plain prose, cite only what's already in evidence, no markup.
          //
          // Belt-and-suspenders: in addition to the prompt, we keep the
          // tool schemas attached and pass `toolChoice: 'none'`. DeepSeek's
          // documented behavior is that 'none' explicitly forbids tool
          // invocation while keeping the request shape consistent with
          // earlier rounds — empirically critical to stop it from inlining
          // its native DSML tool-call markup. See docs/AGENT_SYNTHESIS_PASS.md.
          const synthesisSystemPrompt = buildSynthesisPrompt(intent, synthesisGuidance);
          const synthesisResponse = await providerClient.createResponse({
            model: modelConfig.id,
            maxTokens: parseInt(process.env.AGENT_SYNTHESIS_MAX_TOKENS || '4096', 10),
            system: synthesisSystemPrompt,
            messages,
            tools: effectiveTools,
            toolChoice: 'none',
            aborted: synthesisAborted,
            timeoutMs: synthesisBudgetMs,
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
          primaryOutputTokens = synthesisResponse.usage?.output_tokens || 0;

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

          agentLog.rounds.push({
            round: round + 1,
            type: 'synthesis',
            tokens: synthesisResponse.usage,
            reason: synthesisExitReason,
          });
        } catch (err) {
          primarySynthesisError = err;
          console.error(`[${requestId}] === SYNTHESIS FAILED === ${err.message}`);
        }

        // ===== Synthesis quality gate + Tier 1/2/3 recovery =====
        //
        // The primary synthesis above streams text_delta events live to the
        // client. If the result is unusable (DSML markup, narration-only
        // preamble, mid-token truncation, suspiciously short), we run up to
        // two recovery passes and then fall back to a hardcoded apology.
        // Recovery passes are silent (no text_delta) so the canonical
        // `text_done` payload is what matters for clients that re-render on
        // text_done. See docs/WIP/SYNTHESIS_FAILURE_RECOVERY_PLAN.md.
        const sanitizedPrimary = sanitizeAgentText(streamedSynthesis);

        // When primary synthesis throws (typically the synthesis-budget
        // timeout firing mid-stream), we may still have substantial clean
        // prose already streamed to the client. Re-running synthesis with
        // an even tighter budget will almost certainly time out again, so
        // skip recovery if the streamed text is content-clean. We pass
        // outputTokens: undefined so the low-tokens gate is suppressed
        // (we never got a final usage block), and rely on the content
        // checks (markup / narration / truncation / empty) to flag bad
        // partial streams.
        const primaryQuality = primarySynthesisError
          ? evaluateSynthesisOutput({ text: sanitizedPrimary, outputTokens: undefined })
          : evaluateSynthesisOutput({ text: sanitizedPrimary, outputTokens: primaryOutputTokens });

        // Annotate the trigger for observability when an exception happened
        // *and* the text failed content checks (the worst-of-both case).
        if (primarySynthesisError && !primaryQuality.ok) {
          primaryQuality.trigger = `exception+${primaryQuality.trigger}`;
          primaryQuality.reason = `${primarySynthesisError.message} | ${primaryQuality.reason}`;
        }

        let finalSynthText = sanitizedPrimary;
        const recoveryRecord = primaryQuality.ok ? null : {
          primary: {
            trigger: primaryQuality.trigger,
            reason: primaryQuality.reason,
            outputTokens: primaryOutputTokens,
            textLen: sanitizedPrimary.length,
          },
        };

        if (!primaryQuality.ok) {
          console.log(`[${requestId}] Synthesis quality FAILED: trigger=${primaryQuality.trigger}, reason=${primaryQuality.reason}, tokens=${primaryOutputTokens}, len=${sanitizedPrimary.length}`);
          emit('status', { message: 'Refining your answer...', sessionId });

          // ===== Tier 1: strict re-synthesis on the same provider =====
          // Same model, hardened prompt, temperature: 0 for determinism,
          // halved time budget, tool_choice still 'none'. Silent — no
          // text_delta emits, just collect text and evaluate.
          const tier1Start = Date.now();
          const tier1Budget = Math.max(5000, Math.floor(synthesisBudgetMs / 2));
          const tier1Deadline = Date.now() + tier1Budget;
          const tier1Aborted = () => _aborted || Date.now() >= tier1Deadline;
          // Recovery passes always run on a halved budget — flag them
          // 'urgent' so the model picks the shortest length target and is
          // explicitly told to never end mid-sentence.
          const tier1Guidance = latency.synthesisGuidance(tier1Budget);
          let tier1Text = '';
          let tier1OutputTokens = 0;
          let tier1Error = null;
          try {
            const tier1Resp = await providerClient.createResponse({
              model: modelConfig.id,
              maxTokens: parseInt(process.env.AGENT_SYNTHESIS_MAX_TOKENS || '4096', 10),
              system: buildStrictSynthesisPrompt(intent, tier1Guidance),
              messages,
              tools: effectiveTools,
              toolChoice: 'none',
              temperature: 0,
              aborted: tier1Aborted,
              timeoutMs: tier1Budget,
              onTextDelta: () => { /* silent */ },
              requestId,
            });
            costs.addLlmUsage(
              tier1Resp.usage?.input_tokens || 0,
              tier1Resp.usage?.output_tokens || 0,
            );
            tier1OutputTokens = tier1Resp.usage?.output_tokens || 0;
            tier1Text = sanitizeAgentText(
              (tier1Resp.content || [])
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('')
            );
          } catch (err) {
            tier1Error = err;
            console.error(`[${requestId}] Tier 1 re-synthesis FAILED: ${err.message}`);
          }
          const tier1Quality = tier1Error
            ? { ok: false, trigger: 'exception', reason: tier1Error.message }
            : evaluateSynthesisOutput({ text: tier1Text, outputTokens: tier1OutputTokens });
          recoveryRecord.tier1 = {
            ok: tier1Quality.ok,
            trigger: tier1Quality.trigger || null,
            reason: tier1Quality.reason || null,
            outputTokens: tier1OutputTokens,
            textLen: tier1Text.length,
            elapsedMs: Date.now() - tier1Start,
            model: modelConfig.id,
          };
          agentLog.rounds.push({
            round: round + 1,
            type: 'synthesis_tier1',
            ok: tier1Quality.ok,
            trigger: tier1Quality.trigger || null,
            outputTokens: tier1OutputTokens,
            elapsedMs: Date.now() - tier1Start,
          });

          if (tier1Quality.ok) {
            console.log(`[${requestId}] Tier 1 recovered: ${tier1Text.length} chars, ${tier1OutputTokens} tokens, ${Date.now() - tier1Start}ms`);
            finalSynthText = tier1Text;
          } else {
            console.log(`[${requestId}] Tier 1 also failed: trigger=${tier1Quality.trigger}, reason=${tier1Quality.reason}. Trying Tier 2 (Haiku).`);
            emit('status', { message: 'Trying a different model...', sessionId });

            // ===== Tier 2: cross-provider re-synthesis on Anthropic Haiku =====
            // Different model family, different tool DSL — sidesteps
            // DeepSeek-specific failure modes (DSML leaks, narration). Same
            // strict prompt. Silent.
            //
            // Conversation-format note: when the primary provider is DeepSeek
            // (or any model that emits private reasoning blocks), the
            // assistant turns in `messages` may contain content blocks of
            // type 'thinking' shaped for that provider. Anthropic's API
            // rejects those with `messages.N.content.M.thinking.thinking:
            // Field required`. Strip non-Anthropic-native blocks before
            // forwarding so the cross-provider call doesn't 400 out.
            const tier2Messages = sanitizeMessagesForAnthropic(messages);
            const tier2Start = Date.now();
            const tier2Budget = Math.max(5000, Math.floor(synthesisBudgetMs / 2));
            const tier2Deadline = Date.now() + tier2Budget;
            const tier2Aborted = () => _aborted || Date.now() >= tier2Deadline;
            const tier2Guidance = latency.synthesisGuidance(tier2Budget);
            let tier2Text = '';
            let tier2OutputTokens = 0;
            let tier2Error = null;
            const haikuConfig = AGENT_MODELS.fast;
            try {
              const haikuClient = createProvider(haikuConfig.provider);
              const haikuReady = await haikuClient.validate();
              if (!haikuReady) {
                throw new Error(`Haiku provider (${haikuConfig.provider}) not configured — missing API key`);
              }
              const tier2Resp = await haikuClient.createResponse({
                model: haikuConfig.id,
                maxTokens: parseInt(process.env.AGENT_SYNTHESIS_MAX_TOKENS || '4096', 10),
                system: buildStrictSynthesisPrompt(intent, tier2Guidance),
                messages: tier2Messages,
                tools: effectiveTools,
                toolChoice: 'none',
                temperature: 0,
                aborted: tier2Aborted,
                onTextDelta: () => { /* silent */ },
                requestId,
              });
              // Tier 2 runs on Haiku, NOT the orchestrator model. Bill it
              // against the helpers channel at Haiku rates so the dollar
              // total reflects what actually leaves our account. (Previously
              // this used addLlmUsage which incorrectly priced Haiku tokens
              // at the orchestrator's per-1M rate.)
              costs.addHelperLlmUsage(
                haikuConfig.id,
                tier2Resp.usage?.input_tokens || 0,
                tier2Resp.usage?.output_tokens || 0,
              );
              tier2OutputTokens = tier2Resp.usage?.output_tokens || 0;
              tier2Text = sanitizeAgentText(
                (tier2Resp.content || [])
                  .filter(b => b.type === 'text')
                  .map(b => b.text)
                  .join('')
              );
            } catch (err) {
              tier2Error = err;
              console.error(`[${requestId}] Tier 2 cross-provider FAILED: ${err.message}`);
            }
            const tier2Quality = tier2Error
              ? { ok: false, trigger: 'exception', reason: tier2Error.message }
              : evaluateSynthesisOutput({ text: tier2Text, outputTokens: tier2OutputTokens });
            recoveryRecord.tier2 = {
              ok: tier2Quality.ok,
              trigger: tier2Quality.trigger || null,
              reason: tier2Quality.reason || null,
              outputTokens: tier2OutputTokens,
              textLen: tier2Text.length,
              elapsedMs: Date.now() - tier2Start,
              model: haikuConfig.id,
              provider: haikuConfig.provider,
            };
            agentLog.rounds.push({
              round: round + 1,
              type: 'synthesis_tier2',
              ok: tier2Quality.ok,
              trigger: tier2Quality.trigger || null,
              outputTokens: tier2OutputTokens,
              elapsedMs: Date.now() - tier2Start,
              model: haikuConfig.id,
            });

            if (tier2Quality.ok) {
              console.log(`[${requestId}] Tier 2 recovered (${haikuConfig.id}): ${tier2Text.length} chars, ${tier2OutputTokens} tokens, ${Date.now() - tier2Start}ms`);
              finalSynthText = tier2Text;
            } else {
              // ===== Tier 3: hardcoded graceful degradation =====
              console.log(`[${requestId}] Tier 2 also failed: trigger=${tier2Quality.trigger}. Falling back to Tier 3 hardcoded message.`);
              finalSynthText = TIER3_FALLBACK_MESSAGE;
              recoveryRecord.tier3 = { used: true, message: TIER3_FALLBACK_MESSAGE };
              agentLog.rounds.push({
                round: round + 1,
                type: 'synthesis_tier3',
                ok: true,
                fallback: 'hardcoded',
              });
            }
          }
        }

        // Never replace a large primary synthesis with the generic Tier 3 line.
        // Primary can fail quality for reasons we still don't want to throw away
        // (e.g. edge cases beside truncated_clip). If we'd show Tier 3 but
        // primary already streamed substantial prose, ship that partial.
        const substantiveFloor = parseInt(process.env.AGENT_SYNTHESIS_SUBSTANTIVE_FLOOR || '1500', 10);
        if (finalSynthText === TIER3_FALLBACK_MESSAGE
            && typeof sanitizedPrimary === 'string'
            && sanitizedPrimary.trim().length >= substantiveFloor) {
          printLog(`[${requestId}] Tier 3 suppressed: delivering primary synthesis partial (${sanitizedPrimary.length}c) instead of generic fallback`);
          finalSynthText = sanitizedPrimary;
          if (recoveryRecord?.tier3) {
            recoveryRecord.tier3 = {
              used: false,
              suppressedForPrimaryPartial: true,
              primaryChars: sanitizedPrimary.length,
            };
          }
        }

        // Tier 3 suppression v2: when primary synthesis emitted ~nothing (deadline
        // killed it before any visible text), the original UX was to wipe all the
        // intermediate text the model streamed during tool rounds and replace it
        // with the canned 166-char fallback. Clients that render `text_done` as
        // authoritative therefore "took back" hundreds of chars of breadcrumbs
        // the user already saw. If we have substantive intermediate narration,
        // keep it and just append a soft "ran out of time" notice instead.
        const intermediateText = accumulatedTextByRound.map(r => r.text).join('\n\n').trim();
        // Floor lowered 2026-04-28: even a single sentence of breadcrumbs
        // ("Great, I have the full year of episodes...") is better than the
        // canned 166-char apology overwriting it. Set to 1 to mean "any
        // non-empty intermediate text wins".
        const intermediateFloor = parseInt(process.env.AGENT_TIER3_INTERMEDIATE_FLOOR || '50', 10);
        if (finalSynthText === TIER3_FALLBACK_MESSAGE
            && intermediateText.length >= intermediateFloor) {
          const softNotice = "\n\nI ran out of time before pulling this all together. Try again or refine the ask and I'll have another go.";
          printLog(`[${requestId}] Tier 3 suppressed v2: keeping ${intermediateText.length}c of intermediate narration + soft notice instead of canned fallback`);
          finalSynthText = intermediateText + softNotice;
          if (recoveryRecord?.tier3) {
            recoveryRecord.tier3 = {
              used: false,
              suppressedForIntermediateText: true,
              intermediateChars: intermediateText.length,
            };
          }
        }

        // ===== Commit the final synthesis text =====
        // We're in the synthesis branch, which only fires when
        // `naturalCompletion === false` — i.e. the loop exited because we
        // hit a cap, not because the model said it was done. Any text
        // emitted in earlier rounds was therefore intermediate narration
        // ("Let me grab one more...") that the model intended to follow
        // with another tool call. Drop it before pushing the synthesis
        // output so the canonical `text_done` payload contains only the
        // final synthesis prose, not the discarded thinking-out-loud
        // preamble.
        if (finalSynthText && finalSynthText.length > 0) {
          accumulatedTextByRound.length = 0;
          accumulatedTextByRound.push({ round: round + 1, text: finalSynthText });
        }

        const fullText = accumulatedTextByRound.length > 0
          ? accumulatedTextByRound.map(r => r.text).join('\n\n')
          : '';
        if (fullText) {
          agentLog.finalText = fullText;
          if (recoveryRecord) {
            agentLog.synthesisRecovery = recoveryRecord;
          }
          emit('text_done', { text: fullText });
        }
        const synthesisElapsedTotal = Date.now() - (synthesisDeadlineMs - synthesisBudgetMs);
        const deadlineHit = Date.now() >= synthesisDeadlineMs;
        const recoveryTier = recoveryRecord
          ? (recoveryRecord.tier3 ? 'tier3' : (recoveryRecord.tier2?.ok ? 'tier2' : (recoveryRecord.tier1?.ok ? 'tier1' : 'none')))
          : 'primary';
        console.log(`[${requestId}] === SYNTHESIS DONE === recovery=${recoveryTier}, ${fullText.length} total chars, ${synthesisElapsedTotal}ms${deadlineHit ? ' (primary deadline hit)' : ''}`);
      }

      const latencyMs = Date.now() - startTime;

      const summary = costs.summary();
      const { claude: claudeCost, tools: toolCost, total: totalCost } = summary;

      const finalMetrics = measureMessages(messages);
      printLog(`[${requestId}] Token budget breakdown: system=~${Math.ceil(effectiveSystemPrompt.length/4)}tok, user=~${Math.ceil(finalMetrics.userChars/4)}tok, assistant=~${Math.ceil(finalMetrics.assistantChars/4)}tok, toolResults=~${Math.ceil(finalMetrics.toolResultChars/4)}tok | actual=${costs.llm.inputTokens}in+${costs.llm.outputTokens}out`);

      // Real-money cost breakdown. `tools` (internal infra) is intentionally
      // $0 by design — see createCostTracker doc.
      const helpersByModel = summary.helpers?.byModel || {};
      const helperEntries = Object.entries(helpersByModel)
        .map(([modelId, m]) => `${modelId} ${m.calls}x $${m.cost.toFixed(4)}`)
        .join(', ');
      const helpersBreakdown = helperEntries ? ` [${helperEntries}]` : '';
      const orchestratorLabel = costs.llm.modelLabel || costs.llm.modelKey || 'orchestrator';
      printLog(
        `[${requestId}] Complete: ${round} rounds, ${toolCalls.length} tool calls, ${costs.llm.inputTokens}+${costs.llm.outputTokens} tokens` +
        `, $${claudeCost.toFixed(4)} ${orchestratorLabel} + $${(summary.helpers?.cost || 0).toFixed(4)} helpers${helpersBreakdown}` +
        ` = $${totalCost.toFixed(4)}, ${latencyMs}ms` +
        ` (internal infra: $${toolCost.toFixed(4)} by design)`
      );

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

  // Note: only `/agent` is registered. The previous public mounts at
  // POST /api/chat/agent and POST /api/chat/workflow were removed 2026-04-27
  // because they were exposed without auth/entitlement middleware. This
  // router is no longer mounted at /api/chat in server.js — it's only
  // reachable via internal dispatch from /api/pull (req.url = '/agent').
  router.post('/agent', handleAgentChat);

  return router;
}

module.exports = createAgentChatRoutes;
