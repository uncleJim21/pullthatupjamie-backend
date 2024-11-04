// agent-tools/searxngTool.js
const axios = require('axios');
//const searXngUrl = 'http://localhost:5151';
const searXngUrl = 'https://opnxng.com/'

class SearxNGTool {
    constructor(baseUrl = searXngUrl) {
        this.baseUrl = baseUrl;
    }

    async search(query, options = {}) {
        try {
            const response = await axios.get(`${this.baseUrl}/search`, {
                params: {
                    q: query,
                    format: 'json',
                    ...options
                }
            });

            if (response.data.results) {
                return response.data.results.map(result => ({
                    title: result.title,
                    url: result.url,
                    snippet: result.content
                }));
            }
            return [];
        } catch (error) {
            throw new Error(`SearxNG search failed: ${error.message}`);
        }
    }

    async getTopHeadlines() {
        // Search for recent news
        const results = await this.search('news', {
            time_range: 'day',
            categories: 'news',
            language: 'en'
        });
        
        return results.slice(0, 5); // Return top 5 headlines
    }
}

module.exports = { SearxNGTool };