const crypto = require('crypto');
const { printLog } = require('../constants.js');
const { parseWorkflowTask, WORKFLOW_TYPES } = require('./workflowTaskParser');
const { executeStep, REQUIRES_APPROVAL, STEP_REGISTRY } = require('./workflowSteps');
const { rerankClips } = require('./clipReranker');
const WorkflowSession = require('../models/WorkflowSession');
const { WORKFLOW_CREDIT_BACK_MICRO_USD, WORKFLOW_CREDIT_BACK_MAX_ITERATIONS } = require('../constants/agentPricing');

const WORKFLOW_MODELS = {
  taskParser:  { provider: 'openai', model: 'gpt-4o-mini' },
  planner:     { provider: 'openai', model: 'gpt-4o-mini' }, // upgrade to gpt-5.2 when available
  evaluator:   { provider: 'openai', model: 'gpt-4o-mini' },
  synthesizer: { provider: 'openai', model: 'gpt-4o-mini' },
  synthesizerPremium: { provider: 'openai', model: 'gpt-4o' },
};

const DEFAULT_MAX_ITERATIONS = 10;
const MAX_RESULTS_IN_CONTEXT = 15;

// OpenAI pricing per 1M tokens (USD)
const OPENAI_PRICING = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o':      { input: 2.50, output: 10.00 },
};

function estimateLlmCost(model, inputTokens, outputTokens) {
  const pricing = OPENAI_PRICING[model] || OPENAI_PRICING['gpt-4o-mini'];
  return (inputTokens * pricing.input / 1_000_000) + (outputTokens * pricing.output / 1_000_000);
}

