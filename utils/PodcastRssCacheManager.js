const { ProPodcastDetails } = require('../models/ProPodcastDetails');
const { printLog } = require('../constants');

/**
 * Manages caching of podcast RSS episode data to reduce external API calls
 * Caches each podcast's episode data every hour
 */
class PodcastRssCacheManager {
    constructor() {
        this.cache = new Map(); // feedId -> { data, timestamp, expiresAt }
        this.cacheExpiry = 60 * 60 * 1000; // 1 hour in milliseconds
        this.isUpdating = false;
        this.updateInProgress = new Set(); // Track which feeds are being updated
    }

    /**
     * Get cached podcast data or fetch fresh if expired/missing
     * @param {string} feedId - The podcast feed ID
     * @returns {Object|null} - Cached podcast data or null if not found
     */
    async getPodcastData(feedId) {
        const cached = this.cache.get(feedId);
        const now = Date.now();

        // Return cached data if it exists and hasn't expired
        if (cached && cached.expiresAt > now) {
            printLog(`📦 [RSS CACHE] Cache hit for feedId: ${feedId} (${Math.round((cached.expiresAt - now) / 1000 / 60)}min remaining)`);
            return cached.data;
        }

        // If cache is expired or missing, trigger background refresh
        if (cached) {
            printLog(`⏰ [RSS CACHE] Cache expired for feedId: ${feedId}, triggering background refresh`);
        } else {
            printLog(`❌ [RSS CACHE] No cache found for feedId: ${feedId}, triggering background refresh`);
        }

        // Trigger background refresh (non-blocking)
        this.refreshPodcastData(feedId).catch(err => {
            printLog(`❌ [RSS CACHE] Background refresh failed for feedId: ${feedId}: ${err.message}`);
        });

        // Return cached data even if expired (stale-while-revalidate pattern)
        return cached ? cached.data : null;
    }

    /**
     * Refresh podcast data for a specific feed
     * @param {string} feedId - The podcast feed ID
     * @returns {Promise<Object|null>} - Fresh podcast data
     */
    async refreshPodcastData(feedId) {
        // Prevent concurrent updates for the same feed
        if (this.updateInProgress.has(feedId)) {
            printLog(`⏳ [RSS CACHE] Update already in progress for feedId: ${feedId}`);
            return this.cache.get(feedId)?.data || null;
        }

        this.updateInProgress.add(feedId);
        const refreshStartTime = Date.now();

        try {
            printLog(`🔄 [RSS CACHE] Starting refresh for feedId: ${feedId}`);

            // Get podcast metadata from database
            const podcast = await ProPodcastDetails.findOne({ feedId }).lean();
            if (!podcast) {
                printLog(`❌ [RSS CACHE] Podcast not found in database: ${feedId}`);
                return null;
            }

            // Fetch fresh RSS data
            const rssData = await this.fetchRssData(podcast.feedUrl, feedId);
            if (!rssData) {
                printLog(`❌ [RSS CACHE] Failed to fetch RSS data for feedId: ${feedId}`);
                return null;
            }

            // Process and cache the data
            const processedData = {
                ...podcast,
                episodes: rssData.episodes?.episodes?.map(episode => ({
                    id: episode.itemUUID || `episode-${Date.now()}`,
                    title: episode.itemTitle || 'Untitled Episode',
                    date: episode.publishedDate ? new Date(episode.publishedDate * 1000).toLocaleDateString() : 'No date',
                    duration: episode.length ? this.formatDuration(episode.length) : '00:00',
                    audioUrl: episode.itemUrl || '',
                    description: episode.description ? this.sanitizeDescription(episode.description) : '',
                    episodeNumber: episode.episodeNumber || '',
                    episodeImage: episode.episodeImage || podcast.logoUrl,
                    listenLink: podcast.listenLink
                })) || []
            };

            // Update cache
            const now = Date.now();
            this.cache.set(feedId, {
                data: processedData,
                timestamp: now,
                expiresAt: now + this.cacheExpiry
            });

            const refreshTime = Date.now() - refreshStartTime;
            printLog(`✅ [RSS CACHE] Successfully refreshed feedId: ${feedId} in ${refreshTime}ms (${processedData.episodes.length} episodes)`);

            return processedData;

        } catch (error) {
            const refreshTime = Date.now() - refreshStartTime;
            printLog(`❌ [RSS CACHE] Refresh failed for feedId: ${feedId} after ${refreshTime}ms: ${error.message}`);
            throw error;
        } finally {
            this.updateInProgress.delete(feedId);
        }
    }

