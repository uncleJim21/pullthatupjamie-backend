require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const neo4jDriver = require('./mentionsNeo4jDriver');
const { OpenAI } = require('openai');  // Fixed import syntax

class BatchPodcastProcessor {
    constructor(options = {}) {
        this.SHARED_SECRET = process.env.SHARED_HMAC_SECRET;
        this.WHISPR_BASE_URL = 'https://whispr-v3-w-caching-ex8zk.ondigitalocean.app/WHSPR';
        
        // Initialize OpenAI with new client format
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        
        // Batch processing configuration
        this.BATCH_SIZE = options.batchSize || 20;
        this.CONCURRENT_BATCHES = options.concurrentBatches || 3;
        this.NEO4J_BATCH_SIZE = options.neo4jBatchSize || 50;
    }

    async processFeed(feedUrl, feedId) {
        const session = neo4jDriver.session();
        try {
            // Fetch feed metadata
            console.log('Fetching feed metadata...');
            const feedResponse = await axios.post('https://rss-extractor-app-yufbq.ondigitalocean.app/searchFeeds', {
                podcastName: feedUrl
            });
            
            const feedData = feedResponse.data.data.feeds.find(f => f.id === feedId);
            if (!feedData) {
                throw new Error(`Feed not found with ID ${feedId}`);
            }

            // Store feed data
            await session.run(`
                MERGE (f:Feed {feedId: $feedId})
                ON CREATE SET
                    f.podcastGuid = $podcastGuid,
                    f.title = $title,
                    f.author = $author,
                    f.description = $description,
                    f.language = $language,
                    f.feedUrl = $feedUrl,
                    f.imageUrl = $imageUrl,
                    f.lastUpdateTime = $lastUpdateTime,
                    f.explicit = $explicit,
                    f.episodeCount = $episodeCount,
                    f.createdAt = datetime(),
                    f.updatedAt = datetime()
                ON MATCH SET
                    f.lastUpdateTime = $lastUpdateTime,
                    f.episodeCount = $episodeCount,
                    f.updatedAt = datetime()
                RETURN f
            `, {
                feedId: String(feedData.id),
                podcastGuid: feedData.podcastGuid,
                title: feedData.title,
                author: feedData.author,
                description: feedData.description,
                language: feedData.language,
                feedUrl: feedData.url,
                imageUrl: feedData.image,
                lastUpdateTime: feedData.lastUpdateTime,
                explicit: feedData.explicit,
                episodeCount: feedData.episodeCount
            });

            return feedData;
        } finally {
            await session.close();
        }
    }

    async processAudioUrl(audioUrl, episode, feedId) {
        try {
            console.log(`Processing episode: ${episode.itemTitle}`);
            const transcript = await this.getTranscript(audioUrl, episode.episodeGUID);
            
            // Store episode data first
            await this.storeEpisodeData(episode, feedId);

            // Process transcript if available
            if (transcript && transcript.channels && transcript.channels.length > 0) {
                // Process transcript sentences
                const sentences = this.extractSentences(transcript);
                if (sentences.length > 0) {
                    await this.batchProcessSentences(sentences, episode.episodeGUID, feedId);
                    return { success: true, sentenceCount: sentences.length };
                } else {
                    console.warn(`No valid sentences found in transcript for episode: ${episode.itemTitle}`);
                    return { success: false, sentenceCount: 0, reason: 'No valid sentences found' };
                }
            } else {
                console.warn(`Invalid transcript received for episode: ${episode.itemTitle}`);
                return { success: false, reason: 'Invalid transcript' };
            }
        } catch (error) {
            console.error(`Error processing episode ${episode.itemTitle}:`, error);
            return { success: false, error: error.message };
        }
    }

    async storeEpisodeData(episode, feedId) {
        const session = neo4jDriver.session();
        try {
            await session.run(`
                MATCH (f:Feed {feedId: $feedId})
                MERGE (e:Episode {guid: $guid})
                ON CREATE SET
                    e.feedId = $feedId,
                    e.title = $title,
                    e.description = $description,
                    e.publishedDate = datetime($publishedDate),
                    e.duration = $duration,
                    e.creator = $creator,
                    e.episodeNumber = $episodeNumber,
                    e.imageUrl = $imageUrl,
                    e.audioUrl = $audioUrl,
                    e.createdAt = datetime(),
                    e.updatedAt = datetime()
                ON MATCH SET
                    e.updatedAt = datetime()
                MERGE (f)-[:CONTAINS]->(e)
                RETURN e
            `, {
                feedId: String(feedId),
                guid: episode.episodeGUID,
                title: episode.itemTitle,
                description: episode.description,
                publishedDate: new Date(episode.publishedDate * 1000).toISOString(),
                duration: episode.length,
                creator: episode.creator,
                episodeNumber: episode.episodeNumber,
                imageUrl: episode.episodeImage,
                audioUrl: episode.itemUrl
            });
        } finally {
            await session.close();
        }
    }

