const express = require('express');
const router = express.Router();

const { OpenAI } = require('openai');
const { resolveOwner } = require('../utils/resolveOwner');
const { normalizePineconeIds, streamResearchAnalysis } = require('../utils/researchAnalysis');
const { createEntitlementMiddleware } = require('../utils/entitlementMiddleware');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * POST /api/research/analyze
 *
 * Ad-hoc analysis endpoint (no session required). Streams text response.
 *
 * Body:
 * {
 *   "instructions": "string",
 *   "pineconeIds": ["id1_p123", "id2_p45"]
 * }
 */
router.post('/analyze', createEntitlementMiddleware('researchAnalyze'), async (req, res) => {
  try {
    const owner = await resolveOwner(req);
    if (!owner) {
      return res.status(400).json({
        error: 'Missing owner identifier',
        details: 'Provide a valid JWT token or a clientId (query param, header, or body)'
      });
    }

    const { instructions, pineconeIds } = req.body || {};
    const { ordered, dropped } = normalizePineconeIds(pineconeIds, 50);

    if (!ordered.length) {
      return res.status(400).json({
        error: 'Missing pineconeIds',
        details: 'Provide a non-empty pineconeIds array (max 50)'
      });
    }

    // Observability (lax access model for now; no per-id ownership enforcement)
    console.log('[ResearchAnalyze] /api/research/analyze', {
      ownerType: owner.ownerType,
      requestedCount: Array.isArray(pineconeIds) ? pineconeIds.length : 0,
      uniqueCount: ordered.length,
      droppedCount: dropped.length
    });

    await streamResearchAnalysis({
      openai,
      res,
      orderedPineconeIds: ordered,
      instructions
    });
  } catch (error) {
    console.error('[ResearchAnalyze] Error analyzing ad-hoc pineconeIds with AI:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        error: error.statusCode === 400 ? 'Invalid request' : 'Internal server error',
        details: error.details || error.message || 'Error analyzing pineconeIds'
      });
    } else {
      res.end();
    }
  }
});

module.exports = router;