    /**
     * Fetch RSS data from external service
     * @param {string} feedUrl - The RSS feed URL
     * @param {string} feedId - The feed ID
     * @returns {Promise<Object|null>} - RSS data or null if failed
     */
    async fetchRssData(feedUrl, feedId) {
        const axios = require('axios');
        const rssRequestStartTime = Date.now();
        
        try {
            const response = await axios.post('https://rss-extractor-app-yufbq.ondigitalocean.app/getFeed', {
                feedUrl,
                feedId,
                limit: 10
            }, {
                headers: {
                    'accept': 'application/json',
                    'content-type': 'application/json',
                    'authorization': 'Bearer: no-token'
                },
                timeout: 10000
            });

            const rssRequestTime = Date.now() - rssRequestStartTime;
            printLog(`📡 [RSS CACHE] RSS service responded in ${rssRequestTime}ms for feedId: ${feedId}`);
            
            return response.data;
        } catch (error) {
            const rssErrorTime = Date.now() - rssRequestStartTime;
            printLog(`❌ [RSS CACHE] RSS service failed after ${rssErrorTime}ms for feedId: ${feedId}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Refresh all cached podcasts (for scheduled updates)
     * @returns {Promise<Object>} - Summary of refresh results
     */
    async refreshAllPodcasts() {
        if (this.isUpdating) {
            printLog(`⏳ [RSS CACHE] Global refresh already in progress, skipping...`);
            return { skipped: true };
        }

        this.isUpdating = true;
        const refreshStartTime = Date.now();

        try {
            printLog(`🔄 [RSS CACHE] Starting global refresh of all podcasts...`);

            // Get all podcasts from database
            const podcasts = await ProPodcastDetails.find({}).select('feedId').lean();
            printLog(`📋 [RSS CACHE] Found ${podcasts.length} podcasts to refresh`);

            const results = {
                total: podcasts.length,
                successful: 0,
                failed: 0,
                errors: []
            };

            // Refresh each podcast (with concurrency limit)
            const concurrencyLimit = 5;
            const chunks = [];
            for (let i = 0; i < podcasts.length; i += concurrencyLimit) {
                chunks.push(podcasts.slice(i, i + concurrencyLimit));
            }

            for (const chunk of chunks) {
                const promises = chunk.map(async (podcast) => {
                    try {
                        await this.refreshPodcastData(podcast.feedId);
                        results.successful++;
                    } catch (error) {
                        results.failed++;
                        results.errors.push({ feedId: podcast.feedId, error: error.message });
                    }
                });

                await Promise.all(promises);
            }

            const totalTime = Date.now() - refreshStartTime;
            printLog(`✅ [RSS CACHE] Global refresh completed in ${totalTime}ms - ${results.successful} successful, ${results.failed} failed`);

            return results;

        } catch (error) {
            const totalTime = Date.now() - refreshStartTime;
            printLog(`❌ [RSS CACHE] Global refresh failed after ${totalTime}ms: ${error.message}`);
            throw error;
        } finally {
            this.isUpdating = false;
        }
    }

    /**
     * Get cache statistics
     * @returns {Object} - Cache statistics
     */
    getCacheStats() {
        const now = Date.now();
        const entries = Array.from(this.cache.entries());
        
        return {
            totalEntries: entries.length,
            expiredEntries: entries.filter(([_, data]) => data.expiresAt <= now).length,
            activeEntries: entries.filter(([_, data]) => data.expiresAt > now).length,
            memoryUsage: process.memoryUsage().heapUsed,
            updateInProgress: this.updateInProgress.size
        };
    }

    /**
     * Clear expired cache entries
     */
    cleanupExpiredEntries() {
        const now = Date.now();
        let cleaned = 0;

        for (const [feedId, data] of this.cache.entries()) {
            if (data.expiresAt <= now) {
                this.cache.delete(feedId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            printLog(`🧹 [RSS CACHE] Cleaned up ${cleaned} expired cache entries`);
        }
    }

    // Helper methods (copied from LandingPageService)
    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = seconds % 60;
        
        const padZero = (num) => num.toString().padStart(2, '0');
        
        if (hours > 0) {
            return `${hours}:${padZero(minutes)}:${padZero(remainingSeconds)}`;
        }
        return `${minutes}:${padZero(remainingSeconds)}`;
    }

    sanitizeDescription(description) {
        if (!description) return '';
        return description.replace(/<[^>]*>/g, '').substring(0, 500);
    }
}

module.exports = PodcastRssCacheManager;
