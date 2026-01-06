// FeedCacheManager.js
const { getFeedsDetails } = require('../agent-tools/pineconeTools');
const DigitalOceanSpacesManager = require('../utils/DigitalOceanSpacesManager');
const { printLog } = require('../constants');
const fetch = require('node-fetch');

class FeedCacheManager {
    constructor(spacesConfig) {
        this.cache = null;
        this.lastUpdateTime = null;
        this.updateInterval = 60 * 10 * 1000; // 10 minutes
        this.isUpdating = false;

        // Initialize DigitalOcean Spaces
        this.spacesManager = new DigitalOceanSpacesManager(
            spacesConfig.endpoint,
            spacesConfig.accessKeyId,
            spacesConfig.secretAccessKey,
            {
                maxRetries: 3,
                baseDelay: 1000,
                maxDelay: 5000,
                timeout: 30000
            }
        );
        
        this.bucketName = spacesConfig.bucketName;
    }

    generateCDNUrl(feedId) {
        return `https://${this.bucketName}.${this.spacesManager.spacesEndpoint}/feed-images/${feedId}.jpg`;
    }

    async uploadImageToCDN(feedId, imageUrl) {
        try {
            if (!imageUrl) return null;

            // Check if image already exists in CDN
            try {
                await this.spacesManager.getFileAsBuffer(
                    this.bucketName,
                    `feed-images/${feedId}.jpg`
                );
                return this.generateCDNUrl(feedId);
            } catch (error) {
                // Image doesn't exist, continue to upload
            }

            // Fetch and upload image
            const response = await fetch(imageUrl);
            if (!response.ok) return null;
            
            const imageBuffer = await response.buffer();
            await this.spacesManager.uploadFile(
                this.bucketName,
                `feed-images/${feedId}.jpg`,
                imageBuffer,
                'image/jpeg'
            );

            return this.generateCDNUrl(feedId);
        } catch (error) {
            console.error(`Error uploading image for feed ${feedId}:`, error);
            return imageUrl; // Return original URL if upload fails
        }
    }

    async processFeeds(response) {
        if (!response?.matches || !Array.isArray(response.matches)) {
            //printLog('Invalid response format:', response);
            return response;
        }

        const updatedMatches = [];
        
        for (const match of response.matches) {
            if (match.metadata?.imageUrl) {
                const cdnUrl = await this.uploadImageToCDN(
                    match.metadata.feedId, 
                    match.metadata.imageUrl
                );
                if (cdnUrl) {
                    match.metadata.imageUrl = cdnUrl;
                }
            }
            updatedMatches.push(match);
        }

        return {
            ...response,
            matches: updatedMatches
        };
    }

    async initialize() {
        try {
            console.log('Initializing feed cache...');
            await this.updateCache();
            this.startUpdateInterval();
            console.log('Feed cache initialized successfully');
        } catch (error) {
            console.error('Error initializing feed cache:', error);
            throw error;
        }
    }

    startUpdateInterval() {
        setInterval(async () => {
            try {
                await this.updateCache();
            } catch (error) {
                console.error('Error in scheduled cache update:', error);
            }
        }, this.updateInterval);
    }

    async updateCache() {
        if (this.isUpdating) {
            console.log('Feed cache update already in progress, skipping...');
            return;
        }

        this.isUpdating = true;
        try {
            console.log('Updating feed cache...');
            const startTime = Date.now();
            const response = await getFeedsDetails();
            this.cache = await this.processFeeds(response);
            this.lastUpdateTime = Date.now();
            const duration = Date.now() - startTime;
            console.log(`Feed cache updated successfully in ${duration}ms. Cache contains ${this.cache?.matches?.length || 0} feeds.`);
        } catch (error) {
            console.error('Error updating feed cache:', error);
            throw error;
        } finally {
            this.isUpdating = false;
        }
    }

    async getFeeds() {
        if (!this.cache || (Date.now() - this.lastUpdateTime) > this.updateInterval) {
            await this.updateCache();
        }
        return this.cache;
    }
}

module.exports = FeedCacheManager;