function buildPlannerSystemPrompt(workflowType, initialParams) {
  const availableSteps = Object.keys(STEP_REGISTRY).filter(s => s !== 'make-clip');
  const today = new Date().toISOString().split('T')[0];

  return `You are a podcast research workflow planner. You decide what API step to execute next based on the user's task and the results accumulated so far.

Today's date is ${today}.

## Available Steps — What Each One Actually Searches

- "search-quotes": **Semantic vector search** across all transcribed podcast content in Pinecone. This is the primary way to find what people said about a topic. It searches the actual transcript text using embeddings — it finds relevant quotes even when exact keywords don't match. THIS IS YOUR MOST POWERFUL TOOL.
- "search-chapters": Searches chapter metadata (headlines, keywords, summaries) in MongoDB. Uses keyword/regex matching on chapter titles and tags — NOT semantic. Good for finding structured segments but may miss content that isn't explicitly tagged. Use short keyword phrases, not full sentences.
- "discover-podcasts": Searches the **external** Podcast Index for podcasts by topic. Returns feeds that MAY OR MAY NOT be transcribed in our system. Useful for enriching results with related shows the user might not know about, or finding new sources when existing transcripts are thin.
- "person-lookup": Finds episodes where a specific person appeared as a guest. Returns episode metadata plus primaryRole ("guest" or "host") and creatorFeedIds if they are a podcast host.
- "list-episode-chapters": Fetches ALL chapters for given episode GUIDs or feedIds. No keyword search — this directly retrieves the chapter table of contents for specific episodes. Use this AFTER person-lookup to see what topics were discussed in each episode, then use those chapter titles/keywords to craft targeted search-quotes queries.

## CRITICAL: Crafting search-quotes queries

The "query" parameter for search-quotes is embedded and compared against actual transcript text. NEVER pass meta-language like "find Luke Gromen's overview" or "give me appearances" — those match clips where someone says "Luke" by name (intros, outros) rather than substantive content.

Instead, construct queries that describe the TOPICS the person discussed:
- BAD: "Luke Gromen recent appearances overview"
- GOOD: "debt spiral AI deflation sovereign bonds economic cycle"
- BAD: "Roger Penrose talking about physics"
- GOOD: "black hole singularity quantum gravity event horizon"

When you have chapter headlines from list-episode-chapters, use them directly:
- If chapters say "Debt, AI, and Economic Implications" and "Job Loss and Economic Preparedness", your search-quotes query should be "debt AI economic implications job loss preparedness"
- Combine 2-3 chapter headlines into one topical query for best results
- "submit-on-demand": Submits episodes for transcription (requires approval). Only needed for content that isn't yet transcribed.
- "poll-on-demand": Polls the status of a transcription job.

## Workflow Context
- Workflow type: ${workflowType}
- Initial params: ${JSON.stringify(initialParams)}

## Canonical Workflow Patterns

**deep_topic_research**: Start with search-quotes (semantic search across existing transcripts — this is where most content lives). Optionally follow up with search-chapters for structured segments. discover-podcasts can enrich results with related shows, but is not a substitute for search-quotes. **If the query names a specific expert or person** (e.g. "What has Penrose said about X?"), always do person-lookup FIRST to get their episode GUIDs, then scope search-quotes to those GUIDs. This ensures you get clips of the person speaking, not others discussing them.

**person_dossier**: Start with person-lookup to find episodes. Then use list-episode-chapters on the discovered GUIDs to see what topics were discussed. Use the chapter headlines/keywords to craft targeted search-quotes queries scoped to those GUIDs. ALWAYS pass the discovered GUIDs to search-quotes — never search the full corpus without scoping when a person is the focus.

**discover_index_search**: Start with discover-podcasts, check transcript availability. If untranscribed, use submit-on-demand (requires approval). Then search-quotes on newly available content.

**competitive_intelligence**: Start with search-quotes for the topic, optionally use search-chapters with date filtering, then search-quotes for different time periods to compare.

**open_ended**: Start with search-quotes (always try this first), then refine with search-chapters or other steps based on results.

## Critical Rules
- **ALWAYS try search-quotes before discover-podcasts.** We have a large corpus of transcribed content. search-quotes must be attempted before assuming we don't have content on a topic.
- **search-chapters returning 0 does NOT mean we have no content on the topic.** Chapters use keyword matching and may miss content that search-quotes (semantic) would find. Always try search-quotes next.
- **Never submit-on-demand if search-quotes already returned useful results.** Transcription requests are expensive and slow. Only propose transcription when search-quotes returned 0 or near-0 results AND the user's query genuinely requires content we don't have yet.
- discover-podcasts is fine to run alongside or after search-quotes to enrich results with related shows. But discovered feeds should NOT trigger submit-on-demand unless the user specifically asked for new/untranscribed content.
- For search-chapters, use short keywords (1-3 words), not full phrases.
- **PERSON-SCOPING RULE**: If the query asks what a specific person said, thinks, or believes, you MUST do person-lookup first regardless of workflow type. Then pass the returned GUIDs to search-quotes. Without this scoping, search-quotes may return clips of OTHER people discussing the target person rather than the person themselves speaking. This is a critical quality issue.
- **HOST DETECTION**: After person-lookup, check the primaryRole in the results. If primaryRole is "host", the person is a podcast creator (e.g. Joe Rogan, Lex Fridman). In this case, use the creatorFeedIds (not the guest GUIDs) when calling search-quotes — this searches THEIR show. Guest GUIDs only cover episodes where they appeared on OTHER shows, which misses all their own content.

## Self-Healing Rules
- If search-chapters returns 0 results, try search-quotes with a semantic query (required before any other fallback).
- If search-quotes returns 0 or very low similarity (avg < 0.3), try rephrasing the query or broadening terms.
- If BOTH search-quotes AND search-chapters return 0, try discover-podcasts to find relevant feeds. Only propose submit-on-demand if the user's query specifically needs content from those discovered feeds.
- If person-lookup finds 0 episodes, try broader name variants or discover-podcasts for the person.
- After 3 consecutive steps with poor results, stop and return what you have.
- Never repeat the exact same step with the exact same parameters.

## Output Format
Return JSON with:
- "action": one of "execute_step" or "finish"
- "stepType": (only if action is "execute_step") the step to run from the available steps list
- "params": (only if action is "execute_step") parameters object for the step
- "reasoning": one sentence explaining why you chose this action
- "shouldFinish": boolean — true if results are good enough or no further improvement is likely

For step params, use these shapes:
- search-quotes: { "query": "...", "feedIds": [], "guids": [], "limit": 10, "minDate": null, "maxDate": null }
- search-chapters: { "search": "...", "feedIds": [], "limit": 20 }
- discover-podcasts: { "query": "...", "limit": 10 }
- person-lookup: { "personName": "...", "personVariants": ["...", "..."] }
- list-episode-chapters: { "guids": ["..."], "feedIds": ["..."], "limit": 50 }
- submit-on-demand: { "episodes": [{ "guid": "...", "feedGuid": "...", "feedId": "..." }] }
- poll-on-demand: { "jobId": "..." }

Return ONLY valid JSON.`;
}

