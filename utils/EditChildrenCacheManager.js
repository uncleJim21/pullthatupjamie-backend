const { WorkProductV2 } = require('../models/WorkProductV2');
const { printLog } = require('../constants');

/**
 * Manages caching of edit children data to reduce database queries
 * Caches each parent file's children data for 24 hours with stale-while-revalidate pattern
 */
class EditChildrenCacheManager {
    constructor() {
        this.cache = new Map(); // cacheKey -> { data, timestamp, expiresAt }
        this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
        this.refreshPromises = new Map(); // cacheKey -> Promise<Object>
    }

    _cacheKey(parentFileBase, feedId = null) {
        // Namespacing by feedId prevents collisions across podcasts, while remaining
        // backward-compatible (null feedId falls back to a global namespace).
        const ns = feedId ? String(feedId) : 'global';
        return `${ns}::${parentFileBase}`;
    }

    /**
     * Get cached children data or fetch fresh if expired/missing
     * @param {string} parentFileBase - The parent file base name (without extension)
     * @param {string|number|null} feedId - Optional feedId to namespace cache and scope DB lookup
     * @param {Object} options
     * @param {boolean} options.triggerRefresh - Whether to trigger background refresh on miss/expiry
     * @returns {Object|null} - Cached children data or null if not found
     */
    async getChildren(parentFileBase, feedId = null, { triggerRefresh = true } = {}) {
        const cacheKey = this._cacheKey(parentFileBase, feedId);
        const cached = this.cache.get(cacheKey);
        const now = Date.now();

        // Return cached data if it exists and hasn't expired
        if (cached && cached.expiresAt > now) {
            printLog(`📦 [EDIT-CHILDREN-CACHE] Cache hit for key: ${cacheKey} (${Math.round((cached.expiresAt - now) / 1000 / 60)}min remaining)`);
            return cached.data;
        }

        if (triggerRefresh) {
            // If cache is expired or missing, trigger background refresh
            if (cached) {
                printLog(`⏰ [EDIT-CHILDREN-CACHE] Cache expired for key: ${cacheKey}, triggering background refresh`);
            } else {
                printLog(`❌ [EDIT-CHILDREN-CACHE] No cache found for key: ${cacheKey}, triggering background refresh`);
            }

            // Trigger background refresh (non-blocking)
            this.refreshChildren(parentFileBase, feedId).catch(err => {
                printLog(`❌ [EDIT-CHILDREN-CACHE] Background refresh failed for key: ${cacheKey}: ${err.message}`);
            });
        }

        // Return cached data even if expired (stale-while-revalidate pattern)
        return cached ? cached.data : null;
    }

    /**
     * Refresh children data for a specific parent file
     * @param {string} parentFileBase - The parent file base name
     * @param {string|number|null} feedId - Optional feedId for scoping + cache namespacing
     * @returns {Promise<Object|null>} - Fresh children data
     */
    async refreshChildren(parentFileBase, feedId = null) {
        const cacheKey = this._cacheKey(parentFileBase, feedId);

        // De-dupe concurrent refreshes: everyone awaits the same promise.
        const existing = this.refreshPromises.get(cacheKey);
        if (existing) {
            printLog(`🔄 [EDIT-CHILDREN-CACHE] Refresh already in progress for key: ${cacheKey}`);
            return await existing;
        }

        const promise = (async () => {
            try {
                printLog(`🔄 [EDIT-CHILDREN-CACHE] Refreshing children data for key: ${cacheKey}`);
                const startTime = Date.now();

                let childEdits = [];

                if (feedId != null) {
                    // Fast path: scoped query (newer docs)
                    const t1 = Date.now();
                    const scoped = await WorkProductV2.find({
                        type: 'video-edit',
                        'result.feedId': feedId,
                        'result.parentFileBase': parentFileBase
                    }).sort({ createdAt: -1 });
                    printLog(`⏱️  [EDIT-CHILDREN-CACHE] scoped query done key=${cacheKey} count=${scoped.length} (+${Date.now() - t1}ms)`);

                    // Backward-compatible fallback: legacy docs without result.feedId
                    const t2 = Date.now();
                    const legacy = await WorkProductV2.find({
                        type: 'video-edit',
                        'result.feedId': { $exists: false },
                        'result.parentFileBase': parentFileBase
                    }).sort({ createdAt: -1 });
                    printLog(`⏱️  [EDIT-CHILDREN-CACHE] legacy query done key=${cacheKey} count=${legacy.length} (+${Date.now() - t2}ms)`);

                    childEdits = scoped.concat(legacy);
                } else {
                    // Backward-compatible: old signature (no feed scoping)
                    const t = Date.now();
                    childEdits = await WorkProductV2.find({
                        type: 'video-edit',
                        'result.parentFileBase': parentFileBase
                    }).sort({ createdAt: -1 });
                    printLog(`⏱️  [EDIT-CHILDREN-CACHE] unscoped query done key=${cacheKey} count=${childEdits.length} (+${Date.now() - t}ms)`);
                }

                printLog(`📊 [EDIT-CHILDREN-CACHE] Found ${childEdits.length} child edits for key: ${cacheKey}`);

                // Format the response
                const formattedEdits = childEdits.map(edit => ({
                    lookupHash: edit.lookupHash,
                    status: edit.status,
                    url: edit.cdnFileId,
                    editRange: `${edit.result.editStart}s-${edit.result.editEnd}s`,
                    duration: edit.result.editDuration,
                    createdAt: edit.createdAt,
                    originalUrl: edit.result.originalUrl
                }));

                const childrenData = {
                    parentFileBase,
                    feedId: feedId != null ? String(feedId) : undefined,
                    childCount: formattedEdits.length,
                    children: formattedEdits,
                    lastUpdated: new Date()
                };

                // Update cache
                this.cache.set(cacheKey, {
                    data: childrenData,
                    timestamp: Date.now(),
                    expiresAt: Date.now() + this.cacheExpiry
                });

                const duration = Date.now() - startTime;
                printLog(`✅ [EDIT-CHILDREN-CACHE] Successfully refreshed children data for key: ${cacheKey} in ${duration}ms`);

                return childrenData;
            } catch (error) {
                printLog(`❌ [EDIT-CHILDREN-CACHE] Error refreshing children data for key: ${cacheKey}: ${error.message}`);
                throw error;
            } finally {
                this.refreshPromises.delete(cacheKey);
            }
        })();

        this.refreshPromises.set(cacheKey, promise);
        return await promise;
    }

