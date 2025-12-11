const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

const { ResearchSession } = require('../models/ResearchSession');
const { User } = require('../models/User');
const { getClipsByIds } = require('../agent-tools/pineconeTools');

/**
 * Resolve the logical owner of a research session for the current request.
 * - Prefer authenticated User (via JWT Bearer token)
 * - Fallback to anonymous clientId (from query, header, or body)
 *
 * Returns:
 *   { userId, clientId, ownerType } or null if no owner can be resolved
 */
async function resolveOwner(req) {
  let userId = null;

  // Try to resolve authenticated user from JWT (if provided)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
      const email = decoded?.email;
      if (email) {
        const user = await User.findOne({ email }).select('_id');
        if (user) {
          userId = user._id;
        }
      }
    } catch (err) {
      console.warn('[ResearchSessions] Failed to verify JWT, treating as anonymous:', err.message);
    }
  }

  // Accept clientId for anonymous usage
  const clientId =
    (req.query && req.query.clientId) ||
    req.headers['x-client-id'] ||
    (req.body && req.body.clientId) ||
    null;

  if (userId) {
    return { userId, clientId: null, ownerType: 'user' };
  }
  if (clientId) {
    return { userId: null, clientId, ownerType: 'client' };
  }

  return null;
}

/**
 * GET /api/research-sessions
 *
 * Return all research sessions for the current owner (user or clientId),
 * including each session's id and the last item's metadata.
 *
 * Owner resolution:
 *   - If a valid Bearer JWT is provided, use the associated User
 *   - Otherwise, require a clientId (query param ?clientId=..., X-Client-Id header, or body.clientId)
 */
router.get('/', async (req, res) => {
  try {
    const owner = await resolveOwner(req);
    if (!owner) {
      return res.status(400).json({
        error: 'Missing owner identifier',
        details: 'Provide a valid JWT token or a clientId (query param, X-Client-Id header, or body.clientId)'
      });
    }

    const query = owner.userId
      ? { userId: owner.userId }
      : { clientId: owner.clientId };

    const sessions = await ResearchSession.find(query)
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    const data = sessions.map((session) => ({
      id: session._id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      pineconeIdsCount: Array.isArray(session.pineconeIds)
        ? session.pineconeIds.length
        : 0,
      lastItemMetadata: session.lastItemMetadata || null
    }));

    res.json({
      success: true,
      ownerType: owner.ownerType,
      count: data.length,
      data
    });
  } catch (error) {
    console.error('[ResearchSessions] Error fetching sessions:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: 'Error fetching research sessions'
    });
  }
});

/**
 * POST /api/research-sessions
 *
 * Create a new research session for the current owner (user or clientId).
 *
 * Why POST (not PUT)?
 * - POST is idiomatic for creating new resources where the server assigns the ID.
 * - PUT is typically used for full replacement of a known resource at a stable URL
 *   (/api/research-sessions/:id), which we are not doing here.
 *
 * Expected body:
 * {
 *   "clientId": "optional-when-authenticated",
 *   "pineconeIds": ["id1", "id2", ...],   // required, ordered
 *   "lastItemMetadata": { ... }           // optional, metadata for the last item
 * }
 */
