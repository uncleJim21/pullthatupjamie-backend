const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

const { ResearchSession } = require('../models/ResearchSession');
const { SharedResearchSession } = require('../models/SharedResearchSession');
const { User } = require('../models/User');
const { getClipsByIds } = require('../agent-tools/pineconeTools');
const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid');
const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const DigitalOceanSpacesManager = require('../utils/DigitalOceanSpacesManager');
const fetch = require('node-fetch');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Validation and sharing configuration
const MAX_SHARE_NODES = parseInt(process.env.RESEARCH_SESSION_SHARE_MAX_NODES || '100', 10);
const MAX_NODE_COORDINATE = parseFloat(process.env.RESEARCH_SESSION_SHARE_MAX_COORD || '10000');
const MIN_NODE_COORDINATE = -MAX_NODE_COORDINATE;
const COLOR_HEX_REGEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// Image / CDN configuration
const SHARE_IMAGE_WIDTH = 1200;
const SHARE_IMAGE_HEIGHT = 630;
const SHARE_BASE_URL =
  (process.env.SHARE_BASE_URL && process.env.SHARE_BASE_URL.replace(/\/$/, '')) ||
  (process.env.FRONTEND_URL && process.env.FRONTEND_URL.replace(/\/$/, '')) ||
  'http://localhost:3001/share-session';

const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT;
const SPACES_ACCESS_KEY_ID = process.env.SPACES_ACCESS_KEY_ID;
const SPACES_SECRET_ACCESS_KEY = process.env.SPACES_SECRET_ACCESS_KEY;
const SPACES_BUCKET_NAME = process.env.SPACES_BUCKET_NAME;

// Lazily instantiated Spaces manager to avoid work if not used
let sharedPreviewSpacesManager = null;
function getSharedPreviewSpacesManager() {
  if (
    !SPACES_ENDPOINT ||
    !SPACES_ACCESS_KEY_ID ||
    !SPACES_SECRET_ACCESS_KEY ||
    !SPACES_BUCKET_NAME
  ) {
    throw new Error('Missing Spaces configuration for shared research session previews');
  }
  if (!sharedPreviewSpacesManager) {
    sharedPreviewSpacesManager = new DigitalOceanSpacesManager(
      SPACES_ENDPOINT,
      SPACES_ACCESS_KEY_ID,
      SPACES_SECRET_ACCESS_KEY,
      {
        maxRetries: 3,
        baseDelay: 500,
        maxDelay: 4000,
        timeout: 20000
      }
    );
  }
  return sharedPreviewSpacesManager;
}

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

    // De-duplicate while preserving order
    const seen = new Set();
    const uniquePineconeIds = pineconeIds.filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // Enforce a hard limit of 50 items per research session
    if (uniquePineconeIds.length > 50) {
      return res.status(400).json({
        error: 'Too many items',
        details: 'A research session can contain at most 50 unique items'
      });
    }

    // Fetch metadata snapshots from Pinecone once at creation time
    const clips = await getClipsByIds(uniquePineconeIds);

    // Map clips by shareLink for quick lookup
    const clipById = new Map();
    clips.forEach(clip => {
      if (clip && clip.shareLink) {
        // Strip embedding before storing snapshot
        const { embedding, ...rest } = clip;
        clipById.set(clip.shareLink, rest);
      }
    });

    const items = uniquePineconeIds.map(id => {
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
      pineconeIds: uniquePineconeIds,
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

    // Append new Pinecone IDs if provided (preserve order, avoid duplicates)
    if (Array.isArray(pineconeIds) && pineconeIds.length > 0) {
      const existingIds = Array.isArray(session.pineconeIds) ? session.pineconeIds : [];
      const seen = new Set(existingIds);

      const uniqueNewIds = pineconeIds.filter(id => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      if (uniqueNewIds.length > 0) {
        const newTotal = existingIds.length + uniqueNewIds.length;
        if (newTotal > 50) {
          return res.status(400).json({
            error: 'Too many items',
            details: 'A research session can contain at most 50 unique items'
          });
        }

        session.pineconeIds = [...existingIds, ...uniqueNewIds];

        // Fetch metadata snapshots for newly added IDs
        const clips = await getClipsByIds(uniqueNewIds);
        const clipById = new Map();
        clips.forEach(clip => {
          if (clip && clip.shareLink) {
            // Strip embedding before storing snapshot
            const { embedding, ...rest } = clip;
            clipById.set(clip.shareLink, rest);
          }
        });

        const newItems = uniqueNewIds.map(id => {
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

/**
 * Helper to derive a reasonable default share title from lastItemMetadata.
 */
function deriveShareTitleFromLastItem(lastItemMetadata) {
  const fallback = 'Podcast Research Session';
  if (!lastItemMetadata || typeof lastItemMetadata !== 'object') {
    return fallback;
  }

  const candidate =
    lastItemMetadata.headline ||
    lastItemMetadata.title ||
    lastItemMetadata.episode ||
    lastItemMetadata.summary;

  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return fallback;
}

/**
 * Normalize and validate share nodes, enforcing limits and returning
 * a sanitized array with unique pineconeIds.
 */
function sanitizeShareNodes(rawNodes) {
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    const err = new Error('nodes must be a non-empty array');
    err.statusCode = 400;
    err.details = 'nodes must be a non-empty array of node objects';
    throw err;
  }

  if (rawNodes.length > MAX_SHARE_NODES) {
    const err = new Error('Too many nodes');
    err.statusCode = 400;
    err.details = `A shared research session snapshot can contain at most ${MAX_SHARE_NODES} nodes`;
    throw err;
  }

  const seen = new Set();
  const sanitized = [];

  rawNodes.forEach((node, index) => {
    if (!node || typeof node !== 'object') {
      const err = new Error(`Invalid node at index ${index}`);
      err.statusCode = 400;
      err.details = `Node at index ${index} must be an object`;
      throw err;
    }

    const { pineconeId, x, y, z, color } = node;

    if (typeof pineconeId !== 'string' || pineconeId.trim().length === 0) {
      const err = new Error(`Invalid pineconeId at index ${index}`);
      err.statusCode = 400;
      err.details = `Node at index ${index} is missing a valid pineconeId`;
      throw err;
    }

    if (seen.has(pineconeId)) {
      // Skip duplicate pineconeIds while preserving the first occurrence
      return;
    }
    seen.add(pineconeId);

    const coords = { x, y, z };
    for (const key of ['x', 'y', 'z']) {
      const value = coords[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        const err = new Error(`Invalid coordinate ${key} for node ${pineconeId}`);
        err.statusCode = 400;
        err.details = `Coordinate ${key} for node ${pineconeId} must be a finite number`;
        throw err;
      }
      if (value < MIN_NODE_COORDINATE || value > MAX_NODE_COORDINATE) {
        const err = new Error(`Coordinate ${key} out of range for node ${pineconeId}`);
        err.statusCode = 400;
        err.details = `Coordinate ${key} for node ${pineconeId} must be between ${MIN_NODE_COORDINATE} and ${MAX_NODE_COORDINATE}`;
        throw err;
      }
    }

    if (typeof color !== 'string' || !COLOR_HEX_REGEX.test(color)) {
      const err = new Error(`Invalid color for node ${pineconeId}`);
      err.statusCode = 400;
      err.details = `Color for node ${pineconeId} must be a hex string like "#RRGGBB" or "#RRGGBBAA"`;
      throw err;
    }

    sanitized.push({
      pineconeId,
      x,
      y,
      z,
      color
    });
  });

  if (sanitized.length === 0) {
    const err = new Error('No unique nodes after de-duplication');
    err.statusCode = 400;
    err.details = 'All provided nodes were duplicates; at least one unique node is required';
    throw err;
  }

  return sanitized;
}

async function fetchImageBufferWithTimeout(url, timeoutMs) {
  if (!url) return null;

  const controller = new fetch.AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch image: status ${response.status}`);
    }
    const buffer = await response.buffer();
    return buffer;
  } catch (err) {
    console.warn('[SharedResearchSession] Error fetching cover art image:', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSharedSessionPreviewImage({ shareId, title, lastItemMetadata, nodes }) {
  const width = SHARE_IMAGE_WIDTH;
  const height = SHARE_IMAGE_HEIGHT;
  const constellationHeight = Math.floor(height * 0.7);
  const bannerHeight = height - constellationHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#020617'; // slate-950-esque
  ctx.fillRect(0, 0, width, height);

  // Constellation region
  const margin = 60;
  const centerX = width / 2;
  const centerY = constellationHeight / 2;

  const xs = nodes.map(n => n.x);
  const ys = nodes.map(n => n.y);
  const meanX = xs.reduce((a, b) => a + b, 0) / nodes.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / nodes.length;

  let maxRadius = 1;
  nodes.forEach(n => {
    const dx = n.x - meanX;
    const dy = n.y - meanY;
    const r = Math.max(Math.abs(dx), Math.abs(dy));
    if (r > maxRadius) maxRadius = r;
  });

  const radiusPixels = Math.min(centerX - margin, centerY - margin);
  const scale = maxRadius > 0 ? radiusPixels / maxRadius : 1;

  // Optional subtle grid / vignette
  ctx.save();
  const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radiusPixels + margin);
  gradient.addColorStop(0, 'rgba(15,23,42,1)');
  gradient.addColorStop(1, 'rgba(15,23,42,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, constellationHeight);
  ctx.restore();

  // Draw nodes
  ctx.save();
  ctx.globalAlpha = 0.95;

  nodes.forEach(n => {
    const dx = n.x - meanX;
    const dy = n.y - meanY;
    const screenX = centerX + dx * scale;
    const screenY = centerY - dy * scale;

    ctx.beginPath();
    ctx.fillStyle = n.color;
    const baseRadius = 6;
    const depthFactor = typeof n.z === 'number' ? 1 + (n.z / (2 * MAX_NODE_COORDINATE)) : 1;
    const radius = Math.max(3, Math.min(10, baseRadius * depthFactor));
    ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.restore();

  // Banner
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, constellationHeight, width, bannerHeight);

  const bannerPadding = 40;
  const thumbSize = bannerHeight - bannerPadding * 2;
  const thumbX = bannerPadding;
  const thumbY = constellationHeight + bannerPadding;

  // Resolve cover art or placeholder
  const coverArtUrl =
    (lastItemMetadata && (lastItemMetadata.episodeImage || lastItemMetadata.imageUrl || lastItemMetadata.podcastImage)) ||
    null;

  const placeholderPath = path.join(__dirname, '..', 'assets', 'watermark.png');

  let coverImage = null;
  try {
    const buffer = await fetchImageBufferWithTimeout(coverArtUrl, 3000);
    if (buffer) {
      coverImage = await loadImage(buffer);
    }
  } catch (e) {
    console.warn('[SharedResearchSession] Error loading remote cover art, falling back to placeholder:', e.message);
  }

  if (!coverImage) {
    try {
      coverImage = await loadImage(placeholderPath);
    } catch (e) {
      console.warn('[SharedResearchSession] Error loading placeholder image:', e.message);
      coverImage = null;
    }
  }

  // Draw thumbnail if we have any image
  if (coverImage) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(
      thumbX + thumbSize / 2,
      thumbY + thumbSize / 2,
      thumbSize / 2,
      0,
      Math.PI * 2
    );
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(coverImage, thumbX, thumbY, thumbSize, thumbSize);
    ctx.restore();
  }

  // Title and subtitle
  const textX = thumbX + thumbSize + bannerPadding;
  const textY = thumbY;
  const maxTextWidth = width - textX - bannerPadding;

  ctx.fillStyle = '#F9FAFB';
  ctx.font = 'bold 40px sans-serif';
  ctx.textBaseline = 'top';

  // Simple single-line ellipsis for title
  let displayTitle = title || 'Podcast Research Session';
  if (ctx.measureText(displayTitle).width > maxTextWidth) {
    while (displayTitle.length > 3 && ctx.measureText(displayTitle + '…').width > maxTextWidth) {
      displayTitle = displayTitle.slice(0, -1);
    }
    displayTitle = displayTitle + '…';
  }
  ctx.fillText(displayTitle, textX, textY);

  ctx.font = '24px sans-serif';
  ctx.fillStyle = '#9CA3AF';
  const subtitle = 'Podcast Mind Map';
  ctx.fillText(subtitle, textX, textY + 50);

  const buffer = canvas.toBuffer('image/png');

  const spacesManager = getSharedPreviewSpacesManager();
  const key = `shared-sessions/${shareId}/preview.png`;
  const url = await spacesManager.uploadFile(SPACES_BUCKET_NAME, key, buffer, 'image/png');
  return url;
}

/**
 * POST /api/research-sessions/:id/share
 *
 * Create an immutable, shareable snapshot of a research session and generate a preview image.
 */
router.post('/:id/share', async (req, res) => {
  try {
    const owner = await resolveOwner(req);
    if (!owner) {
      return res.status(400).json({
        error: 'Missing owner identifier',
        details: 'Provide a valid JWT token or a clientId (query param, header, or body)'
      });
    }

    const { id } = req.params;
    const { title, nodes, camera, visibility } = req.body || {};

    const ownerQuery = owner.userId
      ? { _id: id, userId: owner.userId }
      : { _id: id, clientId: owner.clientId };

    const baseSession = await ResearchSession.findOne(ownerQuery).lean().exec();
    if (!baseSession) {
      return res.status(404).json({
        error: 'Research session not found',
        details: 'No session found for this id and owner'
      });
    }

    let sanitizedNodes;
    try {
      sanitizedNodes = sanitizeShareNodes(nodes);
    } catch (validationError) {
      console.error('[SharedResearchSession] Node validation error:', validationError.message);
      return res.status(validationError.statusCode || 400).json({
        error: 'Invalid snapshot',
        details: validationError.details || validationError.message
      });
    }

    const resolvedTitle =
      typeof title === 'string' && title.trim().length > 0
        ? title.trim()
        : deriveShareTitleFromLastItem(baseSession.lastItemMetadata);

    const resolvedVisibility =
      visibility === 'public' || visibility === 'unlisted' ? visibility : 'unlisted';

    const shareId = uuidv4().replace(/-/g, '').slice(0, 12);
    const shareUrl = `${SHARE_BASE_URL}/${shareId}`;

    const sharedDoc = new SharedResearchSession({
      researchSessionId: baseSession._id,
      userId: baseSession.userId || null,
      clientId: baseSession.clientId || null,
      shareId,
      shareUrl,
      title: resolvedTitle,
      visibility: resolvedVisibility,
      nodes: sanitizedNodes,
      camera: camera && typeof camera === 'object' ? camera : undefined,
      lastItemMetadata: baseSession.lastItemMetadata || null,
      previewImageUrl: null
    });

    await sharedDoc.save();

    let previewImageUrl = null;
    try {
      previewImageUrl = await generateSharedSessionPreviewImage({
        shareId,
        title: resolvedTitle,
        lastItemMetadata: baseSession.lastItemMetadata || null,
        nodes: sanitizedNodes
      });
      sharedDoc.previewImageUrl = previewImageUrl;
      await sharedDoc.save();
    } catch (imageError) {
      console.error('[SharedResearchSession] Error generating or uploading preview image:', imageError);
      // We intentionally do not fail due to image issues beyond external assets.
      // The shared session remains valid; previewImageUrl may be null.
    }

    return res.status(201).json({
      success: true,
      data: {
        shareId,
        shareUrl,
        previewImageUrl
      }
    });
  } catch (error) {
    console.error('[SharedResearchSession] Error sharing research session:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: 'Error creating shared research session'
    });
  }
});

/**
 * POST /api/research-sessions/:id/analyze
 *
 * Analyze a specific research session with an LLM (gpt-4o-mini) and stream back the response.
 * Optional body: { "instructions": "custom prompt text" }
 */
router.post('/:id/analyze', async (req, res) => {
  try {
    const owner = await resolveOwner(req);
    if (!owner) {
      return res.status(400).json({
        error: 'Missing owner identifier',
        details: 'Provide a valid JWT token or a clientId (query param, header, or body)'
      });
    }

    const { id } = req.params;
    const { instructions } = req.body || {};

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

    const items = Array.isArray(session.items) ? session.items : [];

    if (!items.length) {
      return res.status(400).json({
        error: 'Empty session',
        details: 'This research session has no items to analyze'
      });
    }

    // Build a concise text context from the session items (cap at 20 items)
    const MAX_ITEMS = 20;
    const limitedItems = items.slice(0, MAX_ITEMS);

    const contextLines = limitedItems.map((item, index) => {
      const meta = item.metadata || {};
      const quote = meta.quote || meta.summary || meta.headline || '(no quote)';
      const episode = meta.episode || 'Unknown episode';
      const creator = meta.creator || 'Unknown creator';
      const audioUrl = meta.audioUrl || '';
      const startTime = meta.timeContext?.start_time ?? null;
      const startSeconds = typeof startTime === 'number' && !Number.isNaN(startTime)
        ? Math.floor(startTime)
        : null;

      return [
        `Item ${index + 1}:`,
        `Episode: ${episode}`,
        `Creator: ${creator}`,
        audioUrl ? `AudioUrl: ${audioUrl}` : 'AudioUrl: (not available)',
        startSeconds !== null
          ? `StartTimeSeconds: ${startSeconds}`
          : 'StartTimeSeconds: (unknown)',
        `Quote: ${quote}`,
        ''
      ].join('\n');
    });

    const contextText = contextLines.join('\n---\n');

    const baseInstructions = `
You are an AI assistant analyzing a research session composed of podcast clips.

You will receive:
- A list of items, each with episode title, creator, a short quote,
  and when available: an AudioUrl and a StartTimeSeconds value.

Your goals:
1. Summarize the key themes and ideas across all items.
2. Call out any patterns, contradictions, or notable perspectives.
3. Suggest 3–5 follow-up questions or angles for deeper research.

Source citation requirements (IMPORTANT):
- When you reference a specific item or quote, and BOTH AudioUrl and StartTimeSeconds are available,
  append an inline source in this exact format on the SAME line:
  {AudioUrl}#t={StartTimeSeconds}
  Example: https://example.com/audio.mp3#t=300
- If either AudioUrl or StartTimeSeconds is missing, you may omit the source.

Output format (IMPORTANT):
- On the FIRST line, output: TITLE: <concise title, max 8 words, no quotes, no emojis>.
- On the SECOND line, output a single blank line.
- Starting from the THIRD line, output your full analysis of the research session
  following the source citation rules above.

Do NOT output anything before the TITLE line. Be concise but insightful. Assume the reader is technical and curious.
`.trim();

    const userInstructions = (typeof instructions === 'string' && instructions.trim().length > 0)
      ? instructions.trim()
      : 'Use the default analysis goals above.';

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [
        { role: 'system', content: baseInstructions },
        {
          role: 'user',
          content: `Here is the research session context:\n\n${contextText}\n\nUser instructions: ${userInstructions}`
        }
      ],
      temperature: 0.4
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content || '';
      if (content) {
        res.write(content);
      }
    }

    res.end();
  } catch (error) {
    console.error('[ResearchSessions] Error analyzing session with AI:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        details: 'Error analyzing research session with AI'
      });
    } else {
      res.end();
    }
  }
});

module.exports = router;

