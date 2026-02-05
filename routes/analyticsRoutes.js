/**
 * Analytics Routes
 * 
 * POST /api/analytics - Receive and store analytics events from clients
 * GET /api/analytics/debug/:sessionId - (DEBUG_MODE only) Get all events for a session
 */

const express = require('express');
const router = express.Router();
const { AnalyticsEvent } = require('../models/AnalyticsEvent');
const { validateEvent } = require('../utils/analyticsEmitter');

const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

// ═══════════════════════════════════════════════════════════════════════════════
// In-Memory Rate Limiting
// 
// Lightweight rate limiter: 60 events/session/minute, 10 burst allowance
// Resets on server restart (acceptable for analytics)
// ═══════════════════════════════════════════════════════════════════════════════

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_BURST = 10;

// Map of session_id -> { count, windowStart, burstUsed }
const rateLimitMap = new Map();

// Cleanup old entries every 5 minutes to prevent memory bloat
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, data] of rateLimitMap.entries()) {
    if (now - data.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

/**
 * Check rate limit for a session
 * @param {string} sessionId
 * @returns {boolean} - True if allowed, false if rate limited
 */
function checkRateLimit(sessionId) {
  const now = Date.now();
  let data = rateLimitMap.get(sessionId);
  
  if (!data || now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
    // New window
    data = { count: 1, windowStart: now, burstUsed: 0 };
    rateLimitMap.set(sessionId, data);
    return true;
  }
  
  // Within window
  if (data.count < RATE_LIMIT_MAX) {
    data.count++;
    return true;
  }
  
  // Over limit - check burst allowance
  if (data.burstUsed < RATE_LIMIT_BURST) {
    data.burstUsed++;
    return true;
  }
  
  // Rate limited
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/analytics
// 
// Receives analytics events from clients
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/', async (req, res) => {
  try {
    const event = req.body;
    console.log('[Analytics] Received event:', event.type);
    
    // Validate event
    const validation = validateEvent(event);
    if (!validation.valid) {
      console.log('[Analytics] Validation failed:', validation.error);
      return res.status(400).json({ error: validation.error });
    }
    console.log('[Analytics] Validation passed');
    
    // Check rate limit (drop silently if exceeded per spec)
    if (!checkRateLimit(event.session_id)) {
      console.log('[Analytics] Rate limited, dropping silently');
      // Return 200 to client but don't store (silent drop)
      return res.status(200).send();
    }
    console.log('[Analytics] Rate limit OK, storing...');
    
    // Store event with timeout to prevent hanging
    const timeoutMs = 5000; // 5 second timeout
    const createPromise = AnalyticsEvent.create({
      type: event.type,
      session_id: event.session_id,
      timestamp: new Date(event.timestamp),
      tier: event.tier,
      environment: event.environment,
      properties: event.properties || {},
      server_timestamp: new Date()
    });
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('MongoDB write timeout')), timeoutMs)
    );
    
    await Promise.race([createPromise, timeoutPromise]);
    console.log('[Analytics] Stored successfully');
    
    // Success - empty 200 response per spec
    res.status(200).send();
    
  } catch (error) {
    console.error('[Analytics] Error storing event:', error.message, error.stack);
    // Return 500 but don't expose internal details
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG ENDPOINTS
// 
// Only available when DEBUG_MODE=true
// ═══════════════════════════════════════════════════════════════════════════════

if (DEBUG_MODE) {
  /**
   * GET /api/analytics/debug/:sessionId
   * 
   * Returns all events for a given session ID, useful for automated testing.
   * 
   * Query params:
   *   - type: Filter by event type (optional)
   *   - limit: Max events to return (default: 100)
   *   - since: ISO timestamp, only events after this time (optional)
   */
  router.get('/debug/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { type, limit = 100, since } = req.query;
      
      // Build query
      const query = { session_id: sessionId };
      
      if (type) {
        query.type = type;
      }
      
      if (since) {
        query.timestamp = { $gte: new Date(since) };
      }
      
      // Fetch events
      const events = await AnalyticsEvent.find(query)
        .sort({ timestamp: -1 })
        .limit(parseInt(limit, 10))
        .lean();
      
      // Aggregate stats
      const allSessionEvents = await AnalyticsEvent.find({ session_id: sessionId }).lean();
      const eventsByType = {};
      const tierHistory = [];
      
      for (const event of allSessionEvents) {
        eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
        if (!tierHistory.includes(event.tier)) {
          tierHistory.push(event.tier);
        }
      }
      
      // Get first and last event timestamps
      const sortedByTime = allSessionEvents.sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
      );
      const firstEvent = sortedByTime[0];
      const lastEvent = sortedByTime[sortedByTime.length - 1];
      
      res.json({
        session_id: sessionId,
        summary: {
          total_events: allSessionEvents.length,
          events_by_type: eventsByType,
          tier_history: tierHistory,
          first_event: firstEvent?.timestamp || null,
          last_event: lastEvent?.timestamp || null,
          session_duration_ms: firstEvent && lastEvent 
            ? new Date(lastEvent.timestamp) - new Date(firstEvent.timestamp)
            : 0
        },
        events: events.map(e => ({
          type: e.type,
          timestamp: e.timestamp,
          tier: e.tier,
          environment: e.environment,
          properties: e.properties,
          server_timestamp: e.server_timestamp
        })),
        _debug: true
      });
      
    } catch (error) {
      console.error('[Analytics Debug] Error:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  
  /**
   * DELETE /api/analytics/debug/:sessionId
   * 
   * Deletes all events for a session (useful for test cleanup)
   */
  router.delete('/debug/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      
      const result = await AnalyticsEvent.deleteMany({ session_id: sessionId });
      
      res.json({
        session_id: sessionId,
        deleted_count: result.deletedCount,
        _debug: true
      });
      
    } catch (error) {
      console.error('[Analytics Debug] Delete error:', error.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  
  console.log('🔍 Analytics debug endpoints mounted (DEBUG_MODE=true)');
}

module.exports = router;
