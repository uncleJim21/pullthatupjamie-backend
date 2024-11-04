require('web-streams-polyfill/polyfill');
const { OpenAI } = require('@langchain/openai');
const { OpenAIEmbeddings } = require('@langchain/openai');
const { ChatOpenAI } = require('@langchain/openai');
const { initializeAgentExecutorWithOptions } = require('langchain/agents');
const { DynamicTool } = require('langchain/tools');
const neo4jTools = require('./agent-tools/neo4jTools');
const {SearxNGTool} = require('./agent-tools/searxngTool')

class PodcastAnalysisAgent {
    constructor(openaiKey) {
        if (!openaiKey) {
            throw new Error('OpenAI API key is required');
        }

        this.embeddings = new OpenAIEmbeddings({
            openAIApiKey: openaiKey
        });

        this.model = new ChatOpenAI({
            openAIApiKey: openaiKey,
            modelName: 'gpt-4',
            temperature: 0.7
        });

        this.searxng = new SearxNGTool();
        this.tools = this.createTools();
        this.executor = null;
    }

    createTools() {
        return [
            new DynamicTool({
                name: "find_similar_discussions",
                description: "Find podcast discussions similar to a given topic",
                func: async (topic) => {
                    try {
                        const embedding = await this.embeddings.embedQuery(topic);
                        const results = await neo4jTools.findSimilarDiscussions({ embedding });
                        return results.map(r => 
                            `Episode: "${r.episode}" by ${r.creator} (${r.date})\nQuote: "${r.quote}"\nSimilarity: ${r.similarity}`
                        ).join('\n\n');
                    } catch (error) {
                        return `Error finding similar discussions: ${error.message}`;
                    }
                }
            }),
                        // new DynamicTool({
            //     name: "find_timeline_discussions",
            //     description: "Find how a topic has been discussed over time. Input format: 'topic, timeframe' (e.g., 'AI, 6 months')",
            //     func: async (input) => {
            //         try {
            //             const [topic, timeframe] = input.split(',').map(s => s.trim());
            //             const embedding = await this.embeddings.embedQuery(topic);
            //             const results = await neo4jTools.findTimelineDiscussions({ embedding, timeframe });
            //             // Format results into a descriptive string
            //             return results.map(r => 
            //                 `Episode: "${r.episode}" (${r.date})\nQuotes:\n${r.quotes.map(q => `- "${q}"`).join('\n')}\nMention count: ${r.mentionCount}`
            //             ).join('\n\n');
            //         } catch (error) {
            //             return `Error finding timeline discussions: ${error.message}`;
            //         }
            //     }
            // }),
            new DynamicTool({
                name: "get_database_stats",
                description: "Get statistics about the podcast database",
                func: async () => {
                    try {
                        const stats = await neo4jTools.getStats();
                        return `Database contains ${stats.episodeCount} episodes, ${stats.sentenceCount} sentences, and ${stats.creatorCount} unique creators.`;
                    } catch (error) {
                        return `Error getting database stats: ${error.message}`;
                    }
                }
            }),
            new DynamicTool({
                name: "search_news",
                description: "Search for recent news headlines and articles using SearxNG. You can specify topics or get general news.",
                func: async (query) => {
                    try {
                        const results = await this.searxng.search(query, {
                            time_range: 'day',
                            categories: 'news'
                        });
                        return JSON.stringify(results.slice(0, 5), null, 2);
                    } catch (error) {
                        return `Error searching news: ${error.message}`;
                    }
                }
            }),
            new DynamicTool({
                name: "get_top_headlines",
                description: "Get the current top news headlines from various sources",
                func: async () => {
                    try {
                        const headlines = await this.searxng.getTopHeadlines();
                        return JSON.stringify(headlines.map(h => ({
                            title: h.title,
                            summary: h.snippet
                        })), null, 2);
                    } catch (error) {
                        return `Error fetching headlines: ${error.message}`;
                    }
                }
            })
        ];
    }

    async initialize() {
        if (!this.executor) {
            this.executor = await initializeAgentExecutorWithOptions(
                this.tools,
                this.model,
                {
                    agentType: "zero-shot-react-description",
                    verbose: true,
                    maxIterations: 10,
                    returnIntermediateSteps: true
                }
            );
        }
        return this;
    }

    async findConceptualConnections(concept) {
        await this.initialize();
        return this.executor.call({
            input: `Analyze conceptual connections in podcast discussions about "${concept}". 
                   First find similar discussions, then analyze them for key insights and patterns.
                   Consider: common themes, different approaches, and unique perspectives.`
        });
    }

    // async analyzeTopicEvolution(topic, timeframe) {
    //     await this.initialize();
    //     return this.executor.call({
    //         input: `Analyze how discussions about "${topic}" have evolved over ${timeframe}. 
    //                First get timeline data, then analyze for trends and shifts in perspective.
    //                Consider: key turning points, emerging themes, and changing approaches.`
    //     });
    // }

    async getTopHeadlines() {
        await this.initialize();
        return this.executor.call({
            input: `Get the current top news headlines and provide a brief summary of each. 
                   Use the get_top_headlines tool to fetch the latest news, then organize and 
                   present the information in a clear, structured format.`
        });
    }

    async searchNews(query) {
        await this.initialize();
        return this.executor.call({
            input: `Search for recent news articles about "${query}" and provide a summary of the findings. 
                   Focus on credible sources and recent developments.`
        });
    }

    async validateDataAvailability() {
        return neo4jTools.getStats();
    }
}

module.exports = { PodcastAnalysisAgent };