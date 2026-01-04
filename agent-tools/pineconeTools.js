// pineconeTools.js
const fetch = require('node-fetch');
require('dotenv').config();
const { Pinecone } = require('@pinecone-database/pinecone');
const natural = require('natural');
const tokenizer = new natural.WordTokenizer();
const TfIdf = natural.TfIdf;
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX = process.env.PINECONE_INDEX;

if (!PINECONE_API_KEY || !PINECONE_INDEX) {
    throw new Error('Missing required Pinecone environment variables. Please check your .env file.');
}

// Initialize Pinecone client
const pinecone = new Pinecone({
    apiKey: PINECONE_API_KEY,
    fetchApi: fetch,
});

const index = pinecone.index(PINECONE_INDEX);

// Global timeout (in ms) for any Pinecone operation invoked from this module
const PINECONE_TIMEOUT_MS = parseInt(process.env.PINECONE_TIMEOUT_MS || '45000', 10);

/**
 * Wrap a Pinecone operation in a timeout for robustness.
 * @param {string} operationName - Human-readable name for logging/errors
 * @param {() => Promise<any>} fn - Function that returns a Pinecone promise
 */
const withPineconeTimeout = async (operationName, fn) => {
    const timeoutMs = PINECONE_TIMEOUT_MS;
    return Promise.race([
        fn(),
        new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Pinecone operation "${operationName}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        })
    ]);
};

const pineconeQuery = (operationName, params) =>
    withPineconeTimeout(operationName, () => index.query(params));

const pineconeFetch = (operationName, ids) =>
    withPineconeTimeout(operationName, () => index.fetch(ids));

const pineconeDescribeStats = (operationName) =>
    withPineconeTimeout(operationName, () => index.describeIndexStats());

