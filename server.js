require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PodcastAnalysisAgent } = require('./PodcastAnalysisAgent');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Environment variables with defaults
const PORT = process.env.PORT || 3131;
const DEFAULT_MAX_ITERATIONS = parseInt(process.env.DEFAULT_MAX_ITERATIONS) || 5;

// Initialize agent
const agent = new PodcastAnalysisAgent(process.env.OPENAI_API_KEY);

app.post('/api/search', async (req, res) => {
  try {
    const { query, maxIterations = DEFAULT_MAX_ITERATIONS } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Initialize agent with custom iterations if provided
    const initializedAgent = await agent.initialize();
    initializedAgent.executor.maxIterations = maxIterations;

    // Perform AI search
    const result = await initializedAgent.searchNews(query);

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