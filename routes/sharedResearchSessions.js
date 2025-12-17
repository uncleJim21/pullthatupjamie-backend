const express = require('express');
const router = express.Router();

const { SharedResearchSession } = require('../models/SharedResearchSession');

/**
 * GET /api/shared-research-sessions/:shareId
 *
 * Public endpoint to fetch metadata for a shared research session by its shareId.
 * Intended primarily for link unfurling and lightweight preview cards.
 *
 * Response shape:
 * {
 *   "success": true,
 *   "data": {
 *     "shareId": "8d5417e36d3d",
 *     "shareUrl": "https://pullthatupjamie.ai/8d5417e36d3d",
 *     "title": "Some Title",
 *     "description": "Short description / quote...",
 *     "previewImageUrl": "https://.../preview.jpg",
 *     "visibility": "public" | "unlisted",
 *     "lastItemMetadata": { ... },   // optional, for richer clients
 *     "nodes": [ ... ],              // optional snapshot state
 *     "camera": { ... },             // optional camera config
 *     "createdAt": "...",
 *     "updatedAt": "..."
 *   }
 * }
 */
router.get('/:shareId', async (req, res) => {
  try {
    const { shareId } = req.params;
    if (!shareId || typeof shareId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Invalid shareId',
        details: 'shareId path parameter is required'
      });
    }

    const shared = await SharedResearchSession.findOne({ shareId }).lean().exec();
    if (!shared) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        details: 'No shared research session found for this shareId'
      });
    }

    const last = shared.lastItemMetadata || {};
    const description =
      (typeof last.description === 'string' && last.description.trim()) ||
      (typeof last.summary === 'string' && last.summary.trim()) ||
      (typeof last.quote === 'string' && last.quote.trim()) ||
      null;

    return res.json({
      success: true,
      data: {
        researchSessionId: shared.researchSessionId,
        shareId: shared.shareId,
        shareUrl: shared.shareUrl,
        title: shared.title,
        description,
        previewImageUrl: shared.previewImageUrl || null,
        visibility: shared.visibility,
        lastItemMetadata: shared.lastItemMetadata || null,
        nodes: shared.nodes || [],
        camera: shared.camera || null,
        createdAt: shared.createdAt,
        updatedAt: shared.updatedAt
      }
    });
  } catch (err) {
    console.error('[SharedResearchSession] Error in GET /api/shared-research-sessions/:shareId:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: 'Error fetching shared research session metadata'
    });
  }
});

module.exports = router;

