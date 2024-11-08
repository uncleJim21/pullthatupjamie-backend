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

        // Start the inference stream
        const prompt = `Please provide a comprehensive summary of the following search results about "${query}": ${JSON.stringify(searchResults)}`;
        
        const response = await axios({
            method: 'post',
            url: 'https://api.openai.com/v1/chat/completions',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            data: {
                model: 'gpt-4',
                messages: [{
                    role: 'user',
                    content: prompt
                }],
                stream: true
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