router.post('/', async (req, res) => {
  try {
    const owner = await resolveOwner(req);
    if (!owner) {
      return res.status(400).json({
        error: 'Missing owner identifier',
        details: 'Provide a valid JWT token or a clientId (query param, header, or body)'
      });
    }

    const { pineconeIds, lastItemMetadata } = req.body || {};

    if (!Array.isArray(pineconeIds) || pineconeIds.length === 0) {
      return res.status(400).json({
        error: 'Invalid pineconeIds',
        details: 'pineconeIds must be a non-empty array of strings'
      });
    }

    // Basic type validation (best-effort)
    const allStrings = pineconeIds.every(id => typeof id === 'string');
    if (!allStrings) {
      return res.status(400).json({
        error: 'Invalid pineconeIds',
        details: 'All pineconeIds entries must be strings'
      });
    }

    // Enforce a hard limit of 50 items per research session
    if (pineconeIds.length > 50) {
      return res.status(400).json({
        error: 'Too many items',
        details: 'A research session can contain at most 50 items'
      });
    }

    // Fetch metadata snapshots from Pinecone once at creation time
    const clips = await getClipsByIds(pineconeIds);

    // Map clips by shareLink for quick lookup
    const clipById = new Map();
    clips.forEach(clip => {
      if (clip && clip.shareLink) {
        // Strip embedding before storing snapshot
        const { embedding, ...rest } = clip;
        clipById.set(clip.shareLink, rest);
      }
    });

    const items = pineconeIds.map(id => {
      const raw = clipById.get(id) || null;
      return {
        pineconeId: id,
        metadata: raw
      };
    });

    // Derive lastItemMetadata from the last clip when possible, fall back to request body
    const lastClip = items.length > 0
      ? items[items.length - 1].metadata
      : null;

    const session = new ResearchSession({
      userId: owner.userId || undefined,
      clientId: owner.clientId || undefined,
      pineconeIds,
      items,
      lastItemMetadata:
        typeof lastItemMetadata !== 'undefined'
          ? lastItemMetadata
          : (lastClip || null)
    });

    await session.save();

    return res.status(201).json({
      success: true,
      data: {
        id: session._id,
        ownerType: owner.ownerType,
        userId: session.userId || null,
        clientId: session.clientId || null,
        pineconeIds: session.pineconeIds,
        pineconeIdsCount: session.pineconeIds.length,
        lastItemMetadata: session.lastItemMetadata,
        items: session.items,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }
    });
  } catch (error) {
    console.error('[ResearchSessions] Error creating session:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: 'Error creating research session'
    });
  }
});

/**
 * PATCH /api/research-sessions/:id
 *
 * Append new Pinecone IDs to an existing session and/or update lastItemMetadata.
 * This does NOT upsert: the session must already exist and belong to the caller.
 *
 * Expected body (all fields optional but at least one required):
 * {
 *   "pineconeIds": ["new-id-1", "new-id-2"],
 *   "lastItemMetadata": { ... }
 * }
 */
