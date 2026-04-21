const { printLog } = require('../constants.js');
const { loadFeedCache, fuzzyMatchFeed } = require('./queryTriage');

const WORKFLOW_TYPES = {
  DEEP_TOPIC_RESEARCH: 'deep_topic_research',
  PERSON_DOSSIER: 'person_dossier',
  DISCOVER_INDEX_SEARCH: 'discover_index_search',
  COMPETITIVE_INTELLIGENCE: 'competitive_intelligence',
  OPEN_ENDED: 'open_ended',
  QUOTE_CLIP_SHARE: 'quote_clip_share', // reserved for future clip support
};

function buildWorkflowClassifierPrompt(feedTitles) {
  const today = new Date().toISOString().split('T')[0];
  const year = new Date().getFullYear();

  const feedList = feedTitles.length > 0
    ? `\nCurrently indexed feeds (${feedTitles.length} total):\n${feedTitles.slice(0, 60).join(', ')}\n`
    : '';

  return `You are a workflow classifier for a podcast search and research platform.

Today's date is ${today}. The current year is ${year}. "Last year" means ${year - 1}.

The platform has a semantically indexed corpus of 109+ podcast feeds, ~7K episodes, and ~1.9M paragraphs. It supports vector search across transcripts, chapter-level keyword search, podcast discovery across 4M+ feeds, on-demand transcription, research sessions, and AI analysis.
${feedList}
Given a user's natural language research task, classify it into a workflow type and extract structured parameters.

## Workflow Types

1. **deep_topic_research** — User wants to find what's being said about a specific topic. May reference a show, a time period, or specific aspects. The agent surveys chapters, then drills into quotes.
   Examples: "What are people saying about AI regulation this week", "Find the best takes on remote work from business podcasts"

2. **person_dossier** — User wants everything a specific person has said or been discussed about. Meeting prep, due diligence, fan research.
   Examples: "Pull together everything Lyn Alden said about the fiscal deficit", "What has Marc Andreessen been saying about AI"

3. **discover_index_search** — User wants content from podcasts that may not be indexed yet. Requires podcast discovery and possibly on-demand transcription before searching.
   Examples: "Find me podcasts about psychedelics research from actual scientists", "Are there episodes about the Federal Reserve from non-finance shows"

4. **competitive_intelligence** — User wants to track how a narrative or topic evolved over time. Requires date-range comparisons.
   Examples: "How has the AI safety conversation shifted over the past year", "Compare what people said about inflation in January vs now"

5. **open_ended** — Broad research request where the agent needs to figure out the approach. May combine multiple workflow types.
   Examples: "Help me prep a presentation on AI and creative work", "I need both sides of the lab leak debate from podcast interviews"

6. **quote_clip_share** — (Reserved, not yet active) User wants to find a specific quote and turn it into a shareable clip.

## Output Format

Return JSON with these fields:

- "workflowType": one of the types above
- "initialParams": {
    "query": rewritten search query optimized for the corpus (strip meta-language like "find me" or "pull up"),
    "feedIds": array of feedId strings if a specific show is mentioned and you can match it to the feed list (empty array if none),
    "personName": primary person name if relevant (null if none),
    "personVariants": array of 2-5 spelling/name variants for database matching (empty array if none),
    "topicKeywords": array of 1-5 short topic keywords,
    "minDate": ISO date string if time reference (null otherwise),
    "maxDate": ISO date string if time reference (null otherwise),
    "showHint": podcast/show name mentioned or implied (null if none)
  }
- "suggestedSteps": array of 1-3 strings naming the first API steps to take. Valid steps: "search-chapters", "search-quotes", "discover-podcasts", "person-lookup", "analyze"
- "reasoning": one sentence explaining why you chose this workflow type
- "confidence": 0.0-1.0

Return ONLY valid JSON, no markdown or explanation.`;
}

/**
 * Classify a natural language task into a workflow type with structured params.
 *
 * @param {string} task - The user's raw NL research task
 * @param {object} openai - OpenAI client instance
 * @returns {object} { workflowType, initialParams, suggestedSteps, reasoning, confidence }
 */
async function parseWorkflowTask(task, openai) {
  const startTime = Date.now();
  const debugPrefix = '[WORKFLOW-PARSER]';

  try {
    printLog(`${debugPrefix} ========== PARSE START ==========`);
    printLog(`${debugPrefix} Task: "${task}"`);

    const feeds = await loadFeedCache();
    const feedTitles = feeds.map(f => f.title).filter(Boolean);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildWorkflowClassifierPrompt(feedTitles) },
        { role: 'user', content: task }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 500
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    const usage = response.usage || {};
    const latencyMs = Date.now() - startTime;

    printLog(`${debugPrefix} Classification (${latencyMs}ms): ${parsed.workflowType} (confidence: ${parsed.confidence})`);
    printLog(`${debugPrefix} Reasoning: ${parsed.reasoning}`);
    printLog(`${debugPrefix} Suggested steps: ${(parsed.suggestedSteps || []).join(', ')}`);

    // Resolve feedIds from showHint if the LLM didn't match them directly
    if (parsed.initialParams?.showHint && (!parsed.initialParams.feedIds || parsed.initialParams.feedIds.length === 0)) {
      const matched = fuzzyMatchFeed(parsed.initialParams.showHint, feeds);
      if (matched) {
        parsed.initialParams.feedIds = [matched.feedId];
        printLog(`${debugPrefix} Feed resolved from showHint: "${parsed.initialParams.showHint}" -> ${matched.title} (${matched.feedId})`);
      }
    }

    return {
      workflowType: parsed.workflowType || WORKFLOW_TYPES.OPEN_ENDED,
      initialParams: {
        query: parsed.initialParams?.query || task,
        feedIds: parsed.initialParams?.feedIds || [],
        personName: parsed.initialParams?.personName || null,
        personVariants: parsed.initialParams?.personVariants || [],
        topicKeywords: parsed.initialParams?.topicKeywords || [],
        minDate: parsed.initialParams?.minDate || null,
        maxDate: parsed.initialParams?.maxDate || null,
        showHint: parsed.initialParams?.showHint || null,
      },
      suggestedSteps: parsed.suggestedSteps || ['search-chapters'],
      reasoning: parsed.reasoning || '',
      confidence: parsed.confidence || 0.5,
      _meta: {
        latencyMs,
        usage: {
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0
        }
      }
    };

  } catch (error) {
    const latencyMs = Date.now() - startTime;
    printLog(`${debugPrefix} ERROR (${latencyMs}ms): ${error.message}`);
    console.error(`${debugPrefix} Task parsing failed:`, error);

    return {
      workflowType: WORKFLOW_TYPES.OPEN_ENDED,
      initialParams: {
        query: task,
        feedIds: [],
        personName: null,
        personVariants: [],
        topicKeywords: [],
        minDate: null,
        maxDate: null,
        showHint: null,
      },
      suggestedSteps: ['search-chapters', 'search-quotes'],
      reasoning: 'Fallback: task parsing failed, defaulting to open-ended research',
      confidence: 0,
      _meta: { latencyMs, error: error.message }
    };
  }
}

module.exports = {
  parseWorkflowTask,
  WORKFLOW_TYPES,
};