    async getTranscript(audioUrl, guid) {
        const timestamp = String(Date.now());
        const hmac = crypto.createHmac('sha256', this.SHARED_SECRET)
            .update(timestamp)
            .digest('hex');

        const postResponse = await axios.post(this.WHISPR_BASE_URL, {
            remote_url: audioUrl,
            guid: guid
        }, {
            headers: {
                'X-HMAC-SIGNATURE': hmac,
                'X-TIMESTAMP': timestamp
            }
        });

        if (!postResponse.data.paymentHash) {
            throw new Error('No payment hash received');
        }

        return await this.pollForTranscriptResult(postResponse.data.paymentHash);
    }

    async pollForTranscriptResult(paymentHash, maxAttempts = 30) {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            
            const poll = async () => {
                if (attempts >= maxAttempts) {
                    reject(new Error('Max polling attempts reached'));
                    return;
                }

                try {
                    const timestamp = String(Date.now());
                    const hmac = crypto.createHmac('sha256', this.SHARED_SECRET)
                        .update(timestamp)
                        .digest('hex');

                    const response = await axios.get(
                        `${this.WHISPR_BASE_URL}/${paymentHash}/get_result`,
                        {
                            headers: {
                                'X-HMAC-SIGNATURE': hmac,
                                'X-TIMESTAMP': timestamp
                            }
                        }
                    );

                    if (response.data && response.data.channels) {
                        resolve(response.data);
                    } else {
                        attempts++;
                        setTimeout(poll, 10000);
                    }
                } catch (error) {
                    if (error.response && error.response.status === 404) {
                        attempts++;
                        setTimeout(poll, 10000);
                    } else {
                        reject(error);
                    }
                }
            };

            poll();
        });
    }

    extractSentences(transcript) {
        try {
            // Validate transcript structure
            if (!transcript?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs) {
                console.warn('Invalid transcript structure:', JSON.stringify(transcript, null, 2));
                return [];
            }

            const paragraphs = transcript.channels[0].alternatives[0].paragraphs.paragraphs;
            
            // Additional validation
            if (!Array.isArray(paragraphs)) {
                console.warn('Paragraphs is not an array:', paragraphs);
                return [];
            }

            const sentences = paragraphs.flatMap(paragraph => {
                if (!paragraph?.sentences || !Array.isArray(paragraph.sentences)) {
                    console.warn('Invalid paragraph structure:', paragraph);
                    return [];
                }

                return paragraph.sentences.map(sentence => {
                    // Validate sentence structure
                    if (!sentence?.text || !sentence?.start || !sentence?.end) {
                        console.warn('Invalid sentence structure:', sentence);
                        return null;
                    }

                    return {
                        text: sentence.text,
                        start_time: sentence.start,
                        end_time: sentence.end,
                        words: transcript.channels[0].words
                            ?.filter(w => w.start >= sentence.start && w.end <= sentence.end) || []
                    };
                }).filter(Boolean); // Remove null sentences
            });

            console.log(`Extracted ${sentences.length} valid sentences`);
            return sentences;
        } catch (error) {
            console.error('Error extracting sentences:', error);
            return [];
        }
    }

    async batchProcessSentences(sentences, episodeGuid, feedId) {
        const batches = this.chunkArray(sentences, this.BATCH_SIZE);
        const embeddedSentences = [];

        for (let i = 0; i < batches.length; i += this.CONCURRENT_BATCHES) {
            const batchPromises = batches.slice(i, i + this.CONCURRENT_BATCHES)
                .map(async batch => {
                    const batchEmbeddings = await this.getBatchEmbeddings(
                        batch.map(s => s.text)
                    );
                    return batch.map((sentence, index) => ({
                        ...sentence,
                        embedding: batchEmbeddings[index]
                    }));
                });

            const results = await Promise.all(batchPromises);
            embeddedSentences.push(...results.flat());

            if (i + this.CONCURRENT_BATCHES < batches.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        await this.batchInsertSentences(embeddedSentences, episodeGuid, feedId);
    }

    async getBatchEmbeddings(texts) {
        const response = await this.openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: texts
        });
        return response.data.map(item => item.embedding);
    }

    async batchInsertSentences(sentences, episodeGuid, feedId) {
        const session = neo4jDriver.session();
        try {
            const batches = this.chunkArray(sentences, this.NEO4J_BATCH_SIZE);
            
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                
                // Create sentences and relationships in one transaction
                await session.run(`
                    MATCH (e:Episode {guid: $episodeGuid})
                    UNWIND $sentences as sentence
                    CREATE (s:Sentence {
                        guid: apoc.create.uuid(),
                        text: sentence.text,
                        start_time: sentence.start_time,
                        end_time: sentence.end_time,
                        embedding: sentence.embedding,
                        createdAt: datetime(),
                        updatedAt: datetime()
                    })
                    CREATE (e)-[:CONTAINS]->(s)
                    WITH s, sentence
                    ORDER BY sentence.start_time
                    WITH collect(s) as sentences
                    FOREACH (i in range(0, size(sentences)-2) |
                        FOREACH (s1 in [sentences[i]] |
                            FOREACH (s2 in [sentences[i+1]] |
                                CREATE (s1)-[:NEXT]->(s2)
                            )
                        )
                    )
                `, {
                    episodeGuid,
                    sentences: batch
                });
            }
        } finally {
            await session.close();
        }
    }

    chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }
}

module.exports = { BatchPodcastProcessor };