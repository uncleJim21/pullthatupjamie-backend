require('dotenv').config();
const { PodcastAnalysisAgent } = require('./PodcastAnalysisAgent');

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

        // Check embedding status
        console.log('Checking embedding status...');
        const embeddingStats = await agent.validateEmbeddings();
        console.log(`\nEmbedding Statistics:
- Total sentences: ${embeddingStats.totalSentences}
- With embeddings: ${embeddingStats.withEmbeddings}
- Completion: ${embeddingStats.percentageComplete}\n`);

        if (embeddingStats.withEmbeddings === 0) {
            console.log('No embeddings found. Please process sentences with embeddings first.');
            return;
        }

        // Demo 1: Find conceptual connections
        // console.log('🔍 Demo 1: Finding conceptual connections about "political elections"...');
        // const connections = await agent.findConceptualConnections('political elections');
        // console.log('\nConceptual Connections Results:');
        // console.log(connections);
        // console.log('\n' + '-'.repeat(80) + '\n');

        // Demo 2: Analyze topic evolution
        // console.log('📈 Demo 2: Analyzing evolution of discussions about "artificial intelligence"...');
        // const evolution = await agent.analyzeTopicEvolution('artificial intelligence', '6 months');
        // console.log('📈 Demo 2: Analyzing evolution of discussions about "the 2024 election"...');
        // const evolution = await agent.analyzeTopicEvolution('the 2024 election', '6 months');
        // console.log('\nTopic Evolution Results:');
        // console.log(evolution);
        // console.log('\n' + '-'.repeat(80) + '\n');

        // Demo 3: Find contrasting viewpoints
        console.log('🔄 Demo 3: Finding conflicting viewpoints on "government regulation"...');
        const viewpoints = await agent.findConflictingViewpoints('government regulation');
        console.log('\nConflicting Viewpoints Results:');
        console.log(viewpoints);
        console.log('\n' + '-'.repeat(80) + '\n');

        // Demo 4: Identify expert network
        // console.log('👥 Demo 4: Identifying expert network on "climate change"...');
        // const experts = await agent.findExpertNetwork('climate change');
        console.log('👥 Demo 4: Identifying expert network on "health"...');
        const experts = await agent.findExpertNetwork('health');
        console.log('\nExpert Network Results:');
        console.log(experts);

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
            console.error('\nDemo failed:', error);
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