const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

const { ResearchSession } = require('../models/ResearchSession');
const { SharedResearchSession } = require('../models/SharedResearchSession');
const { User } = require('../models/User');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { getClipsByIdsBatch } = require('../agent-tools/pineconeTools');
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
let cachedNebulaBackgroundImagePromise = null;
const NEBULA_BACKGROUND_PATH = path.join(__dirname, '..', 'assets', 'nebula-background.png');

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

async function getNebulaBackgroundImage() {
  if (!cachedNebulaBackgroundImagePromise) {
    cachedNebulaBackgroundImagePromise = loadImage(NEBULA_BACKGROUND_PATH).catch((err) => {
      console.error('[SharedResearchSession] Failed to load nebula background image:', err.message);
      cachedNebulaBackgroundImagePromise = null;
      return null;
    });
  }
  return cachedNebulaBackgroundImagePromise;
}

function toTitleCase(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .split(/\s+/)
    .map((word) => {
      if (!word) return word;
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

async function generateSmartShareTitle(lastItemMetadata, fallbackTitle) {
  try {
    if (!lastItemMetadata || typeof lastItemMetadata !== 'object') {
      return fallbackTitle;
    }

    const parts = [];
    if (lastItemMetadata.headline) {
      parts.push(`Headline: ${lastItemMetadata.headline}`);
    }
    if (lastItemMetadata.summary) {
      parts.push(`Summary: ${lastItemMetadata.summary}`);
    }
    if (lastItemMetadata.quote) {
      parts.push(`Quote: ${lastItemMetadata.quote}`);
    }
    if (lastItemMetadata.episode) {
      parts.push(`Episode: ${lastItemMetadata.episode}`);
    }
    if (lastItemMetadata.creator) {
      parts.push(`Creator: ${lastItemMetadata.creator}`);
    }

    const context = parts.join('\n');
    if (!context) {
      return fallbackTitle;
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You generate concise, compelling titles for podcast mind maps. ' +
            'Use natural title casing as you would for an article headline. ' +
            'Preserve the capitalization of acronyms and abbreviations (e.g., "EV", "AI", "NASA") ' +
            'and do not change the capitalization of proper nouns or branded names found in the context. ' +
            'Respond with ONLY the final title text, max 40 characters, no surrounding quotes or emojis.'
        },
        {
          role: 'user',
          content: `Based on this context, suggest a short title:\n\n${context}\n\nTitle:`
        }
      ],
      max_tokens: 32,
      temperature: 0.5
    });

    const raw = response.choices?.[0]?.message?.content || '';
    const firstLine = raw.split('\n')[0].trim();
    const cleaned = firstLine.replace(/^["']|["']$/g, '').trim();
    return cleaned || fallbackTitle;
  } catch (err) {
    console.warn('[SharedResearchSession] Failed to generate smart share title:', err.message);
    return fallbackTitle;
  }
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
      title: session.title || null,
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

    const { pineconeIds, lastItemMetadata, coordinatesById } = req.body || {};

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
    const clips = await getClipsByIdsBatch(uniquePineconeIds);

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

      // Optional client-provided coordinates for this item (used by 3D fetch endpoint)
      const coords =
        coordinatesById &&
        typeof coordinatesById === 'object' &&
        coordinatesById[id];

      const safeCoords =
        coords && typeof coords === 'object'
          ? {
              x: typeof coords.x === 'number' ? coords.x : null,
              y: typeof coords.y === 'number' ? coords.y : null,
              z: typeof coords.z === 'number' ? coords.z : null
            }
          : null;

      return {
        pineconeId: id,
        metadata: raw,
        ...(safeCoords && { coordinates3d: safeCoords })
      };
    });

    // Derive lastItemMetadata from the last clip when possible, fall back to request body
    const lastClip = items.length > 0
      ? items[items.length - 1].metadata
      : null;

    const effectiveLastItemMetadata =
      typeof lastItemMetadata !== 'undefined'
        ? lastItemMetadata
        : (lastClip || null);

    const defaultTitle = deriveShareTitleFromLastItem(effectiveLastItemMetadata);
    const sessionTitle = await generateSmartShareTitle(effectiveLastItemMetadata, defaultTitle);

    const session = new ResearchSession({
      userId: owner.userId || undefined,
      clientId: owner.clientId || undefined,
      pineconeIds: uniquePineconeIds,
      items,
      title: sessionTitle,
      lastItemMetadata: effectiveLastItemMetadata
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
    const { pineconeIds, lastItemMetadata, coordinatesById, expectedVersion } = req.body || {};

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

    if (typeof expectedVersion === 'number') {
      ownerQuery.__v = expectedVersion;
    }

    const session = await ResearchSession.findOne(ownerQuery);
    if (!session) {
      if (typeof expectedVersion === 'number') {
        return res.status(409).json({
          error: 'Conflict',
          details: 'Session was modified by another client',
          code: 'VERSION_MISMATCH'
        });
      }

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
        const clips = await getClipsByIdsBatch(uniqueNewIds);
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

          const coords =
            coordinatesById &&
            typeof coordinatesById === 'object' &&
            coordinatesById[id];

          const safeCoords =
            coords && typeof coords === 'object'
              ? {
                  x: typeof coords.x === 'number' ? coords.x : null,
                  y: typeof coords.y === 'number' ? coords.y : null,
                  z: typeof coords.z === 'number' ? coords.z : null
                }
              : null;

          return {
            pineconeId: id,
            metadata: raw,
            ...(safeCoords && { coordinates3d: safeCoords })
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
    const { id } = req.params;
    const owner = await resolveOwner(req);

    let session;
    if (owner) {
      const ownerQuery = owner.userId
        ? { _id: id, userId: owner.userId }
        : { _id: id, clientId: owner.clientId };

      session = await ResearchSession.findOne(ownerQuery).lean().exec();
    }

    // Fallback: if no owner or not found for this owner, allow lookup by id only
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
      const clips = await getClipsByIdsBatch(pineconeIds);
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
          ownerType: owner ? owner.ownerType : null,
          userId: session.userId || null,
          clientId: session.clientId || null,
          title: session.title || null,
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

  // Prefer the global AbortController (Node 18+), fall back to no abort if unavailable
  const hasAbortController = typeof AbortController !== 'undefined';
  const controller = hasAbortController ? new AbortController() : null;
  const timeout = setTimeout(() => {
    if (controller) {
      controller.abort();
    }
  }, timeoutMs);

  try {
    const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
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
  const constellationHeight = Math.floor(height * 0.65);
  const bannerHeight = height - constellationHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background: static nebula image, scaled to cover and cropped if needed
  const nebulaImage = await getNebulaBackgroundImage();
  if (nebulaImage) {
    const imgAspect = nebulaImage.width / nebulaImage.height;
    const canvasAspect = width / height;
    let renderWidth;
    let renderHeight;
    let offsetX;
    let offsetY;

    if (imgAspect > canvasAspect) {
      // Image is wider than canvas: fit height, crop left/right
      renderHeight = height;
      renderWidth = renderHeight * imgAspect;
      offsetX = (width - renderWidth) / 2;
      offsetY = 0;
    } else {
      // Image is taller than canvas: fit width, crop top/bottom
      renderWidth = width;
      renderHeight = renderWidth / imgAspect;
      offsetX = 0;
      offsetY = (height - renderHeight) / 2;
    }

    ctx.drawImage(nebulaImage, offsetX, offsetY, renderWidth, renderHeight);
  } else {
    // Fallback: solid background if nebula image is missing
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, width, height);
  }

  // Compute scale for constellation area (slightly zoomed-in to emphasize stars)
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
  let scale = maxRadius > 0 ? radiusPixels / maxRadius : 1;
  // Zoom in stars by ~50% compared to baseline
  scale *= 1.5;

  // Optional subtle vignette over the constellation region
  ctx.save();
  const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radiusPixels + margin);
  gradient.addColorStop(0, 'rgba(15,23,42,0.5)');
  gradient.addColorStop(1, 'rgba(15,23,42,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, constellationHeight);
  ctx.restore();

  // Helper for star-style rendering (core + halos + simple spikes)
  function hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return { r: 255, g: 136, b: 0 };
    const clean = hex.replace('#', '');
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return {
      r: Number.isFinite(r) ? r : 255,
      g: Number.isFinite(g) ? g : 136,
      b: Number.isFinite(b) ? b : 0
    };
  }

  function drawStar(ctx2, x, y, color, depthFactor) {
    const { r, g, b } = hexToRgb(color);

    const coreRadius = 5 * depthFactor;
    const halos = [
      { radius: coreRadius * 2.0, alpha: 0.45 },
      { radius: coreRadius * 3.0, alpha: 0.30 },
      { radius: coreRadius * 4.2, alpha: 0.18 },
      { radius: coreRadius * 5.8, alpha: 0.10 }
    ];

    // Core
    ctx2.save();
    ctx2.beginPath();
    ctx2.fillStyle = `rgb(${r},${g},${b})`;
    ctx2.arc(x, y, coreRadius, 0, Math.PI * 2);
    ctx2.fill();

    // Halos (additive)
    ctx2.globalCompositeOperation = 'lighter';
    halos.forEach(h => {
      const grad = ctx2.createRadialGradient(x, y, 0, x, y, h.radius);
      grad.addColorStop(0, `rgba(${r},${g},${b},${h.alpha})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx2.fillStyle = grad;
      ctx2.beginPath();
      ctx2.arc(x, y, h.radius, 0, Math.PI * 2);
      ctx2.fill();
    });

    // Simple diffraction spikes (4 directions)
    const spikeLength = coreRadius * 4.0;
    const spikeWidth = coreRadius * 0.45;
    ctx2.fillStyle = `rgba(${r},${g},${b},0.55)`;

    ctx2.translate(x, y);
    const directions = [0, Math.PI / 2];
    directions.forEach(angle => {
      ctx2.save();
      ctx2.rotate(angle);
      ctx2.fillRect(-spikeLength / 2, -spikeWidth / 2, spikeLength, spikeWidth);
      ctx2.restore();
    });

    ctx2.restore();
  }

  // Draw nodes as glowing \"semantic\" stars
  ctx.save();
  nodes.forEach(n => {
    const dx = n.x - meanX;
    const dy = n.y - meanY;
    const screenX = centerX + dx * scale;
    const screenY = centerY - dy * scale;
    const depthFactor = typeof n.z === 'number'
      ? 1 + (n.z / (2 * MAX_NODE_COORDINATE))
      : 1;
    const clampedDepth = Math.max(0.7, Math.min(1.5, depthFactor));
    drawStar(ctx, screenX, screenY, n.color, clampedDepth);
  });
  ctx.restore();

  // Banner
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, constellationHeight, width, bannerHeight);

  const bannerPadding = 36;
  // Make cover art fill the banner height (with padding), without spilling into nebula
  const thumbSize = bannerHeight - bannerPadding * 2;
  const thumbX = bannerPadding;
  const thumbY = constellationHeight + bannerPadding;

  // Resolve cover art or placeholder
  const coverArtUrl =
    (lastItemMetadata && (lastItemMetadata.episodeImage || lastItemMetadata.imageUrl || lastItemMetadata.podcastImage)) ||
    null;

  const placeholderPath = path.join(__dirname, '..', 'assets', 'artwork-placeholder.png');

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
    // Draw rectangular cover (no rounded corners) with subtle border and glow
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 24;
    ctx.drawImage(coverImage, thumbX, thumbY, thumbSize, thumbSize);

    // Thin border
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(15,23,42,0.9)';
    ctx.strokeRect(thumbX - 1.5, thumbY - 1.5, thumbSize + 3, thumbSize + 3);
    ctx.drawImage(coverImage, thumbX, thumbY, thumbSize, thumbSize);
    ctx.restore();
  }

  // Generate a smart title (GPT-4o-mini) based on lastItemMetadata, falling back to provided title
  const baseTitle = title || 'Podcast Research Session';
  const rawSmartTitle = await generateSmartShareTitle(lastItemMetadata, baseTitle);
  const smartTitle = rawSmartTitle || baseTitle;

  // Text block (title + quote) – perfectly centered vertically relative to cover art
  const textX = thumbX + thumbSize + bannerPadding;
  const maxTextWidth = width - textX - bannerPadding;

  const titleFontSize = 40;
  const quoteFontSize = 18;
  const titleSubtitleSpacing = 10;

  ctx.textBaseline = 'top';

  // Pre-compute quote lines (0–2) so we can center the entire block
  const quoteLines = [];
  const quoteText =
    (lastItemMetadata && (lastItemMetadata.quote || lastItemMetadata.summary)) || '';
  if (quoteText) {
    ctx.font = `${quoteFontSize}px sans-serif`;
    // Slightly dimmed subtitle/quote for visual hierarchy (~65% opacity gray)
    ctx.fillStyle = 'rgba(156,163,175,0.65)';

    const words = quoteText.split(/\s+/);
    let line1 = '';
    let line2 = '';
    let currentLine = '';
    let onSecondLine = false;
    let overflow = false;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const width = ctx.measureText(testLine).width;

      if (width <= maxTextWidth) {
        currentLine = testLine;
      } else {
        if (!onSecondLine) {
          line1 = currentLine;
          currentLine = word;
          onSecondLine = true;
        } else {
          line2 = currentLine;
          overflow = true;
          break;
        }
      }
    }

    if (!line1 && !onSecondLine) {
      line1 = currentLine;
    } else if (!line2) {
      line2 = currentLine;
    }

    if (overflow && line2) {
      // Add ellipsis to second line if we overflowed
      let withEllipsis = `${line2}…`;
      while (withEllipsis.length > 1 && ctx.measureText(withEllipsis).width > maxTextWidth) {
        line2 = line2.slice(0, -1);
        withEllipsis = `${line2}…`;
      }
      line2 = withEllipsis;
    }

    if (line1) quoteLines.push(line1);
    if (line2) quoteLines.push(line2);
  }

  // Compute total text block height (title + optional quote lines)
  const quoteLinesCount = quoteLines.length;
  let totalTextHeight = titleFontSize;
  if (quoteLinesCount > 0) {
    totalTextHeight += titleSubtitleSpacing;
    totalTextHeight += quoteLinesCount * quoteFontSize;
    if (quoteLinesCount > 1) {
      totalTextHeight += 4; // extra spacing between quote lines
    }
  }

  const thumbCenterY = thumbY + thumbSize / 2;
  let textY = thumbCenterY - totalTextHeight / 2;

  // Title
  ctx.fillStyle = '#F9FAFB';
  ctx.font = `bold ${titleFontSize}px sans-serif`;
  let displayTitle = smartTitle;
  if (ctx.measureText(displayTitle).width > maxTextWidth) {
    while (displayTitle.length > 3 && ctx.measureText(displayTitle + '…').width > maxTextWidth) {
      displayTitle = displayTitle.slice(0, -1);
    }
    displayTitle = displayTitle + '…';
  }
  ctx.fillText(displayTitle, textX, textY);
  textY += titleFontSize;

  // De-emphasized quote under title (two-line clamp)
  if (quoteLinesCount > 0) {
    textY += titleSubtitleSpacing;
    ctx.font = `${quoteFontSize}px sans-serif`;
    ctx.fillStyle = '#6B7280';

    if (quoteLines[0]) {
      ctx.fillText(quoteLines[0], textX, textY);
      textY += quoteFontSize + 4;
    }
    if (quoteLines[1]) {
      ctx.fillText(quoteLines[1], textX, textY);
    }
  }

  const buffer = canvas.toBuffer('image/jpeg', { quality: 0.75 });

  const spacesManager = getSharedPreviewSpacesManager();
  const key = `shared-sessions/${shareId}/preview.jpg`;
  const url = await spacesManager.uploadFile(SPACES_BUCKET_NAME, key, buffer, 'image/jpeg');
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

    // Prefer the frontend-provided origin so that links always reflect
    // the actual app URL the user is on (e.g. different domains/envs).
    // Frontend is expected to send:
    //   'X-Requested-With': window.location.origin
    const requestedWithHeader = req.get('X-Requested-With') || req.get('x-requested-with');
    const normalizedFrontendOrigin =
      typeof requestedWithHeader === 'string'
        ? requestedWithHeader.replace(/\/$/, '')
        : null;

    const baseForShareUrl = normalizedFrontendOrigin || SHARE_BASE_URL;
    const shareUrl = `${baseForShareUrl}/researchSession/${shareId}`;

    // Prefer the metadata from the last shared node, falling back to session-level lastItemMetadata.
    const baseItems = Array.isArray(baseSession.items) ? baseSession.items : [];
    const lastSharedPineconeId = sanitizedNodes[sanitizedNodes.length - 1]?.pineconeId;
    const lastItemFromNodes = lastSharedPineconeId
      ? baseItems.find((it) => it && it.pineconeId === lastSharedPineconeId)
      : null;
    const lastItemMetadataFromNode = lastItemFromNodes?.metadata || null;

    const effectiveLastItemMetadata = {
      ...(baseSession.lastItemMetadata || {}),
      ...(lastItemMetadataFromNode || {})
    };

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
      lastItemMetadata: Object.keys(effectiveLastItemMetadata).length ? effectiveLastItemMetadata : null,
      previewImageUrl: null
    });

    await sharedDoc.save();

    let previewImageUrl = null;
    try {
      previewImageUrl = await generateSharedSessionPreviewImage({
        shareId,
        title: resolvedTitle,
        lastItemMetadata: Object.keys(effectiveLastItemMetadata).length ? effectiveLastItemMetadata : null,
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

    // Hydrate item metadata from MongoDB (JamieVectorMetadata) using pineconeIds.
    // We treat MongoDB as source-of-truth (Pinecone is for semantic reads only).
    const orderedIds = Array.isArray(session.pineconeIds) && session.pineconeIds.length
      ? session.pineconeIds
      : items
          .map((it) => it && it.pineconeId)
          .filter((val) => typeof val === 'string' && val.length > 0);

    const uniqueIds = Array.from(new Set(orderedIds));

    const mongoDocs = uniqueIds.length
      ? await JamieVectorMetadata.find({ pineconeId: { $in: uniqueIds } })
          .select('pineconeId metadataRaw start_time end_time')
          .lean()
      : [];

    const mongoById = new Map((mongoDocs || []).map((doc) => [doc.pineconeId, doc]));

    // Build a concise text context from the hydrated session items (cap at 20 items).
    // We skip entries without usable content to avoid low-signal prompts.
    const MAX_ITEMS = 20;
    const limitedItems = [];
    for (const pid of orderedIds) {
      if (limitedItems.length >= MAX_ITEMS) break;
      const doc = mongoById.get(pid);
      if (!doc || !doc.metadataRaw) continue;
      limitedItems.push({ pineconeId: pid, doc });
    }

    if (!limitedItems.length) {
      return res.status(400).json({
        error: 'Missing metadata',
        details: 'None of the session items could be hydrated from MongoDB (JamieVectorMetadata)'
      });
    }

    const contextLines = limitedItems
      .map((entry) => entry && entry.doc && entry.doc.metadataRaw ? entry : null)
      .filter(Boolean)
      .map((entry, index) => {
        const meta = entry.doc.metadataRaw || {};

        // Prefer actual paragraph text when present; fall back to quote/summary/headline.
        const quote =
          meta.text ||
          meta.quote ||
          meta.summary ||
          meta.headline ||
          '(no quote)';

        const episode = meta.episode || meta.title || 'Unknown episode';
        const creator = meta.creator || 'Unknown creator';

        // Source material for citations (3-part): pineconeId, episode image, episode/chapter title.
        const episodeImage =
          meta.episodeImage ||
          meta.imageUrl ||
          meta.podcastImage ||
          meta.image ||
          '';

        const episodeOrChapterTitle =
          meta.headline ||
          meta.chapterTitle ||
          meta.chapter ||
          meta.episode ||
          meta.title ||
          'Unknown title';

        // Pre-build a canonical, single-line JSON payload the model can copy exactly
        // when emitting "cards" for the frontend.
        const cardJson = JSON.stringify({
          pineconeId: entry.pineconeId,
          episodeImage: episodeImage ? episodeImage : null,
          title: episodeOrChapterTitle
        });

        // Prefer explicit start_time/end_time stored in Mongo mirror.
        const startTime =
          (typeof entry.doc.start_time === 'number' ? entry.doc.start_time : null) ??
          (typeof meta.start_time === 'number' ? meta.start_time : null) ??
          (meta.timeContext && typeof meta.timeContext.start_time === 'number' ? meta.timeContext.start_time : null) ??
          null;

        const startSeconds =
          typeof startTime === 'number' && !Number.isNaN(startTime)
            ? Math.floor(startTime)
            : null;

        return [
          `Item ${index + 1}:`,
          `PineconeId: ${entry.pineconeId}`,
          `Episode: ${episode}`,
          `Creator: ${creator}`,
          episodeImage ? `EpisodeImage: ${episodeImage}` : 'EpisodeImage: (not available)',
          `EpisodeOrChapterTitle: ${episodeOrChapterTitle}`,
          `CardJSON: ${cardJson}`,
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
- When you reference a specific item or quote, append a machine-readable "card" marker at the END of the SAME line
  using this exact format:
  CARD_JSON: <valid JSON>
- The JSON MUST be valid and MUST include these keys:
  - pineconeId (string)
  - episodeImage (string or null)
  - title (string)  // episode/chapter title
- IMPORTANT: Each item in the context includes a line "CardJSON: {...}".
  For citations, COPY that JSON EXACTLY (do not modify any characters).
- The "CARD_JSON: ..." must be the final content on the line (no trailing punctuation).
- Do NOT wrap CARD_JSON in parentheses or brackets. Bad: "(CARD_JSON: {...})". Good: "CARD_JSON: {...}"
- Do NOT include the literal prefix "Quote:" or parentheticals like "(Quote: ...)" in your output.
  If you want to include a direct quote, include it naturally in the sentence (with quotes) and then append CARD_JSON.
- Example:
  ...some sentence about an item... CARD_JSON: {"pineconeId":"9a1bc097..._p43","episodeImage":"https://.../image.jpg","title":"Bitcoin Revealed What School Never Wanted Us to Understand"}

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

