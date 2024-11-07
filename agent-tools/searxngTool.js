// agent-tools/searxngTool.js
const axios = require('axios');

class SearxNGTool {
    constructor(config = {
        baseUrl: 'http://104.248.53.140',
        username: 'cascdr',
        password: 'b895ef974e8c4814a65140bec30fbe60',
        maxResults: 5,          // Limit number of results
        snippetMaxLength: 250   // Limit snippet length
    }) {
        this.baseUrl = config.baseUrl;
        this.auth = {
            username: config.username,
            password: config.password
        };
        this.maxResults = config.maxResults || 5;
        this.snippetMaxLength = config.snippetMaxLength || 250;
    }

    truncateSnippet(text) {
        if (!text) return '';
        if (text.length <= this.snippetMaxLength) return text;
        return text.substring(0, this.snippetMaxLength) + '...';
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
                // Sort by relevance (score) and take top results
                const sortedResults = response.data.results
                    .sort((a, b) => (b.score || 0) - (a.score || 0))
                    .slice(0, this.maxResults)
                    .map(result => ({
                        title: result.title,
                        url: result.url,
                        snippet: this.truncateSnippet(result.content)
                    }));

                return sortedResults;
            }
            return [];
        } catch (error) {
            throw new Error(`SearxNG search failed: ${error.message}`);
        }
    }

    async getTopHeadlines() {
        try {
            const results = await this.search('news', {
                time_range: 'day',
                categories: 'news',
                language: 'en'
            });
            
            return results.slice(0, this.maxResults);
        } catch (error) {
            throw new Error(`Failed to get top headlines: ${error.message}`);
        }
    }
}

module.exports = { SearxNGTool };