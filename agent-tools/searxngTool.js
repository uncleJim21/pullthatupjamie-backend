// agent-tools/searxngTool.js
const axios = require('axios');

class SearxNGTool {
    constructor(config = {
        baseUrl: 'http://104.248.53.140',
        username: 'cascdr',
        password: 'b895ef974e8c4814a65140bec30fbe60'
    }) {
        this.baseUrl = config.baseUrl;
        this.auth = {
            username: config.username,
            password: config.password
        };
    }

    async search(query, options = {}) {
        try {
            const response = await axios({
                method: 'get',
                url: `${this.baseUrl}/search`,
                params: {
                    q: query,
                    format: 'json',
                    ...options
                },
                auth: this.auth,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0'
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
        try {
            // Search for recent news
            const results = await this.search('news', {
                time_range: 'day',
                categories: 'news',
                language: 'en'
            });
            
            return results.slice(0, 5); // Return top 5 headlines
        } catch (error) {
            throw new Error(`Failed to get top headlines: ${error.message}`);
        }
    }
}

module.exports = { SearxNGTool };