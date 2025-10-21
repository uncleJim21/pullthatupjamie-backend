const { WorkProductV2 } = require('../models/WorkProductV2');
const { printLog } = require('../constants');

/**
 * Manages caching of edit children data to reduce database queries
 * Caches each parent file's children data for 24 hours with stale-while-revalidate pattern
 */
class EditChildrenCacheManager {
    constructor() {
        this.cache = new Map(); // parentFileBase -> { data, timestamp, expiresAt }
        this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
        this.isUpdating = false;
        this.updateInProgress = new Set(); // Track which parent files are being updated
    }

    /**
     * Get cached children data or fetch fresh if expired/missing
     * @param {string} parentFileBase - The parent file base name (without extension)
     * @returns {Object|null} - Cached children data or null if not found
     */
    async getChildren(parentFileBase) {
        const cached = this.cache.get(parentFileBase);
        const now = Date.now();

        // Return cached data if it exists and hasn't expired
        if (cached && cached.expiresAt > now) {
            printLog(`📦 [EDIT-CHILDREN-CACHE] Cache hit for parentFileBase: ${parentFileBase} (${Math.round((cached.expiresAt - now) / 1000 / 60)}min remaining)`);
            return cached.data;
        }

        // If cache is expired or missing, trigger background refresh
        if (cached) {
            printLog(`⏰ [EDIT-CHILDREN-CACHE] Cache expired for parentFileBase: ${parentFileBase}, triggering background refresh`);
        } else {
            printLog(`❌ [EDIT-CHILDREN-CACHE] No cache found for parentFileBase: ${parentFileBase}, triggering background refresh`);
        }

        // Trigger background refresh (non-blocking)
        this.refreshChildren(parentFileBase).catch(err => {
            printLog(`❌ [EDIT-CHILDREN-CACHE] Background refresh failed for parentFileBase: ${parentFileBase}: ${err.message}`);
        });

        // Return cached data even if expired (stale-while-revalidate pattern)
        return cached ? cached.data : null;
    }

    /**
     * Refresh children data for a specific parent file
     * @param {string} parentFileBase - The parent file base name
     * @returns {Promise<Object|null>} - Fresh children data
     */
    async refreshChildren(parentFileBase) {
        // Prevent duplicate refresh operations
        if (this.updateInProgress.has(parentFileBase)) {
            printLog(`🔄 [EDIT-CHILDREN-CACHE] Refresh already in progress for parentFileBase: ${parentFileBase}`);
            return null;
        }

        this.updateInProgress.add(parentFileBase);

        try {
            printLog(`🔄 [EDIT-CHILDREN-CACHE] Refreshing children data for parentFileBase: ${parentFileBase}`);
            const startTime = Date.now();

            // Find all edits for this parent file
            const childEdits = await WorkProductV2.find({
                type: 'video-edit',
                'result.parentFileBase': parentFileBase
            });

            printLog(`📊 [EDIT-CHILDREN-CACHE] Found ${childEdits.length} child edits for parentFileBase: ${parentFileBase}`);

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

            // Sort by createdAt (most recent first), with null values at the end
            formattedEdits.sort((a, b) => {
                // If both have createdAt, sort by most recent first
                if (a.createdAt && b.createdAt) {
                    return new Date(b.createdAt) - new Date(a.createdAt);
                }
                // If only a has createdAt, a comes first
                if (a.createdAt && !b.createdAt) {
                    return -1;
                }
                // If only b has createdAt, b comes first
                if (!a.createdAt && b.createdAt) {
                    return 1;
                }
                // If neither has createdAt, maintain original order (or sort by _id)
                return 0;
            });

            const childrenData = {
                parentFileBase,
                childCount: formattedEdits.length,
                children: formattedEdits,
                lastUpdated: new Date()
            };

            // Update cache
            this.cache.set(parentFileBase, {
                data: childrenData,
                timestamp: Date.now(),
                expiresAt: Date.now() + this.cacheExpiry
            });

            const duration = Date.now() - startTime;
            printLog(`✅ [EDIT-CHILDREN-CACHE] Successfully refreshed children data for parentFileBase: ${parentFileBase} in ${duration}ms`);

            return childrenData;

        } catch (error) {
            printLog(`❌ [EDIT-CHILDREN-CACHE] Error refreshing children data for parentFileBase: ${parentFileBase}: ${error.message}`);
            throw error;
        } finally {
            this.updateInProgress.delete(parentFileBase);
        }
    }

    /**
     * Invalidate cache for a specific parent file
     * @param {string} parentFileBase - The parent file base name
     */
    invalidate(parentFileBase) {
        if (this.cache.has(parentFileBase)) {
            this.cache.delete(parentFileBase);
            printLog(`🗑️ [EDIT-CHILDREN-CACHE] Invalidated cache for parentFileBase: ${parentFileBase}`);
        }
    }

    /**
     * Invalidate cache for multiple parent files (useful when new edits are created)
     * @param {Array<string>} parentFileBases - Array of parent file base names
     */
    invalidateMultiple(parentFileBases) {
        let invalidated = 0;
        parentFileBases.forEach(parentFileBase => {
            if (this.cache.has(parentFileBase)) {
                this.cache.delete(parentFileBase);
                invalidated++;
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
        this.updateInProgress.clear();
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
        let pendingRefreshes = this.updateInProgress.size;

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
