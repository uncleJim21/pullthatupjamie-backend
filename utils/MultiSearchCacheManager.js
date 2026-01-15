/**
 * MultiSearchCacheManager
 * 
 * In-memory cache for multi-search 3D sessions with:
 * - Circular buffer behavior (evicts oldest when at capacity)
 * - TTL-based expiry
 * - Configurable limits
 */

const { printLog } = require('../constants.js');

class MultiSearchCacheManager {
  /**
   * @param {Object} options
   * @param {number} options.maxSessions - Maximum number of sessions to store (default: 100)
   * @param {number} options.maxItemsPerSession - Maximum items per session (default: 100)
   * @param {number} options.maxAgeMs - Session TTL in milliseconds (default: 30 minutes)
   * @param {number} options.cleanupIntervalMs - How often to run cleanup (default: 5 minutes)
   */
  constructor(options = {}) {
    this.maxSessions = options.maxSessions ?? 100;
    this.maxItemsPerSession = options.maxItemsPerSession ?? 100;
    this.maxAgeMs = options.maxAgeMs ?? 30 * 60 * 1000; // 30 minutes
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 5 * 60 * 1000; // 5 minutes

    // Main storage: Map preserves insertion order for circular buffer behavior
    this.sessions = new Map();

    // Insertion order tracking for circular buffer eviction
    this.insertionOrder = [];

    // Start cleanup interval
    this.cleanupTimer = setInterval(() => this._cleanup(), this.cleanupIntervalMs);

    printLog(`[MultiSearchCacheManager] Initialized: maxSessions=${this.maxSessions}, maxItemsPerSession=${this.maxItemsPerSession}, maxAgeMs=${this.maxAgeMs}`);
  }

