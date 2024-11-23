require('dotenv').config();
const { PodcastAnalysisAgent } = require('./PodcastAnalysisAgent');
const neo4jTools = require('./agent-tools/neo4jTools');

const fs = require('fs');
const path = require('path');

function saveOutputToFile(output, jobType) {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
    const filename = `output-${jobType}-${timestamp}.txt`;
    const filepath = path.join(__dirname, filename);

    fs.writeFileSync(filepath, output, 'utf8');
    console.log(`Output saved to ${filepath}`);
}


async function runDemo() {
    console.log('Starting PodcastAnalysisAgent Demo...\n');
    
    const agent = new PodcastAnalysisAgent(process.env.OPENAI_API_KEY);
    
    try {
        // First validate data availability
        console.log('Checking data availability...');
        const stats = await agent.validateDataAvailability();
        console.log(`\nDatabase Statistics:
        - ${stats.episodeCount} episodes
        - ${stats.sentenceCount} sentences
        - ${stats.creatorCount} unique creators\n`);

        if (stats.episodeCount === 0 || stats.sentenceCount === 0) {
            console.log('No processed episodes found in the database.');
            console.log('Please run the batch processor first to populate the database.');
            return;
        }

        // Check embedding status using neo4jTools directly
        console.log('Checking embedding status...');
        const embeddingStats = await neo4jTools.validateEmbeddings();
        console.log(`\nEmbedding Statistics:
        - Total sentences: ${embeddingStats.totalSentences}
        - With embeddings: ${embeddingStats.withEmbeddings}
        - Completion: ${embeddingStats.percentageComplete}\n`);

        if (embeddingStats.withEmbeddings === 0) {
            console.log('No embeddings found. Please process sentences with embeddings first.');
            return;
        }

        // Initialize agent
        await agent.initialize();

        // Demo 1: Find conceptual connections
        // const topic = "bitcoiner's take on election outcome"
        // console.log(`🔍 Demo 1: Finding conceptual connections about "${topic}"...`);
        // const connections = await agent.findConceptualConnections(topic);
        // console.log('\nConceptual Connections Results:');
        // console.log(connections.output);
        // saveOutputToFile(connections.output, 'conceptual-connections');
        // console.log('\n' + '-'.repeat(80) + '\n');

        // Demo 2: Analyze topic evolution
        // console.log('📈 Demo 2: Analyzing evolution of discussions about "artificial intelligence"...');
        // const evolution = await agent.analyzeTopicEvolution('artificial intelligence', 'P6M');
        // console.log('\nTopic Evolution Results:');
        // console.log(evolution.output);
        // saveOutputToFile(evolution.output, 'topic-evolution');
        // console.log('\n' + '-'.repeat(80) + '\n');

        console.log('🔍 Fetching top headlines...');
        const headlines = await agent.getTopHeadlines();
        
        console.log('\nTop Headlines Results:');
        console.log(headlines.output);

        saveOutputToFile(headlines.output,"headlines")

    } catch (error) {
        if (error.code?.includes('Neo.ClientError')) {
            console.error('\nNeo4j Database Error:', {
                message: error.message,
                code: error.code,
                description: error.gqlStatusDescription || 'No additional details'
            });
        } else if (error.name === 'OpenAIError') {
            console.error('\nOpenAI API Error:', {
                message: error.message,
                type: error.type,
                status: error.status
            });
        } else {
            console.error('Demo failed:', error);
        }
    }
}

// Execute demo with timing information
async function executeDemo() {
    console.time('Demo Duration');
    
    try {
        await runDemo();
        console.log('\n✅ Demo completed successfully!');
    } catch (error) {
        console.error('\n❌ Demo failed:', error);
    } finally {
        console.timeEnd('Demo Duration');
    }
}

// Add handler for unhandled promise rejections
process.on('unhandledRejection', (error) => {
    console.error('Unhandled Promise Rejection:', error);
    process.exit(1);
});

// Run the demo
console.log('🚀 Starting PodcastAnalysisAgent Demonstration...\n');
executeDemo()
    .then(() => {
        console.log('\nDemo finished. You can modify the topics and parameters in demo.js to explore different aspects.');
        process.exit(0);
    })
    .catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });