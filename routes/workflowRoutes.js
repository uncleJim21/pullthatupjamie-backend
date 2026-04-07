const express = require('express');
const { printLog } = require('../constants.js');
const { createEntitlementMiddleware } = require('../utils/entitlementMiddleware');
const { ENTITLEMENT_TYPES } = require('../constants/entitlementTypes');
const { serviceHmac } = require('../middleware/hmac');
const { runWorkflow } = require('../utils/WorkflowOrchestrator');
const { formatWorkflowOutput } = require('../utils/workflowOutputFormatter');
const WorkflowSession = require('../models/WorkflowSession');
const { resolveIdentity } = require('../utils/identityResolver');

/**
 * Factory function to create workflow routes.
 *
 * @param {object} deps
 * @param {object} deps.openai - OpenAI client instance
 * @returns {express.Router}
 */
function createWorkflowRoutes({ openai }) {
  const router = express.Router();

  /**
   * POST /workflow
   * Start a new iterative research workflow.
   */
  router.post('/workflow',
    serviceHmac({ optional: true }),
    createEntitlementMiddleware(ENTITLEMENT_TYPES.WORKFLOW),
    async (req, res) => {
      const requestId = `WF-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      const startTime = Date.now();

      try {
        const {
          task,
          maxIterations = 10,
          outputFormat = 'structured',
          context = {},
        } = req.body;

        if (!task || typeof task !== 'string' || task.trim().length === 0) {
          return res.status(400).json({
            error: 'Bad request',
            message: 'task is required and must be a non-empty string',
          });
        }

        const effectiveMaxIterations = Math.min(Math.max(1, Math.floor(maxIterations)), 20);

        printLog(`[${requestId}] POST /api/chat/workflow — task="${task.substring(0, 100)}", maxIter=${effectiveMaxIterations}, format=${outputFormat}`);

        // Resolve owner identity
        let ownerId = null;
        try {
          const identity = await resolveIdentity(req);
          ownerId = identity?.identifier || null;
        } catch (e) { /* anonymous is fine */ }

        const isStreaming = outputFormat === 'streaming';

        if (isStreaming) {
          // SSE mode
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });

          const emitEvent = (eventType, data) => {
            try {
              res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              printLog(`[${requestId}] SSE write error: ${e.message}`);
            }
          };

          req.on('close', () => {
            printLog(`[${requestId}] Client disconnected`);
          });

          const rawResult = await runWorkflow({
            task: task.trim(),
            maxIterations: effectiveMaxIterations,
            outputFormat,
            context,
            openai,
            emitEvent,
            ownerId,
          });

          // Send final formatted result
          const formatted = formatWorkflowOutput(rawResult, 'structured');
          emitEvent('result', formatted);
          emitEvent('done', {});
          res.end();

        } else {
          // Synchronous JSON mode
          const rawResult = await runWorkflow({
            task: task.trim(),
            maxIterations: effectiveMaxIterations,
            outputFormat,
            context,
            openai,
            emitEvent: () => {},
            ownerId,
          });

          if (rawResult.status === 'approval_required') {
            return res.status(202).json(rawResult);
          }

          const formatted = formatWorkflowOutput(rawResult, outputFormat);
          res.json(formatted);
        }

      } catch (error) {
        const latencyMs = Date.now() - startTime;
        printLog(`[${requestId}] ERROR (${latencyMs}ms): ${error.message}`);
        console.error(`[${requestId}] Stack:`, error.stack);

        if (res.headersSent) {
          try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
          } catch (e) { /* response already closed */ }
        } else {
          res.status(500).json({
            error: 'Workflow failed',
            detail: error.message,
            requestId,
          });
        }
      }
    }
  );

  /**
   * POST /workflow/:sessionId/approve
   * Resume a paused workflow after an approval gate.
   */
  router.post('/workflow/:sessionId/approve',
    serviceHmac({ optional: true }),
    async (req, res) => {
      const { sessionId } = req.params;
      const { approved = true, approveAll = false } = req.body;
      const requestId = `WF-APPROVE-${Date.now()}`;

      try {
        printLog(`[${requestId}] Approval for session ${sessionId}: approved=${approved}, approveAll=${approveAll}`);

        const session = await WorkflowSession.findOne({ sessionId });
        if (!session) {
          return res.status(404).json({ error: 'Session not found', sessionId });
        }
        if (session.status !== 'approval_required') {
          return res.status(400).json({
            error: `Session is ${session.status}, not awaiting approval`,
            sessionId,
          });
        }

        if (!approved) {
          // User denied — mark complete with partial results
          session.status = 'complete';
          session.pendingAction = null;
          await session.save();

          return res.json({
            status: 'complete',
            sessionId,
            iterationsUsed: session.iterationCount,
            message: 'Workflow completed without the requested action.',
            partialResults: session.accumulatedResults || [],
          });
        }

        // Approve the pending action type (and optionally all future actions of same type)
        const pendingType = session.pendingAction?.type;
        if (pendingType) {
          const approvedSet = new Set(session.approvedActions || []);
          approvedSet.add(pendingType);
          session.approvedActions = [...approvedSet];
          await session.save();
        }

        // Resume the workflow
        const rawResult = await runWorkflow({
          sessionId,
          openai,
          emitEvent: () => {},
          context: {
            ...(session.context || {}),
            preApprovedActions: session.approvedActions || [],
          },
        });

        if (rawResult.status === 'approval_required') {
          return res.status(202).json(rawResult);
        }

        const formatted = formatWorkflowOutput(rawResult, session.outputFormat || 'structured');
        res.json(formatted);

      } catch (error) {
        printLog(`[${requestId}] ERROR: ${error.message}`);
        console.error(`[${requestId}] Stack:`, error.stack);
        res.status(500).json({
          error: 'Approval resume failed',
          detail: error.message,
          sessionId,
        });
      }
    }
  );

  /**
   * GET /workflow/:sessionId
   * Check status of a workflow session.
   */
  router.get('/workflow/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    try {
      const session = await WorkflowSession.findOne({ sessionId })
        .select('sessionId status task workflowType iterationCount maxIterations pendingAction createdAt updatedAt')
        .lean();

      if (!session) {
        return res.status(404).json({ error: 'Session not found', sessionId });
      }

      res.json({
        sessionId: session.sessionId,
        status: session.status,
        task: session.task,
        workflowType: session.workflowType,
        iterationCount: session.iterationCount,
        maxIterations: session.maxIterations,
        pendingAction: session.pendingAction ? {
          type: session.pendingAction.type,
          description: session.pendingAction.description,
        } : null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch session', detail: error.message });
    }
  });

  return router;
}

module.exports = createWorkflowRoutes;