const pineconeTools = {
    getFeedsDetails: async () => {
        const dummyVector = Array(1536).fill(0);
        let allFeeds = [];
        let processedFeedIds = new Set();  // Track processed feedIds
        const batchSize = 30;  // Number of feeds per query batch
        let hasMoreFeeds = true;
    
        while (hasMoreFeeds) {
            try {
                // Create a filter to exclude already processed feedIds
                const filter = processedFeedIds.size > 0 
                    ? { type: "feed", feedId: { $nin: [...processedFeedIds] } } 
                    : { type: "feed" };
    
                // Query Pinecone with the filter to exclude processed feedIds
                const queryResult = await pineconeQuery('getFeedsDetails', {
                    vector: dummyVector,
                    filter: filter,
                    topK: batchSize,
                    includeMetadata: true,
                });
    
                // Log the query result for debugging
                console.log(`Query Batch Result:`, JSON.stringify(queryResult, null, 2));
    
                if (!queryResult.matches || queryResult.matches.length === 0) {
                    console.warn('No more matches found for the query.');
                    break;  // Exit the loop if no more results are returned
                }
    
                // Add the new feeds to the result list
                allFeeds = [
                    ...allFeeds,
                    ...queryResult.matches.map(match => ({
                        feedImage: match.metadata.imageUrl || "no image",
                        title: match.metadata.title || "Unknown Title",
                        description: match.metadata.description || "",
                        feedId: match.metadata.feedId || ""
                    }))
                ];
    
                // Add the new feedIds to the processed set
                queryResult.matches.forEach(match => processedFeedIds.add(match.metadata.feedId));
    
                // If fewer than batchSize results were returned, stop the loop
                if (queryResult.matches.length < batchSize) {
                    hasMoreFeeds = false;
                }
    
            } catch (error) {
                console.error("Error fetching feeds details:", error);
                break;  // Exit loop on error
            }
        }
    
        return allFeeds;
    },
    getClipById: async (clipId) => {
        try {
            // Use the correct fetch API format
            const fetchResult = await pineconeFetch('getClipById', [clipId]);
    
            // Check if we got results
            if (!fetchResult || !fetchResult.records || !fetchResult.records[clipId]) {
                console.log('No results found for clipId:', clipId);
                return null;
            }
    
            // Format the single result using the existing formatter
            const match = {
                id: clipId,
                metadata: fetchResult.records[clipId].metadata,
                score: 1, // Direct lookup gets perfect score
                values: fetchResult.records[clipId].values
            };
    
            const formattedResults = pineconeTools.formatResults([match]);
            return formattedResults[0];
    
        } catch (error) {
            console.error('Error in getClipById:', error);
            throw new Error(`Failed to fetch clip: ${error.message}`);
        }
    },
    /**
     * Fetch multiple clips by their Pinecone IDs (sequential per-clip lookup).
     * - Uses getClipById under the hood for robustness
     * - Preserves input order (including duplicates)
     * - Hard-caps at 50 items to bound latency
     *
     * NOTE: For better performance when fetching many clips, prefer
     *       getClipsByIdsBatch which uses Pinecone's batch fetch API.
     *
     * @param {string[]} ids
     * @returns {Promise<Array<object>>} formatted clip results
     */
    getClipsByIds: async (ids = []) => {
        if (!Array.isArray(ids) || ids.length === 0) {
            return [];
        }

        const limitedIds = ids.slice(0, 50);
        const results = [];

        for (const id of limitedIds) {
            try {
                const clip = await pineconeTools.getClipById(id);
                if (clip) {
                    results.push(clip);
                }
            } catch (error) {
                console.error(`Error fetching clip ${id} in getClipsByIds:`, error.message);
                // Swallow per-clip errors so a single bad ID doesn't break the whole batch
            }
        }

        return results;
    },
    /**
     * Fetch multiple clips by their Pinecone IDs using batch fetch.
     * - Uses Pinecone's batch fetch under the hood
     * - Batches requests in chunks of 20 IDs to avoid service limits
     * - Preserves input order (including duplicates)
     * - Hard-caps at 50 items to bound latency
     *
     * @param {string[]} ids
     * @returns {Promise<Array<object>>} formatted clip results
     */
    getClipsByIdsBatch: async (ids = []) => {
        if (!Array.isArray(ids) || ids.length === 0) {
            return [];
        }

        const limitedIds = ids.slice(0, 50);
        const BATCH_SIZE = 10;

        // Collect results keyed by id so we can re-expand in the original order (including duplicates)
        const byId = new Map();

        for (let start = 0; start < limitedIds.length; start += BATCH_SIZE) {
            const batchIds = limitedIds.slice(start, start + BATCH_SIZE);

            try {
                const fetchResult = await pineconeFetch('getClipsByIdsBatch', batchIds);
                const records = fetchResult && fetchResult.records ? fetchResult.records : {};

                const matches = Object.keys(records).map((id) => {
                    const record = records[id] || {};
                    return {
                        id,
                        metadata: record.metadata || {},
                        // Direct lookup gets a perfect score; callers typically don't rely on this
                        score: 1,
                        values: record.values
                    };
                });

                const formatted = pineconeTools.formatResults(matches);
                formatted.forEach((clip) => {
                    // Store by shareLink (which is the underlying Pinecone ID)
                    if (clip && clip.shareLink) {
                        byId.set(clip.shareLink, clip);
                    }
                });
            } catch (error) {
                console.error(
                    `Error fetching batch ${start / BATCH_SIZE + 1} in getClipsByIdsBatch:`,
                    error.message
                );
                // Swallow per-batch errors so a single bad batch doesn't break all other batches
            }
        }

        // Rebuild the ordered list in the same order as the input (including duplicates),
        // skipping any IDs that could not be fetched.
        const orderedResults = [];
        for (const id of limitedIds) {
            const clip = byId.get(id);
            if (clip) {
                orderedResults.push(clip);
            }
        }

        return orderedResults;
    },
    formatResults : (matches) => {
        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
        return matches.map((match) => {
            const hierarchyLevel = match.metadata.type || 'paragraph';
            
            // For chapters, prefer the chapter headline/title as the primary text
            const quote =
                hierarchyLevel === 'chapter'
                    ? (match.metadata.headline ||
                       match.metadata.summary ||
                       match.metadata.text ||
                       "Quote unavailable")
                    : (match.metadata.text ||
                       match.metadata.summary ||
                       match.metadata.headline ||
                       "Quote unavailable");

            return {
                shareLink: match.id,
                shareUrl: `${baseUrl}/share?clip=${match.id}`,
                listenLink: match.metadata.listenLink || "",
                quote,
                summary: match.metadata.summary || null,  // For chapters
                headline: match.metadata.headline || null, // For chapters  
                description: match.metadata.description || null, // For episodes
                episode: match.metadata.episode || match.metadata.title || "Unknown episode",
                creator: match.metadata.creator || "Creator not specified",
                audioUrl: match.metadata.audioUrl || "URL unavailable",
                episodeImage: match.metadata.episodeImage || "Image unavailable",
                date: match.metadata.publishedDate || "Date not provided",
                published: match.metadata.publishedDate || match.metadata.publishedTimestamp || null,
                similarity: {
                    combined: parseFloat(match.score.toFixed(4)),
                    vector: parseFloat(match.originalScore?.toFixed(4)) || parseFloat(match.score.toFixed(4)),
                },
                timeContext: {
                    start_time: match.metadata.start_time || null,
                    end_time: match.metadata.end_time || null,
                },
                additionalFields: {
                    feedId: match.metadata.feedId || null,
                    guid: match.metadata.guid || null,
                    sequence: match.metadata.sequence || null,
                    num_words: match.metadata.num_words || null,
                },
                // Include embedding values if present (for 3D projection)
                ...(match.values && { embedding: match.values }),
                // Include type for hierarchy level
                hierarchyLevel
            };
        });
    },
    findSimilarDiscussions : async ({ 
        embedding,
        feedIds, 
        guid = null, // Optional guid to filter by specific episode
        limit = 5,
        query = '', // Optional text query for keyword matching
        hybridWeight = 0.7, // Weight for combining vector and keyword scores (0.7 = 70% vector, 30% keywords)
        minDate = null, // Optional minimum date filter (ISO string or timestamp)
        maxDate = null, // Optional maximum date filter (ISO string or timestamp)
        episodeName = null, // Optional episode name EXACT MATCH filter (must match metadata.episode exactly)
        includeValues = false, // Optional: include embedding vectors in response (NOT USED - will re-embed instead)
        includeMetadata = true // NEW: When false, returns only IDs and scores (caller will fetch metadata from MongoDB)
    }) => {
        const debugPrefix = '[PINECONE-SEARCH]';
        const { printLog } = require('../constants');
        
        printLog(`${debugPrefix} ========== findSimilarDiscussions CALLED ==========`);
        printLog(`${debugPrefix} Parameters:`, {
            feedIds: feedIds.length,
            guid,
            limit,
            query: query.substring(0, 50) + (query.length > 50 ? '...' : ''),
            minDate,
            maxDate,
            episodeName,
            includeValues: includeValues ? 'REQUESTED (will re-embed instead)' : 'false',
            includeMetadata
        });
        
        try {
            printLog(`${debugPrefix} Step 1: Building Pinecone filter...`);
            const intFeedIds = feedIds.map(feedId => parseInt(feedId, 10)).filter(id => !isNaN(id));
            printLog(`${debugPrefix} Parsed ${intFeedIds.length} feed IDs:`, intFeedIds);
            
            // Build Pinecone filter with all metadata constraints
            const filter = {
                type: { $ne: "feed" }, // Exclude feed-level results, allow episode/chapter/paragraph
                ...(intFeedIds.length > 0 && { feedId: { $in: intFeedIds } }),
                ...(guid && { guid }),  // Add guid filter when provided
            };
            
            // Add date filters using timestamp (more precise than date strings)
            if (minDate) {
                const minTimestamp = new Date(minDate).getTime();
                filter.publishedTimestamp = { $gte: minTimestamp };
                printLog(`${debugPrefix} Added minDate filter: ${minDate} (${minTimestamp})`);
            }
            if (maxDate) {
                const maxTimestamp = new Date(maxDate).getTime();
                // Merge with existing publishedTimestamp filter if minDate was set
                if (filter.publishedTimestamp) {
                    filter.publishedTimestamp.$lte = maxTimestamp;
                } else {
                    filter.publishedTimestamp = { $lte: maxTimestamp };
                }
                printLog(`${debugPrefix} Added maxDate filter: ${maxDate} (${maxTimestamp})`);
            }
            
            // Add episode name filter (EXACT MATCH ONLY - no substring matching)
            if (episodeName && episodeName.trim()) {
                filter.episode = { $eq: episodeName.trim() };
                printLog(`${debugPrefix} Added episode name filter: "${episodeName.trim()}"`);
            }
            
            printLog(`${debugPrefix} Final filter:`, JSON.stringify(filter));
            
            // SIMPLIFIED APPROACH: Always use standard query (no includeValues)
            // If embeddings are needed, caller will re-embed using the returned text
            let vectorLimit = Math.min(limit * 3, 20); // Normal behavior for reranking
            printLog(`${debugPrefix} Using vectorLimit: ${vectorLimit}`);
            
            printLog(`${debugPrefix} Step 2: Querying Pinecone (topK: ${vectorLimit}, includeMetadata: ${includeMetadata})...`);
            const queryStartTime = Date.now();
            
            const queryResult = await pineconeQuery('findSimilarDiscussions', {
                vector: embedding,
                filter,
                topK: vectorLimit,
                includeMetadata: includeMetadata,
                includeValues: includeValues, // Pass through the caller's preference
            });
            
            const queryTime = Date.now() - queryStartTime;
            printLog(`${debugPrefix} ✓ Pinecone query completed in ${queryTime}ms`);
            printLog(`${debugPrefix} Received ${queryResult.matches?.length || 0} matches`);
            
            // If no matches from Pinecone, return empty results immediately
            if (!queryResult.matches || queryResult.matches.length === 0) {
                printLog(`${debugPrefix} ✗ No matches from Pinecone - returning empty results`);
                return [];
            }
            
            const matches = queryResult.matches;
            printLog(`${debugPrefix} Step 3: Processing ${matches.length} matches...`);
            
            // If includeMetadata is false, return minimal results (ID, score, and optionally values)
            // Caller will fetch metadata from MongoDB
            if (!includeMetadata) {
                printLog(`${debugPrefix} includeMetadata=false - returning minimal results for MongoDB lookup`);
                const minimalResults = matches.map(match => ({
                    id: match.id,
                    score: match.score,
                    ...(includeValues && match.values && { values: match.values }) // Include values if requested
                }));
                
                // If no query, just slice and return
                if (!query.trim()) {
                    printLog(`${debugPrefix} No text query - returning ${Math.min(matches.length, limit)} minimal results`);
                    return minimalResults.slice(0, limit);
                }
                
                // For hybrid search without metadata, we can't rerank
                // Just return the top vector results
                printLog(`${debugPrefix} Text query provided but no metadata - returning top ${limit} vector results for MongoDB lookup`);
                return minimalResults.slice(0, limit);
            }
            
            // Log first match for debugging (only if we have metadata)
            if (matches.length > 0) {
                printLog(`${debugPrefix} Sample match:`, {
                    id: matches[0].id,
                    score: matches[0].score,
                    hasMetadata: !!matches[0].metadata,
                    textLength: matches[0].metadata?.text?.length
                });
            }
    
            // If no text query provided, return filtered vector results
            if (!query.trim()) {
                printLog(`${debugPrefix} No text query - returning ${Math.min(matches.length, limit)} vector results`);
                return pineconeTools.formatResults(matches.slice(0, limit));
            }
    
            printLog(`${debugPrefix} Step 4: Performing hybrid reranking with TF-IDF...`);
            // Calculate keyword relevance scores on filtered matches
            const tfidf = new TfIdf();
            
            // Add query to TF-IDF
            tfidf.addDocument(tokenizer.tokenize(query.toLowerCase()));
            
            // Add all filtered documents
            matches.forEach(match => {
                // Use appropriate text field based on type: text (paragraph), summary (chapter), description (episode/feed)
                const text = match.metadata?.text || match.metadata?.summary || match.metadata?.description || '';
                if (text) {
                    tfidf.addDocument(tokenizer.tokenize(text.toLowerCase()));
                } else {
                    tfidf.addDocument([]); // Empty document for missing text
                }
            });
    
            // Calculate hybrid scores and rerank
            const hybridResults = matches.map((match, index) => {
                // Vector similarity score is already normalized between 0 and 1
                const vectorScore = match.score;
                
                // Normalize TF-IDF scores relative to the maximum score in the set
                const rawKeywordScores = matches.map((m, i) => 
                    tfidf.tfidf(tokenizer.tokenize(query.toLowerCase()), i + 1)
                );
                const maxKeywordScore = Math.max(...rawKeywordScores);
                const keywordScore = maxKeywordScore > 0 
                    ? (tfidf.tfidf(tokenizer.tokenize(query.toLowerCase()), index + 1) / maxKeywordScore)
                    : 0;
                
                // Combine scores - both are now normalized between 0 and 1
                const hybridScore = (vectorScore * hybridWeight) + (keywordScore * (1 - hybridWeight));
                
                return {
                    ...match,
                    originalScore: match.score,
                    score: hybridScore
                };
            });
    
            // Sort by hybrid score and take top results
            const rerankedResults = hybridResults
                .sort((a, b) => b.score - a.score)
                .slice(0, limit);
    
            printLog(`${debugPrefix} ✓ Hybrid reranking complete - returning ${rerankedResults.length} results`);
            printLog(`${debugPrefix} ========== findSimilarDiscussions COMPLETE ==========`);
            
            return pineconeTools.formatResults(rerankedResults);
        } catch (error) {
            const { printLog } = require('../constants');
            printLog(`${debugPrefix} ========== ERROR IN findSimilarDiscussions ==========`);
            printLog(`${debugPrefix} ✗ Error:`, error.message);
            printLog(`${debugPrefix} Stack:`, error.stack);
            console.error("Error in findSimilarDiscussions:", error);
            throw error;
        }
    },
    findTimelineDiscussions: async ({ embedding, timeframe = 'P6M' }) => {
        try {
            // Calculate the date threshold
            const thresholdDate = new Date();
            const months = parseInt(timeframe.match(/\d+/)[0]); // Extract number of months
            thresholdDate.setMonth(thresholdDate.getMonth() - months);

            const queryResult = await pineconeQuery('findTimelineDiscussions', {
                vector: embedding,
                topK: 100, // Fetch more results to group by episode
                includeMetadata: true,
            });

            // Group results by episode
            const episodeMap = new Map();
            queryResult.matches.forEach(match => {
                const episodeKey = match.metadata.episode_title;
                if (!episodeMap.has(episodeKey)) {
                    episodeMap.set(episodeKey, {
                        episode: match.metadata.episode_title,
                        date: match.metadata.published_date,
                        quotes: [],
                        mentionCount: 0,
                    });
                }
                const episode = episodeMap.get(episodeKey);
                episode.quotes.push(match.metadata.text);
                episode.mentionCount++;
            });

            return Array.from(episodeMap.values())
                .sort((a, b) => new Date(a.date) - new Date(b.date));
        } catch (error) {
            console.error('Error in findTimelineDiscussions:', error);
            throw error;
        }
    },

    getStats: async () => {
        try {
            const stats = await pineconeDescribeStats('getStats');

            return {
                paragraphCount: stats.totalVectorCount,
                episodeCount: await pineconeTools.getUniqueMetadataCount('episode_title'),
                creatorCount: await pineconeTools.getUniqueMetadataCount('creator'),
                embeddingCount: stats.totalVectorCount,
            };
        } catch (error) {
            console.error('Error in getStats:', error);
            throw error;
        }
    },
    getUniqueMetadataCount: async (metadataField) => {
        try {
            const sampleSize = 10000; // Adjust based on your dataset size
            const queryResult = await pineconeQuery(`getUniqueMetadataCount:${metadataField}`, {
                vector: Array(1536).fill(0), // Assuming 1536-dimensional embeddings
                topK: sampleSize,
                includeMetadata: true,
                includeValues: false,
            });

            const uniqueValues = new Set(
                queryResult.matches.map(match => match.metadata[metadataField]),
            );
            return uniqueValues.size;
        } catch (error) {
            console.error(`Error getting unique ${metadataField} count:`, error);
            return 0;
        }
    },

    validateEmbeddings: async () => {
        try {
            const stats = await pineconeDescribeStats('validateEmbeddings:describeIndexStats');
            const total = stats.totalVectorCount;

            const queryResult = await pineconeQuery('validateEmbeddings:sampleQuery', {
                vector: Array(1536).fill(0), // Dummy vector
                topK: Math.min(total, 1000), // Limit to a sample size
                includeMetadata: true,
            });

            const withEmbeddings = queryResult.matches.length;

            return {
                totalParagraphs: total,
                withEmbeddings,
                percentageComplete: ((withEmbeddings / total) * 100).toFixed(2) + '%',
            };
        } catch (error) {
            console.error('Error in validateEmbeddings:', error);
            throw error;
        }
    },

    /**
     * Fetches episode metadata from MongoDB by GUID
     * @param {string} guid - Episode GUID
     * @returns {Object|null} Episode metadata or null if not found
     */
    getEpisodeByGuid: async (guid) => {
        try {
            if (!guid) {
                throw new Error('GUID is required to fetch episode data');
            }
            
            // Dynamically require to avoid circular dependency issues
            const JamieVectorMetadata = require('../models/JamieVectorMetadata');
            
            // Query MongoDB for episode with this guid
            const episodeDoc = await JamieVectorMetadata.findOne({
                type: 'episode',
                guid: guid
            })
            .select('pineconeId metadataRaw')
            .lean();
            
            // Check if we got results
            if (!episodeDoc || !episodeDoc.metadataRaw) {
                console.log('No episode found for guid:', guid);
                return null;
            }
            
            const metadata = episodeDoc.metadataRaw;
            
            // Return the episode metadata
            return {
                id: episodeDoc.pineconeId,
                guid: guid,
                title: metadata.title || metadata.episode || "Unknown Title",
                description: metadata.description || "",
                publishedDate: metadata.publishedDate || metadata.published_date || null,
                creator: metadata.creator || "Unknown Creator",
                feedId: metadata.feedId || null,
                audioUrl: metadata.audioUrl || null,
                episodeImage: metadata.episodeImage 
                              || metadata.image 
                              || metadata.imageUrl 
                              || null,
                duration: metadata.duration || null,
                listenLink: metadata.listenLink || null,
                // Include any other relevant metadata fields
                additionalMetadata: metadata
            };
        } catch (error) {
            console.error('Error in getEpisodeByGuid:', error);
            throw new Error(`Failed to fetch episode data from MongoDB: ${error.message}`);
        }
    },
    
    // Add a utility function to get paragraph and its corresponding episode
    getParagraphWithEpisodeData: async (paragraphId) => {
        try {
            // First, get the paragraph data
            const paragraph = await pineconeTools.getClipById(paragraphId);
            
            if (!paragraph) {
                return null;
            }
            
            // Extract the guid from the paragraph
            const guid = paragraph.additionalFields?.guid || 
                         (paragraph.shareLink && paragraph.shareLink.includes('_p') ? 
                          paragraph.shareLink.split('_p')[0] : null);
            
            if (!guid) {
                console.warn('Could not extract guid from paragraph:', paragraphId);
                return { paragraph, episode: null };
            }
            
            // Get the episode data using the guid
            const episode = await pineconeTools.getEpisodeByGuid(guid);
            
            // Return both paragraph and episode data
            return { paragraph, episode };
        } catch (error) {
            console.error('Error in getParagraphWithEpisodeData:', error);
            throw new Error(`Failed to fetch paragraph with episode data: ${error.message}`);
        }
    },

    getFeedById: async (feedId) => {
        const debugPrefix = '[MONGO-FEED-BY-ID]';
        const { printLog } = require('../constants');
        printLog(`${debugPrefix} Fetching feed from MongoDB for feedId: ${feedId}`);
        
        try {
            if (!feedId) {
                throw new Error('Feed ID is required to fetch feed data');
            }
            
            // Convert feedId to both string and number for flexible matching
            const feedIdStr = String(feedId);
            const feedIdNum = parseInt(feedId, 10);
            
            // Query MongoDB for feed with flexible feedId matching
            const feedDoc = await JamieVectorMetadata.findOne({
                type: 'feed',
                $or: [
                    { feedId: feedIdStr },
                    { feedId: feedIdNum }
                ]
            }).select('pineconeId metadataRaw').lean();
            
            if (!feedDoc) {
                printLog(`${debugPrefix} No feed found in MongoDB for feedId: ${feedId}`);
                return null;
            }
            
            const metadata = feedDoc.metadataRaw;
            printLog(`${debugPrefix} Found feed in MongoDB: ${metadata.title || 'Unknown Title'}`);
            
            // Format and return using the same structure as Pinecone version
            return {
                id: feedDoc.pineconeId,
                feedId: metadata.feedId || feedId,
                title: metadata.title || "Unknown Title",
                description: metadata.description || "",
                author: metadata.author || metadata.creator || "Unknown Author",
                imageUrl: metadata.imageUrl || metadata.image || null,
                language: metadata.language || "en",
                explicit: metadata.explicit || false,
                episodeCount: metadata.episodeCount || 0,
                feedUrl: metadata.feedUrl || null,
                podcastGuid: metadata.podcastGuid || null,
                lastUpdateTime: metadata.lastUpdateTime || null,
                additionalMetadata: metadata
            };
        } catch (error) {
            printLog(`${debugPrefix} Error in getFeedById: ${error.message}`);
            console.error('Error in getFeedById:', error);
            throw new Error(`Failed to fetch feed data from MongoDB: ${error.message}`);
        }
    },
    
    // Helper function to format feed data consistently
    formatFeedData: (match) => {
        return {
            id: match.id,
            feedId: match.metadata.feedId || "",
            title: match.metadata.title || "Unknown Title",
            description: match.metadata.description || "",
            author: match.metadata.author || match.metadata.creator || "Unknown Author",
            imageUrl: match.metadata.imageUrl || match.metadata.image || null,
            language: match.metadata.language || "en",
            explicit: match.metadata.explicit || false,
            episodeCount: match.metadata.episodeCount || 0,
            feedUrl: match.metadata.feedUrl || null,
            podcastGuid: match.metadata.podcastGuid || null,
            lastUpdateTime: match.metadata.lastUpdateTime || null,
            // Include any other relevant metadata fields
            additionalMetadata: match.metadata
        };
    },
    
    // Add a utility function to get paragraph with its feed data
    getParagraphWithFeedData: async (paragraphId) => {
        try {
            // First, get the paragraph data
            const paragraph = await pineconeTools.getClipById(paragraphId);
            
            if (!paragraph) {
                return null;
            }
            
            // Extract the feedId from the paragraph
            const feedId = paragraph.additionalFields?.feedId || null;
            
            if (!feedId) {
                console.warn('Could not extract feedId from paragraph:', paragraphId);
                return { paragraph, feed: null };
            }
            
            // Get the feed data using the feedId
            const feed = await pineconeTools.getFeedById(feedId);
            
            // Return both paragraph and feed data
            return { paragraph, feed };
        } catch (error) {
            console.error('Error in getParagraphWithFeedData:', error);
            throw new Error(`Failed to fetch paragraph with feed data: ${error.message}`);
        }
    },

    /**
     * Gets text content from Pinecone for a specific time range in an episode
     * @param {string} guid - Episode GUID
     * @param {number} startTime - Start time in seconds
     * @param {number} endTime - End time in seconds
     * @returns {string} - Combined text from all paragraphs in the time range
     */
    getTextForTimeRange: async (guid, startTime, endTime) => {
        console.log(`Finding text for guid: ${guid}, time range: ${startTime}-${endTime}`);
        
        try {
            // Create a dummy vector for querying
            const dummyVector = Array(1536).fill(0);
            
            // Query Pinecone for paragraphs that overlap with the time range
            const result = await pineconeQuery('getTextForTimeRange', {
                vector: dummyVector,
                filter: {
                    type: "paragraph",
                    guid: guid,
                    $or: [
                        // Paragraph starts within our range
                        { start_time: { $gte: startTime, $lte: endTime } },
                        // Paragraph ends within our range
                        { end_time: { $gte: startTime, $lte: endTime } },
                        // Paragraph completely contains our range
                        { $and: [{ start_time: { $lte: startTime } }, { end_time: { $gte: endTime } }] }
                    ]
                },
                includeMetadata: true,
                topK: 50 // Adjust as needed
            });
            
            if (!result.matches || result.matches.length === 0) {
                console.warn(`No paragraphs found for guid ${guid} in time range ${startTime}-${endTime}`);
                return null;
            }
            
            // Sort paragraphs by start time
            const sortedParagraphs = result.matches
                .sort((a, b) => a.metadata.start_time - b.metadata.start_time);
            
            // Combine text from all paragraphs
            const combinedText = sortedParagraphs
                .map(p => p.metadata.text)
                .join(' ');
            
            return combinedText;
        } catch (error) {
            console.error(`Error getting text for time range:`, error);
            return null;
        }
    },

    // Fast stats function that returns raw stats from Pinecone
    getQuickStats: async () => {
        try {
            return await pineconeDescribeStats('getQuickStats');
        } catch (error) {
            console.error('Error in getQuickStats:', error);
            throw error;
        }
    }
};

// Helper function to format feed data (outside the object for reuse)
function formatFeedData(match) {
    return {
        id: match.id,
        feedId: match.metadata.feedId || "",
        title: match.metadata.title || "Unknown Title",
        description: match.metadata.description || "",
        author: match.metadata.author || match.metadata.creator || "Unknown Author",
        imageUrl: match.metadata.imageUrl || match.metadata.image || null,
        language: match.metadata.language || "en",
        explicit: match.metadata.explicit || false,
        episodeCount: match.metadata.episodeCount || 0,
        feedUrl: match.metadata.feedUrl || null,
        podcastGuid: match.metadata.podcastGuid || null,
        lastUpdateTime: match.metadata.lastUpdateTime || null,
        // Include any other relevant metadata fields
        additionalMetadata: match.metadata
    };
}

module.exports = pineconeTools;