function summarizeResults(accumulatedResults) {
  if (accumulatedResults.length === 0) return 'No results yet.';

  const lines = [];
  for (const step of accumulatedResults) {
    const count = step.quality?.resultCount || 0;
    const type = step.stepType;

    if (type === 'search-quotes' && step.results?.length > 0) {
      const topResults = step.results.slice(0, 3).map(r =>
        `"${(r.quote || '').substring(0, 80)}..." (${r.episode}, similarity: ${r.similarity})`
      );
      lines.push(`${type}: ${count} results. Top: ${topResults.join('; ')}`);
    } else if (type === 'search-chapters' && step.results?.length > 0) {
      const topResults = step.results.slice(0, 3).map(r =>
        `"${r.headline || 'untitled'}" (${r.episode?.title || 'unknown'})`
      );
      lines.push(`${type}: ${count} results (${step.quality?.totalCount} total). Top: ${topResults.join('; ')}`);
    } else if (type === 'person-lookup') {
      const primaryRole = step.metadata?.primaryRole || 'guest';
      const creatorFeedIds = step.metadata?.creatorFeedIds || [];
      lines.push(`${type}: Found ${count} guest episodes across ${step.quality?.feedCount} feeds. primaryRole: ${primaryRole}.`);
      if (primaryRole === 'host' && creatorFeedIds.length > 0) {
        lines.push(`  ⚠ This person is primarily a HOST/CREATOR. Use feedIds=[${creatorFeedIds.join(',')}] for search-quotes to search their show.`);
      }
      const guids = step.metadata?.guids?.slice(0, 5) || [];
      if (guids.length > 0) lines.push(`  Guest episode GUIDs: ${guids.join(', ')}`);
      const feedIds = step.metadata?.feedIds || [];
      if (feedIds.length > 0) lines.push(`  Guest feed IDs: ${feedIds.join(', ')}`);
      if (creatorFeedIds.length > 0) lines.push(`  Creator feed IDs: ${creatorFeedIds.join(', ')}`);
    } else if (type === 'list-episode-chapters' && step.results?.length > 0) {
      const topChapters = step.results.slice(0, 5).map(r =>
        `"${r.headline || 'untitled'}" (${r.episodeTitle || 'unknown'})`
      );
      lines.push(`${type}: ${count} chapters across ${step.quality?.episodeCount} episodes. Topics: ${topChapters.join('; ')}`);
    } else if (type === 'discover-podcasts' && step.results?.length > 0) {
      const feeds = step.results.slice(0, 3).map(r =>
        `"${r.title}" (${r.transcriptAvailable ? 'transcribed' : 'not transcribed'})`
      );
      lines.push(`${type}: ${count} feeds found, ${step.quality?.transcribedCount} transcribed. Top: ${feeds.join('; ')}`);
    } else {
      lines.push(`${type}: ${count} results.`);
    }
  }

  return lines.join('\n');
}

async function planNextStep({ task, workflowType, initialParams, accumulatedResults, iterationCount, openai }) {
  const debugPrefix = '[WORKFLOW-PLANNER]';

  const systemPrompt = buildPlannerSystemPrompt(workflowType, initialParams);
  const resultSummary = summarizeResults(accumulatedResults);

  const userMessage = `Task: "${task}"

Iteration: ${iterationCount + 1}
Results so far:
${resultSummary}

What should I do next?`;

  try {
    const response = await openai.chat.completions.create({
      model: WORKFLOW_MODELS.planner.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 500,
    });

    const plan = JSON.parse(response.choices[0].message.content);
    const usage = response.usage || {};
    plan._usage = {
      model: WORKFLOW_MODELS.planner.model,
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    };
    printLog(`${debugPrefix} action=${plan.action}, step=${plan.stepType}, reason="${plan.reasoning}" (${usage.total_tokens || 0} tokens)`);
    return plan;

  } catch (error) {
    printLog(`${debugPrefix} ERROR: ${error.message}`);
    return { action: 'finish', reasoning: `Planner error: ${error.message}`, shouldFinish: true, _usage: { model: WORKFLOW_MODELS.planner.model, input_tokens: 0, output_tokens: 0 } };
  }
}

