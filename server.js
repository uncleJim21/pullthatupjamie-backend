require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PodcastAnalysisAgent } = require('./PodcastAnalysisAgent');
const { Readable } = require('stream');
const { SearxNGTool } = require('./agent-tools/searxngTool');
const searxng = new SearxNGTool();
const axios = require('axios');


const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Environment variables with defaults
const PORT = process.env.PORT || 3131;
const DEFAULT_MAX_ITERATIONS = parseInt(process.env.DEFAULT_MAX_ITERATIONS) || 5;

// Initialize agent
const agent = new PodcastAnalysisAgent(process.env.OPENAI_API_KEY);

app.post('/api/stream-search', async (req, res) => {
  const { query } = req.body;

  if (!query) {
      return res.status(400).json({ error: 'Query is required' });
  }

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
      // Perform search
      const searchResults = await searxng.search(query);
      
      // Send search results immediately
      res.write(`data: ${JSON.stringify({
          type: 'search',
          data: searchResults
      })}\n\n`);

      // Format sources for reference
      const sourcesContext = searchResults.map((result, index) => 
          `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.snippet}\n`
      ).join('\n');

      // Prepare the system message
      const systemMessage = `You are a helpful research assistant that provides well-structured, markdown-formatted responses. Format your response as follows:
- Use clear, concise language
- Use proper markdown formatting
- Cite sources using [[n]](url) format, where n is the source number
- Citations must be inline within sentences
- Start with a brief overview
- Use bullet points for multiple items
- Bold key terms with **term**
- Maintain professional tone
- Do not say "according to sources" or similar phrases`;

      // Prepare the user message with both query and sources
      const userMessage = `Please analyze the following query and provide a comprehensive response using the provided sources. Cite all claims using the [[n]](url) format.

Query: "${query}"

Sources for reference (cite using [[n]](sourceURL) format):
${searchResults.map((result, index) => `${index + 1}. ${result.url}`).join('\n')}`;

      const response = await axios({
          method: 'post',
          url: 'https://api.openai.com/v1/chat/completions',
          headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          },
          data: {
              model: 'gpt-3.5-turbo',
              messages: [
                  {
                      role: 'system',
                      content: systemMessage
                  },
                  {
                      role: 'user',
                      content: userMessage
                  }
              ],
              stream: true,
              temperature: 0.0
          },
          responseType: 'stream'
      });

      response.data.on('data', (chunk) => {
          const lines = chunk.toString().split('\n');
          
          for (const line of lines) {
              if (line.startsWith('data: ')) {
                  const data = line.slice(6);
                  if (data === '[DONE]') {
                      res.write(`data: [DONE]\n\n`);
                      return;
                  }
                  
                  try {
                      const parsed = JSON.parse(data);
                      if (parsed.choices[0].delta.content) {
                          res.write(`data: ${JSON.stringify({
                              type: 'inference',
                              data: parsed.choices[0].delta.content
                          })}\n\n`);
                      }
                  } catch (e) {
                      console.error('Error parsing streaming response:', e);
                  }
              }
          }
      });

      response.data.on('end', () => {
          res.end();
      });

      response.data.on('error', (error) => {
          console.error('Stream error:', error);
          res.write(`data: ${JSON.stringify({
              type: 'error',
              data: error.message
          })}\n\n`);
          res.end();
      });

  } catch (error) {
      console.error('Streaming search error:', error);
      res.write(`data: ${JSON.stringify({
          type: 'error',
          data: error.message
      })}\n\n`);
      res.end();
  }
});

app.post('/api/search', async (req, res) => {
  try {
      const { query, maxIterations = process.env.DEFAULT_MAX_ITERATIONS || 5 } = req.body;
      
      if (!query) {
          return res.status(400).json({ error: 'Query is required' });
      }

      const initializedAgent = await agent.initialize();
      initializedAgent.executor.maxIterations = maxIterations;

      const result = await initializedAgent.searchAndAnalyze(query);

      res.json({
          query,
          result: result.output,
          intermediateSteps: result.intermediateSteps
      });
  } catch (error) {
      console.error('Search error:', error);
      res.status(500).json({ 
          error: 'Search failed', 
          message: error.message 
      });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString() 
  });
});

// Validate required environment variables
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Max iterations set to ${DEFAULT_MAX_ITERATIONS}`);
});