    /**
     * Invalidate cache for a specific parent file
     * @param {string} parentFileBase - The parent file base name
     * @param {string|number|null} feedId - Optional feedId to invalidate just one namespace
     */
    invalidate(parentFileBase, feedId = null) {
        if (feedId != null) {
            const cacheKey = this._cacheKey(parentFileBase, feedId);
            if (this.cache.has(cacheKey)) {
                this.cache.delete(cacheKey);
                printLog(`🗑️ [EDIT-CHILDREN-CACHE] Invalidated cache for key: ${cacheKey}`);
            }
            return;
        }

        // Backward-compatible: invalidate across all namespaces for this parentFileBase.
        const suffix = `::${parentFileBase}`;
        let invalidated = 0;
        for (const key of this.cache.keys()) {
            if (key.endsWith(suffix)) {
                this.cache.delete(key);
                invalidated++;
            }
        }
        if (invalidated > 0) {
            printLog(`🗑️ [EDIT-CHILDREN-CACHE] Invalidated ${invalidated} cache entries for parentFileBase: ${parentFileBase}`);
        }
    }

    /**
     * Invalidate cache for multiple parent files (useful when new edits are created)
     * @param {Array<string>} parentFileBases - Array of parent file base names
     * @param {string|number|null} feedId - Optional feedId to invalidate just one namespace
     */
    invalidateMultiple(parentFileBases, feedId = null) {
        let invalidated = 0;
        parentFileBases.forEach(parentFileBase => {
            if (feedId != null) {
                const cacheKey = this._cacheKey(parentFileBase, feedId);
                if (this.cache.has(cacheKey)) {
                    this.cache.delete(cacheKey);
                    invalidated++;
                }
            } else {
                const suffix = `::${parentFileBase}`;
                for (const key of this.cache.keys()) {
                    if (key.endsWith(suffix)) {
                        this.cache.delete(key);
                        invalidated++;
                    }
                }
            }
        });
        printLog(`🗑️ [EDIT-CHILDREN-CACHE] Invalidated ${invalidated} cache entries`);
    }

    /**
     * Clear all cached data
     */
    clear() {
        const size = this.cache.size;
        this.cache.clear();
        this.refreshPromises.clear();
        printLog(`🗑️ [EDIT-CHILDREN-CACHE] Cleared all ${size} cache entries`);
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache statistics
     */
    getStats() {
        const now = Date.now();
        let expired = 0;
        let totalAge = 0;
        let pendingRefreshes = this.refreshPromises.size;

        for (const [key, cached] of this.cache) {
            const age = now - cached.timestamp;
            totalAge += age;

            if (cached.expiresAt <= now) {
                expired++;
            }
        }

        return {
            size: this.cache.size,
            expired,
            averageAge: this.cache.size > 0 ? totalAge / this.cache.size : 0,
            pendingRefreshes,
            cacheExpiry: this.cacheExpiry
        };
    }

    /**
     * Get all cached parent file bases
     * @returns {Array<string>} Array of cached parent file bases
     */
    getCachedKeys() {
        return Array.from(this.cache.keys());
    }
}

module.exports = EditChildrenCacheManager;