/**
 * Run a workflow from start or resume from an approval gate.
 *
 * @param {object} options
 * @param {string} options.task - Natural language research task
 * @param {number} [options.maxIterations] - Max iterations
 * @param {string} [options.outputFormat] - 'structured' | 'streaming' | 'text'
 * @param {object} [options.context] - Filters, feedIds, preApprovedActions
 * @param {object} options.openai - OpenAI client instance
 * @param {function} options.emitEvent - SSE event emitter: (eventType, data) => void
 * @param {string} [options.sessionId] - Session ID when resuming
 * @param {string} [options.ownerId] - Owner identity for session persistence
 * @returns {object} Final workflow result
 */
async function synthesizeResults({ task, workflowType, allResults, accumulatedResults, openai, premium = true }) {
  const debugPrefix = '[WORKFLOW-SYNTH]';
  const model = premium ? WORKFLOW_MODELS.synthesizerPremium.model : WORKFLOW_MODELS.synthesizer.model;

  const quoteCount = allResults.filter(r => r._sourceStep === 'search-quotes').length;
  if (allResults.length === 0 || quoteCount === 0) {
    printLog(`${debugPrefix} No clips available (${allResults.length} total results, ${quoteCount} quotes) — skipping synthesis`);
    return {
      text: 'I was not able to find specific podcast clips matching this query in our corpus. Try rephrasing your search or broadening the topic.',
      _usage: { model, input_tokens: 0, output_tokens: 0 },
    };
  }

  const resultsContext = allResults.slice(0, MAX_RESULTS_IN_CONTEXT).map(r => {
    if (r._sourceStep === 'search-quotes') {
      return {
        type: 'quote',
        pineconeId: r.pineconeId || null,
        text: (r.quote || '').substring(0, 500),
        speaker: r.creator || null,
        episode: r.episode || null,
        date: r.date || null,
        similarity: r.similarity || null,
      };
    } else if (r._sourceStep === 'person-lookup') {
      return {
        type: 'appearance',
        guid: r.guid || null,
        title: r.title || '',
        creator: r.creator || null,
        date: r.publishedDate || null,
        guest: r.matchedGuest || null,
      };
    } else if (r._sourceStep === 'search-chapters') {
      return {
        type: 'chapter',
        guid: r.guid || null,
        headline: r.headline || null,
        summary: (r.summary || '').substring(0, 200),
        episode: r.episode || null,
      };
    } else if (r._sourceStep === 'discover-podcasts') {
      return {
        type: 'podcast',
        title: r.title || '',
        author: r.author || '',
        transcribed: r.transcriptAvailable || false,
      };
    }
    return { type: r._sourceStep, summary: JSON.stringify(r).substring(0, 200) };
  });

  const stepsUsed = accumulatedResults.map(s => `${s.stepType} (${s.quality?.resultCount || 0} results)`).join(' → ');

  const availablePineconeIds = resultsContext
    .filter(r => r.type === 'quote' && r.pineconeId)
    .map(r => r.pineconeId);

  const systemPrompt = `You are a research analyst summarizing podcast research results. Write a concise, informative overview that directly answers the user's question.

Guidelines:
- Lead with the answer — don't start with "Based on the results" or "Here's what I found"
- Mention specific podcast names, episode titles, dates, and speakers by name
- Identify key themes and narratives across appearances
- If the data shows a chronological arc or evolving viewpoint, highlight it
- Keep it to 2-4 short paragraphs
- Use a natural, editorial tone — like a knowledgeable colleague briefing you
- Do NOT use bullet points or lists; write in prose

## Inline verbatim quotes

When a clip contains an insightful, singular, or highly relevant statement, embed it as a verbatim inline quote (using quotation marks and attributing the speaker). For example:

As Gromen explained on What Bitcoin Did: "The US is essentially in a debt spiral where the interest payments alone exceed what they can service..."

This adds credibility and lets the reader hear the person's actual voice. Prefer direct quotes over paraphrasing when the wording itself is impactful.

## Inline clip references

When you reference or cite a specific quote in your summary, insert a {{clip:<pineconeId>}} token on its own line immediately after the paragraph that references it. This allows the frontend to render an interactive audio player at that point in the text.

Rules:
- ONLY use pineconeIds from this list: ${JSON.stringify(availablePineconeIds)}
- Place tokens on their own line between paragraphs, never inline within a sentence
- You do not need to cite every clip — only the most relevant 2-5 that strengthen the narrative
- The summary must still read coherently if all tokens are removed
- For chapter or episode references (non-quote results), you may use {{episode:<guid>}} if a guid is available

Example:
Graham Hancock discusses how his early work was dismissed by mainstream archaeology, but public reception told a different story:
{{clip:46acbea2-c4cb-458f-aec4-d95006dec5ab_p294}}
Years later, the narrative shifted as physical evidence began to support his theories:
{{clip:4e3d2547-4bec-40ce-8c09-10bc3f8426f3_p211}}`;

  const userMessage = `User's question: "${task}"

Workflow type: ${workflowType}
Steps executed: ${stepsUsed}

Research data:
${JSON.stringify(resultsContext, null, 2)}

Write a summary that answers the user's question, embedding {{clip:<pineconeId>}} tokens where appropriate.`;

  try {
    printLog(`${debugPrefix} Synthesizing with ${model} (premium=${premium})`);

    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.4,
      max_tokens: 800,
    });

    let summary = response.choices[0].message.content?.trim() || '';
    const usage = response.usage || {};

    // Normalize clip/episode tokens onto their own lines.
    // LLMs often place them inline at end of sentences — this ensures
    // the frontend parser can reliably split on them.
    summary = summary.replace(/\s*({{(?:clip|episode|chapter):[^}]+}})[\t ]*/g, '\n$1\n');
    summary = summary.replace(/\n{3,}/g, '\n\n');
    summary = summary.trim();

    printLog(`${debugPrefix} Summary generated: ${summary.length} chars (${usage.total_tokens || 0} tokens)`);
    return {
      text: summary,
      _usage: { model, input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
    };

  } catch (error) {
    printLog(`${debugPrefix} Synthesis failed (${model}): ${error.message}`);
    return { text: null, _usage: { model, input_tokens: 0, output_tokens: 0 } };
  }
}