  /**
   * Generate a unique session ID
   * @returns {string}
   */
  _generateSessionId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `msess_${timestamp}_${random}`;
  }

  /**
   * Create a new session
   * @param {Object} initialData
   * @param {string} initialData.query - The initial search query
   * @param {Array} initialData.items - Initial items with embeddings and metadata
   * @param {Object} initialData.axisLabels - Optional axis labels
   * @param {string} initialData.umapConfig - 'standard' or 'fast'
   * @returns {Object} The created session with its ID
   */
  createSession(initialData) {
    const { query, items = [], axisLabels = null, umapConfig = 'standard' } = initialData;

    // Enforce capacity - evict oldest if at max
    if (this.sessions.size >= this.maxSessions) {
      this._evictOldest();
    }

    const sessionId = this._generateSessionId();
    const now = Date.now();

    // Enforce item limit on initial creation
    const cappedItems = items.slice(0, this.maxItemsPerSession);

    const session = {
      id: sessionId,
      createdAt: now,
      lastAccessedAt: now,
      queries: [
        {
          query,
          timestamp: now,
          itemCount: cappedItems.length
        }
      ],
      items: cappedItems,
      axisLabels,
      umapConfig
    };

    this.sessions.set(sessionId, session);
    this.insertionOrder.push(sessionId);

    printLog(`[MultiSearchCacheManager] Created session ${sessionId} with ${cappedItems.length} items (${this.sessions.size}/${this.maxSessions} sessions)`);

    return session;
  }

  /**
   * Get a session by ID (updates lastAccessedAt)
   * @param {string} sessionId
   * @returns {Object|null}
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    // Check if expired
    if (Date.now() - session.lastAccessedAt > this.maxAgeMs) {
      this._deleteSession(sessionId);
      printLog(`[MultiSearchCacheManager] Session ${sessionId} expired on access`);
      return null;
    }

    // Update last accessed time
    session.lastAccessedAt = Date.now();
    return session;
  }

  /**
   * Check if a session exists and is valid
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasSession(sessionId) {
    return this.getSession(sessionId) !== null;
  }

  /**
   * Add items to an existing session
   * @param {string} sessionId
   * @param {Object} data
   * @param {string} data.query - The query that produced these items
   * @param {Array} data.items - New items to add (will be deduped and capped)
   * @returns {Object} Result with added count and session state
   */
  addItemsToSession(sessionId, data) {
    const session = this.getSession(sessionId);
    if (!session) {
      return { success: false, error: 'Session not found or expired' };
    }

    const { query, items: newItems = [] } = data;

    // Get existing pineconeIds for deduplication
    const existingIds = new Set(session.items.map(item => item.pineconeId));

    // Filter out duplicates
    const uniqueNewItems = newItems.filter(item => !existingIds.has(item.pineconeId));

    // Calculate how many we can add
    const remainingCapacity = this.maxItemsPerSession - session.items.length;
    const itemsToAdd = uniqueNewItems.slice(0, remainingCapacity);

    // Track the query
    const queryIndex = session.queries.length;
    session.queries.push({
      query,
      timestamp: Date.now(),
      itemCount: itemsToAdd.length
    });

    // Tag items with their source query index
    const taggedItems = itemsToAdd.map(item => ({
      ...item,
      sourceQueryIndex: queryIndex
    }));

    // Add to session
    session.items.push(...taggedItems);
    session.lastAccessedAt = Date.now();

    // Clear axis labels since they need to be regenerated
    session.axisLabels = null;

    printLog(`[MultiSearchCacheManager] Added ${itemsToAdd.length} items to session ${sessionId} (${uniqueNewItems.length - itemsToAdd.length} skipped due to cap, ${newItems.length - uniqueNewItems.length} dupes). Total: ${session.items.length}/${this.maxItemsPerSession}`);

    return {
      success: true,
      added: itemsToAdd.length,
      duplicatesSkipped: newItems.length - uniqueNewItems.length,
      capacitySkipped: uniqueNewItems.length - itemsToAdd.length,
      totalItems: session.items.length,
      atCapacity: session.items.length >= this.maxItemsPerSession
    };
  }

  /**
   * Update session with new UMAP coordinates and optional axis labels
   * @param {string} sessionId
   * @param {Object} updates
   * @param {Array} updates.coordinates3d - Array of {x, y, z} matching item order
   * @param {Object} updates.axisLabels - Optional new axis labels
   * @returns {boolean}
   */
  updateSessionCoordinates(sessionId, updates) {
    const session = this.getSession(sessionId);
    if (!session) {
      return false;
    }

    const { coordinates3d, axisLabels } = updates;

    // Update coordinates on each item
    if (coordinates3d && coordinates3d.length === session.items.length) {
      session.items.forEach((item, index) => {
        item.coordinates3d = coordinates3d[index];
      });
    }

    // Update axis labels if provided
    if (axisLabels !== undefined) {
      session.axisLabels = axisLabels;
    }

    session.lastAccessedAt = Date.now();

    printLog(`[MultiSearchCacheManager] Updated coordinates for session ${sessionId}`);
    return true;
  }

  /**
   * Get all embeddings from a session (for UMAP re-projection)
   * @param {string} sessionId
   * @returns {Array|null} Array of embedding vectors
   */
  getSessionEmbeddings(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

    return session.items.map(item => item.embedding).filter(Boolean);
  }

  /**
   * Get session stats for monitoring
   * @returns {Object}
   */
  getStats() {
    const now = Date.now();
    let totalItems = 0;
    let oldestSession = null;
    let newestSession = null;

    for (const session of this.sessions.values()) {
      totalItems += session.items.length;
      if (!oldestSession || session.createdAt < oldestSession.createdAt) {
        oldestSession = session;
      }
      if (!newestSession || session.createdAt > newestSession.createdAt) {
        newestSession = session;
      }
    }

    // Estimate memory usage (rough)
    // ~8KB per item (6KB embedding + 2KB metadata)
    const estimatedMemoryMB = (totalItems * 8 * 1024) / (1024 * 1024);

    return {
      sessionCount: this.sessions.size,
      maxSessions: this.maxSessions,
      totalItems,
      maxItemsPerSession: this.maxItemsPerSession,
      estimatedMemoryMB: Math.round(estimatedMemoryMB * 100) / 100,
      oldestSessionAge: oldestSession ? now - oldestSession.createdAt : null,
      newestSessionAge: newestSession ? now - newestSession.createdAt : null,
      maxAgeMs: this.maxAgeMs
    };
  }

  /**
   * Evict the oldest session (circular buffer behavior)
   * @private
   */
  _evictOldest() {
    if (this.insertionOrder.length === 0) {
      return;
    }

    const oldestId = this.insertionOrder.shift();
    const evicted = this.sessions.get(oldestId);
    this.sessions.delete(oldestId);

    if (evicted) {
      printLog(`[MultiSearchCacheManager] Evicted oldest session ${oldestId} (age: ${Date.now() - evicted.createdAt}ms, items: ${evicted.items.length})`);
    }
  }

  /**
   * Delete a specific session
   * @private
   * @param {string} sessionId
   */
  _deleteSession(sessionId) {
    this.sessions.delete(sessionId);
    const orderIndex = this.insertionOrder.indexOf(sessionId);
    if (orderIndex > -1) {
      this.insertionOrder.splice(orderIndex, 1);
    }
  }

  /**
   * Cleanup expired sessions
   * @private
   */
  _cleanup() {
    const now = Date.now();
    let expiredCount = 0;

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastAccessedAt > this.maxAgeMs) {
        this._deleteSession(sessionId);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      printLog(`[MultiSearchCacheManager] Cleanup: removed ${expiredCount} expired sessions (${this.sessions.size} remaining)`);
    }
  }

  /**
   * Shutdown the manager (clear interval, optionally clear sessions)
   * @param {boolean} clearSessions - Whether to clear all sessions
   */
  shutdown(clearSessions = false) {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (clearSessions) {
      this.sessions.clear();
      this.insertionOrder = [];
    }

    printLog(`[MultiSearchCacheManager] Shutdown complete (sessions ${clearSessions ? 'cleared' : 'preserved'})`);
  }
}

// Singleton instance with default config
// Can be overridden via environment variables
const instance = new MultiSearchCacheManager({
  maxSessions: parseInt(process.env.MULTI_SEARCH_MAX_SESSIONS || '100', 10),
  maxItemsPerSession: parseInt(process.env.MULTI_SEARCH_MAX_ITEMS_PER_SESSION || '100', 10),
  maxAgeMs: parseInt(process.env.MULTI_SEARCH_MAX_AGE_MS || String(30 * 60 * 1000), 10),
  cleanupIntervalMs: parseInt(process.env.MULTI_SEARCH_CLEANUP_INTERVAL_MS || String(5 * 60 * 1000), 10)
});

module.exports = {
  MultiSearchCacheManager,
  multiSearchCache: instance
};
