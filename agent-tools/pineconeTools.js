// pineconeTools.js
const fetch = require('node-fetch');
require('dotenv').config();
const { Pinecone } = require('@pinecone-database/pinecone');
const natural = require('natural');
const tokenizer = new natural.WordTokenizer();
const TfIdf = natural.TfIdf;

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

const pineconeTools = {
    getFeedsDetails : async() => {
        const dummyVector = Array(1536).fill(0);
        const queryResult = await index.query({
            vector: dummyVector,
            filter: {type:"feed"},
            topK: 100,
            includeMetadata: true, // Ensure metadata is included
        });
        console.log(`getFeedsDetails:`,JSON.stringify(queryResult,null,2))
        return queryResult.matches.map((match) => ({
            feedImage:match.metadata.imageUrl || "no image",
            title: match.metadata.title || "Unknown Title",
            description: match.metadata.description || "",
            feedId: match.metadata.feedId || ""
        }));
    },
    formatResults : (matches) => {
        return matches.map((match) => ({
            listenLink: match.metadata.listenLink || "",
            quote: match.metadata.text || "Quote unavailable",
            episode: match.metadata.episode || "Unknown episode",
            creator: match.metadata.creator || "Creator not specified",
            audioUrl: match.metadata.audioUrl || "URL unavailable",
            episodeImage: match.metadata.episodeImage || "Image unavailable",
            date: match.metadata.publishedDate || "Date not provided",
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
        }));
    },
    findSimilarDiscussions : async ({ 
        embedding,
        feedIds, 
        limit = 5,
        query = '', // Optional text query for keyword matching
        hybridWeight = 0.7 // Weight for combining vector and keyword scores (0.7 = 70% vector, 30% keywords)
    }) => {
        try {
            const intFeedIds = feedIds.map(feedId => parseInt(feedId, 10)).filter(id => !isNaN(id));
            
            const filter = {
                type: "paragraph",
                ...(intFeedIds.length > 0 && { feedId: { $in: intFeedIds } }),
            };
            
            // Get more results than needed to allow for hybrid reranking
            const vectorLimit = Math.min(limit * 3, 20);
            
            const queryResult = await index.query({
                vector: embedding,
                filter,
                topK: vectorLimit,
                includeMetadata: true,
            });
    
            // If no text query provided, return original vector results
            if (!query.trim()) {
                return pineconeTools.formatResults(queryResult.matches.slice(0, limit));
            }
    
            // Calculate keyword relevance scores
            const tfidf = new TfIdf();
            
            // Add query to TF-IDF
            tfidf.addDocument(tokenizer.tokenize(query.toLowerCase()));
            
            // Add all retrieved documents
            queryResult.matches.forEach(match => {
                tfidf.addDocument(tokenizer.tokenize(match.metadata.text.toLowerCase()));
            });
    
            // Calculate hybrid scores and rerank
            const hybridResults = queryResult.matches.map((match, index) => {
                // Vector similarity score is already normalized between 0 and 1
                const vectorScore = match.score;
                
                // Normalize TF-IDF scores relative to the maximum score in the set
                const rawKeywordScores = queryResult.matches.map((m, i) => 
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
    
            return pineconeTools.formatResults(rerankedResults);
        } catch (error) {
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

            const queryResult = await index.query({
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
            const stats = await index.describeIndexStats();

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
            const queryResult = await index.query({
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
            const stats = await index.describeIndexStats();
            const total = stats.totalVectorCount;

            const queryResult = await index.query({
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
};

module.exports = pineconeTools;
