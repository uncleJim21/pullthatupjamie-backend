require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const neo4jDriver = require('./mentionsNeo4jDriver');
const { OpenAI } = require('openai');

class BatchPodcastProcessor {
    constructor(options = {}) {
        this.SHARED_SECRET = process.env.SHARED_HMAC_SECRET;
        this.WHISPR_BASE_URL = 'https://whispr-v3-w-caching-ex8zk.ondigitalocean.app/WHSPR';
        
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        
        this.BATCH_SIZE = options.batchSize || 20;
        this.CONCURRENT_BATCHES = options.concurrentBatches || 3;
        this.NEO4J_BATCH_SIZE = options.neo4jBatchSize || 50;
    }

    async processFeed(feedUrl, feedId) {
        const session = neo4jDriver.session();
        try {
            console.log('Fetching feed metadata...');
            const feedResponse = await axios.post('https://rss-extractor-app-yufbq.ondigitalocean.app/searchFeeds', {
                podcastName: feedUrl
            });
            
            const feedData = feedResponse.data.data.feeds.find(f => f.id === feedId);
            if (!feedData) {
                throw new Error(`Feed not found with ID ${feedId}`);
            }

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
            
            // First check if episode exists
            const episodeExists = await this.checkEpisodeExists(episode.episodeGUID);
            if (episodeExists) {
                console.log(`Episode ${episode.itemTitle} already exists, skipping...`);
                return { success: false, reason: 'Episode already exists' };
            }
    
            const transcript = await this.getTranscript(audioUrl, episode.episodeGUID);
            await this.storeEpisodeData(episode, feedId);
    
            if (transcript && transcript.channels && transcript.channels.length > 0) {
                const paragraphs = this.extractParagraphs(transcript);
                if (paragraphs.length > 0) {
                    await this.batchProcessParagraphs(paragraphs, episode.episodeGUID, feedId);
                    return { success: true, paragraphCount: paragraphs.length };
                } else {
                    console.warn(`No valid paragraphs found in transcript for episode: ${episode.itemTitle}`);
                    return { success: false, paragraphCount: 0, reason: 'No valid paragraphs found' };
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
    
    // Add this new method to check if episode exists
    async checkEpisodeExists(episodeGuid) {
        const session = neo4jDriver.session();
        try {
            const result = await session.run(`
                MATCH (e:Episode {guid: $guid})
                RETURN count(e) as count
            `, {
                guid: episodeGuid
            });
            return result.records[0].get('count') > 0;
        } finally {
            await session.close();
        }
    }
    
    async storeEpisodeData(episode, feedId) {
        const session = neo4jDriver.session();
        try {
            await session.run(`
                MATCH (f:Feed {feedId: $feedId})
                CREATE (e:Episode {
                    guid: $guid,
                    feedId: $feedId,
                    title: $title,
                    description: $description,
                    publishedDate: datetime($publishedDate),
                    duration: $duration,
                    creator: $creator,
                    episodeNumber: $episodeNumber,
                    imageUrl: $imageUrl,
                    audioUrl: $audioUrl,
                    createdAt: datetime(),
                    updatedAt: datetime()
                })
                CREATE (f)-[:CONTAINS]->(e)
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

    extractParagraphs(transcript) {
        try {
            if (!transcript?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs) {
                console.warn('Invalid transcript structure:', JSON.stringify(transcript, null, 2));
                return [];
            }

            const paragraphs = transcript.channels[0].alternatives[0].paragraphs.paragraphs;

            if (!Array.isArray(paragraphs)) {
                console.warn('Paragraphs is not an array:', paragraphs);
                return [];
            }

            return paragraphs.map(paragraph => {
                if (!paragraph?.sentences || !Array.isArray(paragraph.sentences)) {
                    console.warn('Invalid paragraph structure:', paragraph);
                    return null;
                }

                const paragraphText = paragraph.sentences.map(s => s.text).join(' ');
                return {
                    text: paragraphText,
                    start_time: paragraph.start,
                    end_time: paragraph.end,
                    num_words: paragraph.num_words,
                    words: transcript.channels[0].words?.filter(w => w.start >= paragraph.start && w.end <= paragraph.end) || []
                };
            }).filter(Boolean); // Remove null paragraphs
        } catch (error) {
            console.error('Error extracting paragraphs:', error);
            return [];
        }
    }

    async batchProcessParagraphs(paragraphs, episodeGuid, feedId) {
        const batches = this.chunkArray(paragraphs, this.BATCH_SIZE);
        const embeddedParagraphs = [];

        for (let i = 0; i < batches.length; i += this.CONCURRENT_BATCHES) {
            const batchPromises = batches.slice(i, i + this.CONCURRENT_BATCHES)
                .map(async batch => {
                    const batchEmbeddings = await this.getBatchEmbeddings(
                        batch.map(p => p.text)
                    );
                    return batch.map((paragraph, index) => ({
                        ...paragraph,
                        embedding: batchEmbeddings[index]
                    }));
                });

            const results = await Promise.all(batchPromises);
            embeddedParagraphs.push(...results.flat());

            if (i + this.CONCURRENT_BATCHES < batches.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        await this.batchInsertParagraphs(embeddedParagraphs, episodeGuid, feedId);
    }

    async getBatchEmbeddings(texts) {
        const response = await this.openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: texts
        });
        return response.data.map(item => item.embedding);
    }

    async batchInsertParagraphs(paragraphs, episodeGuid, feedId) {
        const session = neo4jDriver.session();
        try {
            const batches = this.chunkArray(paragraphs, this.NEO4J_BATCH_SIZE);
            
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                
                await session.run(`
                    MATCH (e:Episode {guid: $episodeGuid})
                    UNWIND $paragraphs as paragraph
                    CREATE (p:Paragraph {
                        guid: apoc.create.uuid(),
                        text: paragraph.text,
                        start_time: paragraph.start_time,
                        end_time: paragraph.end_time,
                        embedding: paragraph.embedding,
                        num_words: paragraph.num_words,
                        createdAt: datetime(),
                        updatedAt: datetime()
                    })
                    CREATE (e)-[:CONTAINS]->(p)
                    WITH p, paragraph
                    ORDER BY paragraph.start_time
                    WITH collect(p) as paragraphs
                    FOREACH (i in range(0, size(paragraphs)-2) |
                        FOREACH (p1 in [paragraphs[i]] |
                            FOREACH (p2 in [paragraphs[i+1]] |
                                CREATE (p1)-[:NEXT]->(p2)
                            )
                        )
                    )
                `, {
                    episodeGuid,
                    paragraphs: batch
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