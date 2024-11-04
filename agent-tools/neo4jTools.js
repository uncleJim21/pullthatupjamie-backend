const neo4jDriver = require('../mentionsNeo4jDriver');

// Neo4j query tools - each does exactly one thing
const neo4jTools = {
    findSimilarDiscussions: async ({ embedding, limit = 5 }) => {
        const session = neo4jDriver.session();
        try {
            const result = await session.run(`
                MATCH (e:Episode)-[:CONTAINS]->(s:Sentence)
                WHERE s.embedding IS NOT NULL
                WITH e, s, 
                     reduce(dot = 0.0, i in range(0, size($embedding)-1) | 
                        dot + $embedding[i] * s.embedding[i]) as dotProduct,
                     sqrt(reduce(norm1 = 0.0, i in range(0, size($embedding)-1) | 
                        norm1 + $embedding[i] * $embedding[i])) as norm1,
                     sqrt(reduce(norm2 = 0.0, i in range(0, size(s.embedding)-1) | 
                        norm2 + s.embedding[i] * s.embedding[i])) as norm2
                WITH e, s, dotProduct/(norm1*norm2) as similarity
                WHERE similarity > 0.7
                RETURN e.title as episode,
                       e.creator as creator,
                       s.text as quote,
                       e.publishedDate as date,
                       similarity
                ORDER BY similarity DESC
                LIMIT 5
            `, { embedding, limit });

            return result.records.map(record => ({
                episode: record.get('episode'),
                creator: record.get('creator'),
                quote: record.get('quote'),
                date: record.get('date'),
                similarity: record.get('similarity')
            }));
        } finally {
            await session.close();
        }
    },

    findTimelineDiscussions: async ({ embedding, timeframe = 'P1Y' }) => {
        const session = neo4jDriver.session();
        try {
            const result = await session.run(`
                MATCH (e:Episode)-[:CONTAINS]->(s:Sentence)
                WHERE datetime(e.publishedDate) > datetime() - duration("${timeframe}")
                    AND s.embedding IS NOT NULL
                WITH e, s,
                     reduce(dot = 0.0, i in range(0, size($embedding)-1) | 
                        dot + $embedding[i] * s.embedding[i]) as dotProduct,
                     sqrt(reduce(norm1 = 0.0, i in range(0, size($embedding)-1) | 
                        norm1 + $embedding[i] * $embedding[i])) as norm1,
                     sqrt(reduce(norm2 = 0.0, i in range(0, size(s.embedding)-1) | 
                        norm2 + s.embedding[i] * s.embedding[i])) as norm2
                WITH e, s, dotProduct/(norm1*norm2) as similarity
                WHERE similarity > 0.7
                WITH e, collect(s.text) as quotes, e.publishedDate as date
                ORDER BY date
                RETURN e.title as episode,
                       date,
                       quotes,
                       size(quotes) as mention_count
            `, { embedding });

            return result.records.map(record => ({
                episode: record.get('episode'),
                date: record.get('date'),
                quotes: record.get('quotes'),
                mentionCount: record.get('mention_count')
            }));
        } finally {
            await session.close();
        }
    },

    getStats: async () => {
        const session = neo4jDriver.session();
        try {
            const stats = await session.run(`
                MATCH (e:Episode)-[:CONTAINS]->(s:Sentence)
                WITH count(distinct e) as episodeCount,
                     count(s) as sentenceCount,
                     count(distinct e.creator) as creatorCount,
                     count(s.embedding) as embeddingCount
                RETURN episodeCount, sentenceCount, creatorCount, embeddingCount
            `);
            
            const record = stats.records[0];
            return {
                episodeCount: record.get('episodeCount').toNumber(),
                sentenceCount: record.get('sentenceCount').toNumber(),
                creatorCount: record.get('creatorCount').toNumber(),
                embeddingCount: record.get('embeddingCount').toNumber()
            };
        } finally {
            await session.close();
        }
    }
    
};

const validateEmbeddings = async () => {
    const session = neo4jDriver.session();
    try {
        const result = await session.run(`
            MATCH (s:Sentence)
            WITH count(s) as total,
                 count(s.embedding) as withEmbedding
            RETURN total, withEmbedding
        `);
        
        const record = result.records[0];
        const total = record.get('total').toNumber();
        const withEmbedding = record.get('withEmbedding').toNumber();
        
        return {
            totalSentences: total,
            withEmbeddings: withEmbedding,
            percentageComplete: (withEmbedding / total * 100).toFixed(2) + '%'
        };
    } finally {
        await session.close();
    }
};

module.exports = {
    ...neo4jTools,
    validateEmbeddings
};