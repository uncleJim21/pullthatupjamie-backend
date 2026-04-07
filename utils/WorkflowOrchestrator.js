const crypto = require('crypto');
const { printLog } = require('../constants.js');
const { parseWorkflowTask, WORKFLOW_TYPES } = require('./workflowTaskParser');
const { executeStep, REQUIRES_APPROVAL, STEP_REGISTRY } = require('./workflowSteps');
const WorkflowSession = require('../models/WorkflowSession');
const { WORKFLOW_CREDIT_BACK_MICRO_USD, WORKFLOW_CREDIT_BACK_MAX_ITERATIONS } = require('../constants/agentPricing');

const WORKFLOW_MODELS = {
  taskParser:  { provider: 'openai', model: 'gpt-4o-mini' },
  planner:     { provider: 'openai', model: 'gpt-4o-mini' }, // upgrade to gpt-5.2 when available
  evaluator:   { provider: 'openai', model: 'gpt-4o-mini' },
};

const DEFAULT_MAX_ITERATIONS = 10;
const MAX_RESULTS_IN_CONTEXT = 15;

function buildPlannerSystemPrompt(workflowType, initialParams) {
  const availableSteps = Object.keys(STEP_REGISTRY).filter(s => s !== 'make-clip');
  const today = new Date().toISOString().split('T')[0];

  return `You are a podcast research workflow planner. You decide what API step to execute next based on the user's task and the results accumulated so far.

Today's date is ${today}.

## Available Steps
${availableSteps.map(s => `- "${s}"`).join('\n')}

## Workflow Context
- Workflow type: ${workflowType}
- Initial params: ${JSON.stringify(initialParams)}

## Canonical Workflow Patterns

**deep_topic_research**: Start with search-chapters (broad survey), then search-quotes (drill into specific episodes). If no results, try discover-podcasts.

**person_dossier**: Start with person-lookup to find episodes, then search-quotes with the discovered guids to find what they said.

**discover_index_search**: Start with discover-podcasts, check transcript availability. If untranscribed, use submit-on-demand (requires approval). Then search-quotes on newly available content.

**competitive_intelligence**: Use search-chapters with date filtering, then search-quotes for different time periods, compare results.

**open_ended**: Combine approaches — start with search-chapters or search-quotes, refine based on results.

## Self-Healing Rules
- If a step returns 0 results, try a different approach (broaden query, remove filters, try discovery).
- If search-quotes returns low similarity scores (avg < 0.3), relax filters or rewrite the query.
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
    } else if (type === 'person-lookup' && step.results?.length > 0) {
      lines.push(`${type}: Found ${count} episodes across ${step.quality?.feedCount} feeds.`);
      const guids = step.metadata?.guids?.slice(0, 5) || [];
      if (guids.length > 0) lines.push(`  Episode GUIDs available: ${guids.join(', ')}`);
      const feedIds = step.metadata?.feedIds || [];
      if (feedIds.length > 0) lines.push(`  Feed IDs: ${feedIds.join(', ')}`);
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
    printLog(`${debugPrefix} action=${plan.action}, step=${plan.stepType}, reason="${plan.reasoning}"`);
    return plan;

  } catch (error) {
    printLog(`${debugPrefix} ERROR: ${error.message}`);
    return { action: 'finish', reasoning: `Planner error: ${error.message}`, shouldFinish: true };
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
async function runWorkflow({
  task,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  outputFormat = 'structured',
  context = {},
  openai,
  emitEvent = () => {},
  sessionId = null,
  ownerId = null,
}) {
  const debugPrefix = '[WORKFLOW]';
  const startTime = Date.now();

  let session = null;
  let workflowType;
  let initialParams;
  let accumulatedResults = [];
  let iterationCount = 0;
  let preApprovedActions = new Set(context.preApprovedActions || []);

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