router.patch('/:id', async (req, res) => {
  try {
    const owner = await resolveOwner(req);
    if (!owner) {
      return res.status(400).json({
        error: 'Missing owner identifier',
        details: 'Provide a valid JWT token or a clientId (query param, header, or body)'
      });
    }

    const { id } = req.params;
    const { pineconeIds, lastItemMetadata } = req.body || {};

    if (
      (typeof pineconeIds === 'undefined' || pineconeIds === null) &&
      typeof lastItemMetadata === 'undefined'
    ) {
      return res.status(400).json({
        error: 'No update fields provided',
        details: 'Provide pineconeIds and/or lastItemMetadata'
      });
    }

    if (typeof pineconeIds !== 'undefined') {
      if (!Array.isArray(pineconeIds)) {
        return res.status(400).json({
          error: 'Invalid pineconeIds',
          details: 'pineconeIds must be an array of strings when provided'
        });
      }
      const allStrings = pineconeIds.every(val => typeof val === 'string');
      if (!allStrings) {
        return res.status(400).json({
          error: 'Invalid pineconeIds',
          details: 'All pineconeIds entries must be strings'
        });
      }
    }

    const ownerQuery = owner.userId
      ? { _id: id, userId: owner.userId }
      : { _id: id, clientId: owner.clientId };

    const session = await ResearchSession.findOne(ownerQuery);
    if (!session) {
      return res.status(404).json({
        error: 'Research session not found',
        details: 'No session found for this id and owner'
      });
    }

    // Append new Pinecone IDs if provided (preserve existing order)
    if (Array.isArray(pineconeIds) && pineconeIds.length > 0) {
      const newTotal = session.pineconeIds.length + pineconeIds.length;
      if (newTotal > 50) {
        return res.status(400).json({
          error: 'Too many items',
          details: 'A research session can contain at most 50 items'
        });
      }

      session.pineconeIds = [
        ...session.pineconeIds,
        ...pineconeIds
      ];

      // Fetch metadata snapshots for newly added IDs
      const clips = await getClipsByIds(pineconeIds);
      const clipById = new Map();
      clips.forEach(clip => {
        if (clip && clip.shareLink) {
          // Strip embedding before storing snapshot
          const { embedding, ...rest } = clip;
          clipById.set(clip.shareLink, rest);
        }
      });

      const newItems = pineconeIds.map(id => {
        const raw = clipById.get(id) || null;
        return {
          pineconeId: id,
          metadata: raw
        };
      });

      session.items = [
        ...(session.items || []),
        ...newItems
      ];
    }

    // Update lastItemMetadata if provided, otherwise keep it in sync with the last item metadata
    if (typeof lastItemMetadata !== 'undefined') {
      session.lastItemMetadata = lastItemMetadata;
    } else if (Array.isArray(session.items) && session.items.length > 0) {
      const last = session.items[session.items.length - 1];
      session.lastItemMetadata = last?.metadata || session.lastItemMetadata;
    }

    await session.save();

    return res.json({
      success: true,
      data: {
        id: session._id,
        ownerType: owner.ownerType,
        userId: session.userId || null,
        clientId: session.clientId || null,
        pineconeIds: session.pineconeIds,
        pineconeIdsCount: session.pineconeIds.length,
        lastItemMetadata: session.lastItemMetadata,
        items: session.items,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }
    });
  } catch (error) {
    console.error('[ResearchSessions] Error updating session:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: 'Error updating research session'
    });
  }
});

/**
 * GET /api/research-sessions/:id
 *
 * Return a specific research session plus full Pinecone data for all pineconeIds.
 */
router.get('/:id', async (req, res) => {
  try {
    const owner = await resolveOwner(req);
    if (!owner) {
      return res.status(400).json({
        error: 'Missing owner identifier',
        details: 'Provide a valid JWT token or a clientId (query param, header, or body)'
      });
    }

    const { id } = req.params;

    const ownerQuery = owner.userId
      ? { _id: id, userId: owner.userId }
      : { _id: id, clientId: owner.clientId };

    let session = await ResearchSession.findOne(ownerQuery).lean().exec();

    // Fallback: if not found for this owner, allow lookup by id only
    if (!session) {
      session = await ResearchSession.findById(id).lean().exec();
      if (!session) {
        return res.status(404).json({
          error: 'Research session not found',
          details: 'No session found for this id'
        });
      }
    }

    const pineconeIds = Array.isArray(session.pineconeIds) ? session.pineconeIds : [];

    let items = [];
    if (Array.isArray(session.items) && session.items.length > 0) {
      // Prefer stored metadata snapshots when available, and ensure embeddings are not exposed
      items = session.items
        .map(entry => entry?.metadata || null)
        .filter(Boolean)
        .map(meta => {
          const { embedding, ...rest } = meta;
          return rest;
        });
    } else if (pineconeIds.length > 0) {
      // Fallback for legacy sessions without stored metadata
      const clips = await getClipsByIds(pineconeIds);
      items = clips.map(clip => {
        const { embedding, ...rest } = clip || {};
        return rest;
      });
    }

    return res.json({
      success: true,
      data: {
        session: {
          id: session._id,
          ownerType: owner.ownerType,
          userId: session.userId || null,
          clientId: session.clientId || null,
          pineconeIds,
          pineconeIdsCount: pineconeIds.length,
          lastItemMetadata: session.lastItemMetadata || null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        },
        items
      }
    });
  } catch (error) {
    console.error('[ResearchSessions] Error fetching session with Pinecone data:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: 'Error fetching research session with Pinecone data'
    });
  }
});

module.exports = router;

