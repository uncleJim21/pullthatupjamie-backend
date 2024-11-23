const neo4jDriver = require('../mentionsNeo4jDriver');

// Neo4j query tools - each does exactly one thing
const neo4jTools = {
    findSimilarDiscussions : async ({ embedding, limit = 5 }) => {
        const session = neo4jDriver.session();
        try {
            const result = await session.run(`
                MATCH (e:Episode)-[:CONTAINS]->(p:Paragraph)
                WHERE p.embedding IS NOT NULL
                WITH e, p, 
                     reduce(dot = 0.0, i in range(0, size($embedding)-1) | 
                        dot + $embedding[i] * p.embedding[i]) as dotProduct,
                     sqrt(reduce(norm1 = 0.0, i in range(0, size($embedding)-1) | 
                        norm1 + $embedding[i] * $embedding[i])) as norm1,
                     sqrt(reduce(norm2 = 0.0, i in range(0, size(p.embedding)-1) | 
                            norm2 + p.embedding[i] * p.embedding[i])) as norm2
                WITH e, p, dotProduct/(norm1*norm2) as similarity
                WHERE similarity > 0.7
                RETURN e.title as episode,
                       e.creator as creator,
                       e.audioUrl as audioUrl,
                       p.text as quote,
                       e.publishedDate as date,
                       p.start_time as start_time,
                       p.end_time as end_time,
                       similarity
                ORDER BY similarity DESC
                LIMIT toInteger($limit)
            `, { embedding, limit });
    
            return result.records.map(record => ({
                episode: record.get('episode'),
                creator: record.get('creator'),
                audioUrl: record.get('audioUrl'),
                quote: record.get('quote'),
                date: record.get('date'),
                start_time: record.get('start_time'),
                end_time: record.get('end_time'),
                similarity: record.get('similarity')
            }));
        } finally {
            await session.close();
        }
    },
    findTimelineDiscussions: async ({ embedding, timeframe = 'P6M' }) => {
        const session = neo4jDriver.session();
        try {
            const result = await session.run(`
                MATCH (e:Episode)-[:CONTAINS]->(p:Paragraph)
                WHERE datetime(e.publishedDate) > datetime() - duration($timeframe)
                    AND p.embedding IS NOT NULL
                WITH e, p,
                     reduce(dot = 0.0, i in range(0, size($embedding)-1) | 
                        dot + $embedding[i] * p.embedding[i]) as dotProduct,
                     sqrt(reduce(norm1 = 0.0, i in range(0, size($embedding)-1) | 
                        norm1 + $embedding[i] * $embedding[i])) as norm1,
                     sqrt(reduce(norm2 = 0.0, i in range(0, size(p.embedding)-1) | 
                        norm2 + p.embedding[i] * p.embedding[i])) as norm2
                WITH e, p, dotProduct/(norm1*norm2) as similarity
                WHERE similarity > 0.7
                WITH e, collect(p.text) as quotes, e.publishedDate as date
                ORDER BY date
                LIMIT 100
                RETURN e.title as episode,
                       date,
                       quotes,
                       size(quotes) as mention_count
            `, { embedding, timeframe });
    
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
                MATCH (e:Episode)-[:CONTAINS]->(p:Paragraph)
                WITH count(distinct e) as episodeCount,
                     count(p) as paragraphCount,
                     count(distinct e.creator) as creatorCount,
                     count(p.embedding) as embeddingCount
                RETURN episodeCount, paragraphCount, creatorCount, embeddingCount
            `);
            
            const record = stats.records[0];
            return {
                episodeCount: record.get('episodeCount').toNumber(),
                paragraphCount: record.get('paragraphCount').toNumber(),
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
            MATCH (p:Paragraph)
            WITH count(p) as total,
                 count(p.embedding) as withEmbedding
            RETURN total, withEmbedding
        `);
        
        const record = result.records[0];
        const total = record.get('total').toNumber();
        const withEmbedding = record.get('withEmbedding').toNumber();
        
        return {
            totalParagraphs: total,
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
