// agent-tools/searxngTool.js
const fetch = require('node-fetch'); // Add this import

class SearxNGTool {
  constructor({ username, password }) {
    if (!username || !password) {
      throw new Error('Username and password are required');
    }
    this.authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  async search(query) {
    try {
      const response = await fetch('http://104.248.53.140/search', {
        method: 'POST',
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: new URLSearchParams({
          q: query,
          format: 'json'
        })
      });

      if (!response.ok) {
        throw new Error(`Search failed with status ${response.status}`);
      }

      const data = await response.json();
      return data.results || [];
    } catch (error) {
      console.error('SearxNG search error:', error);
      throw error;
    }
  }
}

module.exports = { SearxNGTool };