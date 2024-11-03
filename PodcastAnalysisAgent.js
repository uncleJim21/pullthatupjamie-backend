require('dotenv').config();
const neo4jDriver = require('./mentionsNeo4jDriver');
const OpenAI = require('openai');

function parseTimeframeToDuration(timeframe) {
    const [amount, unit] = timeframe.split(" ");
    const parsedAmount = parseInt(amount, 10);

    if (unit.startsWith("month")) return `P${parsedAmount}M`;
    if (unit.startsWith("day")) return `P${parsedAmount}D`;
    if (unit.startsWith("year")) return `P${parsedAmount}Y`;

    throw new Error("Unsupported timeframe format");
}


class PodcastAnalysisAgent {
    constructor(openaiKey) {
        if (!openaiKey) {
            throw new Error('OpenAI API key is required');
        }
        
        this.openai = new OpenAI({
            apiKey: openaiKey
        });

        this.systemPrompt = `You are an analytical agent with access to a podcast knowledge graph.
Your goal is to find meaningful connections and insights across different podcast episodes,
understanding how ideas evolve and relate across conversations. When analyzing, consider:
- Direct topic connections
- Semantic similarities in discussions
- Contrasting viewpoints
- Evolution of ideas over time
- Network of speakers and their expertise`;
    }

    async validateDataAvailability() {
        const session = neo4jDriver.session();
        try {
            const stats = await session.run(`
                MATCH (e:Episode)-[:CONTAINS]->(s:Sentence)
                WITH count(distinct e) as episodeCount,
                     count(s) as sentenceCount,
                     count(distinct e.creator) as creatorCount
                RETURN episodeCount, sentenceCount, creatorCount
            `);
            
            const record = stats.records[0];
            return {
                episodeCount: record.get('episodeCount').toNumber(),
                sentenceCount: record.get('sentenceCount').toNumber(),
                creatorCount: record.get('creatorCount').toNumber()
            };
        } finally {
            await session.close();
        }
    }

    async validateEmbeddings() {
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
    }