async function runWorkflow({
  task,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  outputFormat = 'structured',
  context = {},
  openai,
  emitEvent = () => {},
  sessionId = null,
  ownerId = null,
  premium = true,
}) {
  const debugPrefix = '[WORKFLOW]';
  const startTime = Date.now();

  let session = null;
  let workflowType;
  let initialParams;
  let accumulatedResults = [];
  let iterationCount = 0;
  let preApprovedActions = new Set(context.preApprovedActions || []);
  const llmCalls = [];

  // Resume from approval gate
  if (sessionId) {
    session = await WorkflowSession.findOne({ sessionId });
    if (!session) {
      return { status: 'failed', error: 'Session not found', sessionId };
    }
    if (session.status !== 'approval_required') {
      return { status: 'failed', error: `Session is ${session.status}, not resumable`, sessionId };
    }

    workflowType = session.workflowType;
    initialParams = session.taskParserResult?.initialParams || {};
    accumulatedResults = session.accumulatedResults || [];
    iterationCount = session.iterationCount || 0;
    maxIterations = session.maxIterations || maxIterations;
    task = session.task;
    outputFormat = session.outputFormat || outputFormat;

    // Merge previously approved + newly approved
    for (const a of (session.approvedActions || [])) preApprovedActions.add(a);

    printLog(`${debugPrefix} Resuming session ${sessionId} at iteration ${iterationCount}`);
    emitEvent('status', { message: 'Resuming workflow...', sessionId });

    // Execute the pending action that was waiting for approval
    const pending = session.pendingAction;
    if (pending) {
      emitEvent('iteration', {
        iteration: iterationCount + 1,
        maxIterations,
        step: pending.type,
        status: 'running',
        message: `Executing approved action: ${pending.type}`,
      });

      const stepResult = await executeStep(pending.type, {
        ...pending.params,
        openai,
      });

      accumulatedResults.push(stepResult);
      iterationCount++;

      emitEvent('iteration', {
        iteration: iterationCount,
        maxIterations,
        step: pending.type,
        status: 'complete',
        resultCount: stepResult.quality?.resultCount || 0,
      });

      // If this was submit-on-demand, follow up with polling
      if (pending.type === 'submit-on-demand' && stepResult.results?.[0]?.jobId) {
        emitEvent('iteration', {
          iteration: iterationCount + 1,
          maxIterations,
          step: 'poll-on-demand',
          status: 'running',
          message: 'Waiting for transcription to complete...',
        });

        const pollResult = await executeStep('poll-on-demand', {
          jobId: stepResult.results[0].jobId,
        });
        accumulatedResults.push(pollResult);
        iterationCount++;

        emitEvent('iteration', {
          iteration: iterationCount,
          maxIterations,
          step: 'poll-on-demand',
          status: pollResult.quality?.complete ? 'complete' : 'timeout',
        });
      }
    }

    session.status = 'running';
    session.pendingAction = null;
    session.iterationCount = iterationCount;
    session.accumulatedResults = accumulatedResults;
    session.approvedActions = [...preApprovedActions];
    await session.save();

  } else {
    // New workflow — parse task
    sessionId = crypto.randomBytes(16).toString('hex');

    emitEvent('status', { message: 'Analyzing your request...', sessionId });

    const parsed = await parseWorkflowTask(task, openai);
    workflowType = parsed.workflowType;
    initialParams = parsed.initialParams;

    // Track task parser LLM cost
    if (parsed._meta?.usage) {
      const u = parsed._meta.usage;
      llmCalls.push({ role: 'taskParser', model: 'gpt-4o-mini', input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 });
    }

    printLog(`${debugPrefix} New workflow ${sessionId}: type=${workflowType}, confidence=${parsed.confidence}`);
    emitEvent('status', {
      message: `Starting ${workflowType.replace(/_/g, ' ')} workflow...`,
      sessionId,
      workflowType,
      confidence: parsed.confidence,
    });

    // Persist session for potential approval gates
    session = await WorkflowSession.create({
      sessionId,
      status: 'running',
      task,
      workflowType,
      context,
      maxIterations,
      outputFormat,
      ownerId,
      taskParserResult: parsed,
      approvedActions: [...preApprovedActions],
    });
  }

  // Main iteration loop
  let consecutiveFailures = 0;

  while (iterationCount < maxIterations) {
    const plan = await planNextStep({
      task,
      workflowType,
      initialParams,
      accumulatedResults,
      iterationCount,
      openai,
    });

    if (plan._usage) {
      llmCalls.push({ role: 'planner', ...plan._usage });
    }

    if (plan.action === 'finish' || plan.shouldFinish) {
      printLog(`${debugPrefix} Planner decided to finish: ${plan.reasoning}`);
      emitEvent('status', { message: plan.reasoning });
      break;
    }

    if (plan.action !== 'execute_step' || !plan.stepType) {
      printLog(`${debugPrefix} Invalid planner output, finishing`);
      break;
    }

    const stepType = plan.stepType;
    const stepParams = plan.params || {};

    // Approval gate check
    if (REQUIRES_APPROVAL.has(stepType) && !preApprovedActions.has(stepType)) {
      printLog(`${debugPrefix} Approval required for ${stepType}`);

      session.status = 'approval_required';
      session.iterationCount = iterationCount;
      session.accumulatedResults = accumulatedResults;
      session.pendingAction = {
        type: stepType,
        params: stepParams,
        description: plan.reasoning,
      };
      await session.save();

      emitEvent('approval_required', {
        sessionId,
        pendingAction: {
          type: stepType,
          description: plan.reasoning,
          params: stepParams,
        },
      });

      // Collect results so far for partial response
      const allResults = collectAllResults(accumulatedResults);

      return {
        status: 'approval_required',
        sessionId,
        iterationsUsed: iterationCount,
        pendingAction: {
          type: stepType,
          description: plan.reasoning,
          params: stepParams,
        },
        partialResults: allResults,
      };
    }

    // Execute the step
    emitEvent('iteration', {
      iteration: iterationCount + 1,
      maxIterations,
      step: stepType,
      status: 'running',
      message: plan.reasoning,
    });

    const stepResult = await executeStep(stepType, {
      ...stepParams,
      openai,
    });

    // Re-rank search-quotes results with a lightweight LLM pass
    if (stepType === 'search-quotes' && stepResult.results?.length > 2) {
      const rerankResult = await rerankClips({ query: task, clips: stepResult.results, openai });
      stepResult.results = rerankResult.clips;
      stepResult.quality.resultCount = rerankResult.clips.length;
      if (rerankResult.usage.input_tokens > 0) {
        llmCalls.push({ role: 'reranker', ...rerankResult.usage });
      }
    }

    accumulatedResults.push(stepResult);
    iterationCount++;

    // Track consecutive failures
    if (!stepResult.quality?.hasResults) {
      consecutiveFailures++;
    } else {
      consecutiveFailures = 0;
    }

    emitEvent('iteration', {
      iteration: iterationCount,
      maxIterations,
      step: stepType,
      status: stepResult.quality?.hasResults ? 'complete' : 'no_results',
      resultCount: stepResult.quality?.resultCount || 0,
    });

    // Bail after too many consecutive failures
    if (consecutiveFailures >= 3) {
      printLog(`${debugPrefix} 3 consecutive failures, stopping`);
      emitEvent('status', { message: 'Unable to find better results after multiple attempts.' });
      break;
    }

    // Persist progress
    session.iterationCount = iterationCount;
    session.accumulatedResults = accumulatedResults;
    await session.save();
  }

  // Workflow complete
  const allResults = collectAllResults(accumulatedResults);

  // Synthesize a human-readable summary
  emitEvent('status', { message: 'Synthesizing overview...' });

  const synthResult = await synthesizeResults({
    task,
    workflowType,
    allResults,
    accumulatedResults,
    openai,
    premium,
  });
  const summary = synthResult.text;
  if (synthResult._usage) {
    llmCalls.push({ role: 'synthesizer', ...synthResult._usage });
  }

  // Compute total LLM cost estimate
  const totalLlmCost = llmCalls.reduce((sum, c) => sum + estimateLlmCost(c.model, c.input_tokens, c.output_tokens), 0);

  const latencyMs = Date.now() - startTime;

  // Credit-back calculation
  const creditBack = iterationCount <= WORKFLOW_CREDIT_BACK_MAX_ITERATIONS
    ? WORKFLOW_CREDIT_BACK_MICRO_USD
    : 0;

  session.status = 'complete';
  session.iterationCount = iterationCount;
  session.accumulatedResults = accumulatedResults;
  await session.save();

  printLog(`${debugPrefix} Complete: ${iterationCount} iterations, ${allResults.length} total results, ${latencyMs}ms`);

  emitEvent('result', {
    status: 'complete',
    sessionId,
    iterationsUsed: iterationCount,
    totalResults: allResults.length,
  });

  return {
    status: 'complete',
    sessionId,
    iterationsUsed: iterationCount,
    workflowType,
    summary: summary || null,
    results: allResults,
    accumulatedSteps: accumulatedResults.map(s => ({
      stepType: s.stepType,
      resultCount: s.quality?.resultCount || 0,
      latencyMs: s.metadata?.latencyMs || 0,
    })),
    cost: {
      charged: 100000,
      creditBack,
      net: 100000 - creditBack,
    },
    llmCosts: {
      calls: llmCalls.map(c => ({
        role: c.role,
        model: c.model,
        inputTokens: c.input_tokens,
        outputTokens: c.output_tokens,
        estimatedCost: parseFloat(estimateLlmCost(c.model, c.input_tokens, c.output_tokens).toFixed(6)),
      })),
      totalEstimatedCost: parseFloat(totalLlmCost.toFixed(6)),
    },
    latencyMs,
  };
}

/**
 * Collect and deduplicate all search results across iterations.
 */
function collectAllResults(accumulatedResults) {
  const seen = new Set();
  const results = [];

  for (const step of accumulatedResults) {
    if (!step.results) continue;

    for (const result of step.results) {
      const key = result.pineconeId || result.shareLink || result.guid || JSON.stringify(result);
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          ...result,
          _sourceStep: step.stepType,
        });
      }
    }
  }

  return results.slice(0, MAX_RESULTS_IN_CONTEXT * 3);
}

module.exports = {
  runWorkflow,
  WORKFLOW_MODELS,
};
