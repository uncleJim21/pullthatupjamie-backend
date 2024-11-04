require('dotenv').config();
const axios = require('axios');
const { BatchPodcastProcessor } = require('./BatchPodcastProcessor');

async function main() {
    try {
        // const feedUrl = 'https://feeds.megaphone.fm/GLT1412515089'; //JRE
        // const feedId = 550168; //JRE
        // const feedUrl = 'https://feeds.npr.org/500005/podcast.xml';
        // const feedId = 55810;

        const feedUrl = 'https://api.substack.com/feed/podcast/9895.rss'; // thriller bitcoin
        const feedId = 3955537;//thriller bitcoin
        const EPISODES_TO_PROCESS = 10;
        
        const processor = new BatchPodcastProcessor({
            batchSize: 20,
            concurrentBatches: 2,
            neo4jBatchSize: 50
        });

        // Process feed metadata first
        console.log('Processing feed metadata...');
        const feedData = await processor.processFeed(feedUrl, feedId);
        console.log(`Feed processed: ${feedData.title}`);

        // Fetch episodes
        console.log('Fetching episodes...');
        const feedResponse = await axios.post('https://rss-extractor-app-yufbq.ondigitalocean.app/getFeed', {
            feedUrl,
            feedId,
            limit: EPISODES_TO_PROCESS
        });

        const episodes = feedResponse.data.episodes.episodes;
        console.log(`Processing ${episodes.length} episodes...`);

        // Process episodes in smaller batches
        const EPISODE_BATCH_SIZE = 2;
        const results = {
            successful: [],
            failed: []
        };

        for (let i = 0; i < episodes.length; i += EPISODE_BATCH_SIZE) {
            const batch = episodes.slice(i, i + EPISODE_BATCH_SIZE);
            console.log(`Processing batch ${Math.floor(i/EPISODE_BATCH_SIZE) + 1} of ${Math.ceil(episodes.length/EPISODE_BATCH_SIZE)}`);
            
            const batchResults = await Promise.all(batch.map(async episode => {
                try {
                    const result = await processor.processAudioUrl(episode.itemUrl, episode, feedId);
                    return {
                        episode: episode.itemTitle,
                        success: result.success,
                        details: result
                    };
                } catch (error) {
                    return {
                        episode: episode.itemTitle,
                        success: false,
                        error: error.message
                    };
                }
            }));

            // Sort results
            batchResults.forEach(result => {
                if (result.success) {
                    results.successful.push(result);
                } else {
                    results.failed.push(result);
                }
            });
        }

        // Summary
        console.log('\nProcessing Summary:');
        console.log(`Successfully processed: ${results.successful.length} episodes`);
        console.log(`Failed to process: ${results.failed.length} episodes`);
        
        if (results.failed.length > 0) {
            console.log('\nFailed Episodes:');
            results.failed.forEach(failure => {
                console.log(`- ${failure.episode}: ${failure.error || failure.details?.reason || 'Unknown error'}`);
            });
        }

        return results;
    } catch (error) {
        console.error('Main execution error:', error);
        throw error;
    }
}

// Execute with error handling
main()
.then(() => {
    console.log('Application completed successfully');
    process.exit(0);
})
.catch(error => {
    console.error('Application failed:', error);
    process.exit(1);
});