    async findConceptualConnections(concept, limit = 5) {
        const session = neo4jDriver.session();
        try {
            const conceptEmbedding = await this.getEmbedding(concept);
            console.log("Limit value before query execution:", limit);
            const intLimit = parseInt(limit, 10)
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
                LIMIT ${intLimit}
            `, { 
                embedding: conceptEmbedding,
                limit: intLimit // Ensure limit is passed as an integer
            });
            
    
            const references = result.records.map(record => ({
                episode: record.get('episode'),
                creator: record.get('creator'),
                quote: record.get('quote'),
                date: record.get('date'),
                similarity: record.get('similarity')
            }));
    
            if (references.length === 0) {
                return `No discussions found about "${concept}". This could be because:
                1. The topic hasn't been discussed in the processed episodes
                2. The semantic search threshold might be too high
                3. The episodes haven't been properly processed`;
            }
    
            return await this.analyzeConnections(concept, references);
        } finally {
            await session.close();
        }
    }
    

    async analyzeTopicEvolution(topic, timeframe = '1 year') {
        const session = neo4jDriver.session();
        try {
            const embedding = await this.getEmbedding(topic);
            const duration = parseTimeframeToDuration(timeframe);
            const result = await session.run(`
                MATCH (e:Episode)-[:CONTAINS]->(s:Sentence)
                WHERE datetime(e.publishedDate) > datetime() - duration($duration)
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
            `, { 
                duration,
                embedding
            });

            const discussions = result.records.map(record => ({
                episode: record.get('episode'),
                date: record.get('date'),
                quotes: record.get('quotes'),
                mentionCount: record.get('mention_count')
            }));

            if (discussions.length === 0) {
                return `No discussions found about "${topic}" in the last ${timeframe}. Try:
                1. Expanding the time range
                2. Using different search terms
                3. Checking if episodes from this period have been processed`;
            }

            return await this.analyzeEvolution(topic, discussions);
        } finally {
            await session.close();
        }
    }

    async findConflictingViewpoints(topic) {
        const session = neo4jDriver.session();
        try {
            const embedding = await this.getEmbedding(topic);
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
                WITH e, s
                ORDER BY s.sentiment
                RETURN e.title as episode,
                       s.text as quote,
                       s.sentiment as sentiment
                LIMIT 10
            `, { embedding });

            const viewpoints = result.records.map(record => ({
                episode: record.get('episode'),
                quote: record.get('quote'),
                sentiment: record.get('sentiment')
            }));

            if (viewpoints.length === 0) {
                return `No contrasting viewpoints found about "${topic}". Try:
                1. Using different search terms
                2. Checking if sentiment analysis has been performed
                3. Verifying if this topic has been discussed`;
            }

            return await this.analyzeViewpoints(topic, viewpoints);
        } finally {
            await session.close();
        }
    }

    async findExpertNetwork(topic) {
        const session = neo4jDriver.session();
        try {
            const embedding = await this.getEmbedding(topic);
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
                WITH e, collect(s.text) as quotes, count(s) as reference_count
                WHERE reference_count > 2
                RETURN e.creator as creator,
                       reference_count,
                       quotes
                ORDER BY reference_count DESC
                LIMIT 5
            `, { embedding });

            const experts = result.records.map(record => ({
                creator: record.get('creator'),
                referenceCount: record.get('reference_count'),
                quotes: record.get('quotes')
            }));

            if (experts.length === 0) {
                return `No expert network found for "${topic}". Try:
                1. Using different search terms
                2. Checking if creator information is properly indexed
                3. Verifying if this topic has been discussed extensively`;
            }

            return await this.analyzeExperts(topic, experts);
        } finally {
            await session.close();
        }
    }

    async getEmbedding(text) {
        const response = await this.openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: text
        });
        return response.data[0].embedding;
    }

    async analyzeConnections(concept, references) {
        if (references.length === 0) return "No references found to analyze.";

        const prompt = `Analyze these podcast discussions about "${concept}":
${references.map(r => `
Episode: ${r.episode}
Creator: ${r.creator}
Quote: "${r.quote}"
Date: ${r.date}
Similarity: ${r.similarity}
`).join('\n')}

Identify key insights, patterns, and meaningful connections between these discussions.
Focus on:
1. Common themes and how they're approached differently
2. Evolution of ideas across episodes
3. Contrasting viewpoints
4. Notable insights or unique perspectives
`;

        const response = await this.openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: this.systemPrompt },
                { role: "user", content: prompt }
            ],
            temperature: 0.7
        });

        return response.choices[0].message.content;
    }

    async analyzeEvolution(topic, discussions) {
        if (discussions.length === 0) return "No discussions found to analyze.";

        const prompt = `Analyze how discussions about "${topic}" have evolved over time:
${discussions.map(d => `
Date: ${d.date}
Episode: ${d.episode}
Key quotes:
${d.quotes.map(q => `- "${q}"`).join('\n')}
`).join('\n')}

Identify:
1. How has the discussion evolved over time?
2. Key turning points or shifts in perspective
3. Emerging sub-themes or aspects
4. Changes in how the topic is framed or approached
`;

        const response = await this.openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: this.systemPrompt },
                { role: "user", content: prompt }
            ]
        });

        return response.choices[0].message.content;
    }

    async analyzeViewpoints(topic, viewpoints) {
        if (viewpoints.length === 0) return "No viewpoints found to analyze.";

        const prompt = `Analyze these different viewpoints on "${topic}":
${viewpoints.map(v => `
Episode: ${v.episode}
Quote: "${v.quote}"
Sentiment: ${v.sentiment}
`).join('\n')}

Identify:
1. Main points of disagreement
2. Underlying assumptions in different perspectives
3. Common ground between contrasting views
4. Quality of evidence/reasoning used
`;

        const response = await this.openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: this.systemPrompt },
                { role: "user", content: prompt }
            ]
        });

        return response.choices[0].message.content;
    }

    async analyzeExperts(topic, experts) {
        if (experts.length === 0) return "No expert discussions found to analyze.";

        const prompt = `Analyze these expert discussions about "${topic}":
${experts.map(e => `
Creator: ${e.creator}
Number of references: ${e.referenceCount}
Sample quotes:
${e.quotes.slice(0, 3).map(q => `- "${q}"`).join('\n')}
`).join('\n')}

Identify:
1. Key expertise and perspectives of each creator
2. Common themes in their discussions
3. How their views complement or contrast
4. Unique insights or approaches they bring
`;

        const response = await this.openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: this.systemPrompt },
                { role: "user", content: prompt }
            ]
        });

        return response.choices[0].message.content;
    }
}

module.exports = { PodcastAnalysisAgent };