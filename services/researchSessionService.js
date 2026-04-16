/**
 * Research Session Service
 *
 * Core creation logic extracted from routes/researchSessions.js POST handler.
 * Used by the agent tool handler to create sessions without HTTP loopback.
 */

const { ResearchSession } = require('../models/ResearchSession');
const { getClipsByIdsBatch } = require('../agent-tools/pineconeTools');
const { OpenAI } = require('openai');
const { printLog } = require('../constants.js');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SESSION_BASE_URL = 'https://www.pullthatupjamie.ai/app';

function deriveTitle(metadata) {
  if (!metadata) return 'Research Session';
  const parts = [];
  if (metadata.creator) parts.push(metadata.creator);
  if (metadata.episode) parts.push(metadata.episode);
  if (parts.length > 0) return parts.join(' — ').substring(0, 80);
  if (metadata.headline) return metadata.headline.substring(0, 80);
  if (metadata.quote) return metadata.quote.substring(0, 60) + '...';
  return 'Research Session';
}

async function generateSmartTitle(lastItemMetadata, fallbackTitle) {
  try {
    if (!lastItemMetadata || typeof lastItemMetadata !== 'object') return fallbackTitle;
    const parts = [];
    if (lastItemMetadata.headline) parts.push(`Headline: ${lastItemMetadata.headline}`);
    if (lastItemMetadata.summary) parts.push(`Summary: ${lastItemMetadata.summary}`);
    if (lastItemMetadata.quote) parts.push(`Quote: ${lastItemMetadata.quote}`);
    if (lastItemMetadata.episode) parts.push(`Episode: ${lastItemMetadata.episode}`);
    if (lastItemMetadata.creator) parts.push(`Creator: ${lastItemMetadata.creator}`);
    const context = parts.join('\n');
    if (!context) return fallbackTitle;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You generate concise, compelling titles for podcast research sessions. ' +
            'Use natural title casing. Preserve acronyms and proper nouns. ' +
            'Respond with ONLY the title, max 40 characters, no quotes or emojis.'
        },
        { role: 'user', content: `Based on this context, suggest a short title:\n\n${context}\n\nTitle:` }
      ],
      max_tokens: 32,
      temperature: 0.5,
    });
    const raw = response.choices?.[0]?.message?.content || '';
    const cleaned = raw.split('\n')[0].trim().replace(/^["']|["']$/g, '').trim();
    return cleaned || fallbackTitle;
  } catch (err) {
    printLog(`[SESSION-SVC] Smart title generation failed: ${err.message}`);
    return fallbackTitle;
  }
}

/**
 * Create a research session directly (no HTTP).
 *
 * @param {object} opts
 * @param {string[]} opts.pineconeIds - Clip IDs (shareLink values)
 * @param {string} [opts.title] - Optional title override
 * @param {string} [opts.userId] - Authenticated user ID
 * @param {string} [opts.clientId] - Anonymous client ID
 * @param {Map<string, object>} [opts.clipCache] - Pre-fetched clip metadata from agent search results
 * @returns {{ sessionId: string, url: string, title: string, itemCount: number }}
 */
async function createResearchSessionDirect({ pineconeIds, title, userId, clientId, clipCache }) {
  if (!Array.isArray(pineconeIds) || pineconeIds.length === 0) {
    throw new Error('pineconeIds must be a non-empty array');
  }

  const seen = new Set();
  const uniqueIds = pineconeIds.filter(id => {
    if (typeof id !== 'string' || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  if (uniqueIds.length > 50) {
    throw new Error('A research session can contain at most 50 unique items');
  }

  printLog(`[SESSION-SVC] Creating session with ${uniqueIds.length} clips`);

  // Build metadata from cache (populated by prior search_quotes calls) or Pinecone fallback
  const clipById = new Map();
  const uncachedIds = [];

  for (const id of uniqueIds) {
    const cached = clipCache?.get(id);
    if (cached) {
      const { embedding, ...rest } = cached;
      clipById.set(id, rest);
    } else {
      uncachedIds.push(id);
    }
  }

  const cacheHits = uniqueIds.length - uncachedIds.length;
  printLog(`[SESSION-SVC] Cache: ${cacheHits}/${uniqueIds.length} hits`);

  if (uncachedIds.length > 0) {
    const isDebugMode = process.env.DEBUG_MODE === 'true';
    if (isDebugMode) {
      uncachedIds.forEach(id => clipById.set(id, { shareLink: id }));
    } else {
      try {
        const fetched = await getClipsByIdsBatch(uncachedIds);
        printLog(`[SESSION-SVC] Pinecone fallback: ${fetched?.length || 0} clips for ${uncachedIds.length} uncached IDs`);
        for (const clip of (fetched || [])) {
          if (clip && clip.shareLink) {
            const { embedding, ...rest } = clip;
            clipById.set(clip.shareLink, rest);
          }
        }
      } catch (err) {
        printLog(`[SESSION-SVC] Pinecone fallback failed (non-fatal): ${err.message}`);
      }
    }
  }

  const items = uniqueIds.map(id => ({
    pineconeId: id,
    metadata: clipById.get(id) || null,
  }));

  const lastClip = items.length > 0 ? items[items.length - 1].metadata : null;
  const fallbackTitle = deriveTitle(lastClip);
  const sessionTitle = title || await generateSmartTitle(lastClip, fallbackTitle);

  const session = new ResearchSession({
    userId: userId || undefined,
    clientId: userId ? undefined : (clientId || undefined),
    pineconeIds: uniqueIds,
    items,
    title: sessionTitle,
    lastItemMetadata: lastClip,
  });

  await session.save();

  const url = `${SESSION_BASE_URL}?researchSessionId=${session._id}`;
  printLog(`[SESSION-SVC] Session created: ${session._id} (${uniqueIds.length} items) → ${url}`);

  return {
    sessionId: String(session._id),
    url,
    title: sessionTitle,
    itemCount: uniqueIds.length,
  };
}

module.exports = { createResearchSessionDirect };
