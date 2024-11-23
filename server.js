require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto')
const { SearxNGTool } = require('./agent-tools/searxngTool');
const mongoose = require('mongoose');
const {JamieFeedback} = require('./models/JamieFeedback.js');
const {JamieMetricLog, getDailyRequestCount} = require('./models/JamieMetricLog.js')

const mongoURI = process.env.MONGO_URI;

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });

const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", () => {
  console.log("Connected to MongoDB!");
});




const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Environment variables with defaults
const PORT = process.env.PORT || 3131;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gpt-3.5-turbo';

// Model configurations
const MODEL_CONFIGS = {
    'gpt-3.5-turbo': {
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      headers: (apiKey) => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }),
      formatData: (messages) => ({
        model: 'gpt-3.5-turbo',
        messages,
        stream: true,
        temperature: 0.0
      }),
      parseContent: (parsed) => ({
        content: parsed.choices[0].delta.content,
        done: false
      })
    },
    'claude-3-sonnet': {
      apiUrl: 'https://api.anthropic.com/v1/messages',
      headers: (apiKey) => ({
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }),
      formatData: (messages) => {
        // Format system message and user message for Claude
        const systemMessage = messages.find(m => m.role === 'system')?.content || '';
        const userMessage = messages.find(m => m.role === 'user')?.content || '';
        
        return {
          model: 'claude-3-sonnet-20240229',
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: `${systemMessage}\n\n${userMessage}`
          }],
          stream: true
        };
      },
      parseContent: (parsed) => ({
        content: parsed.delta?.text || '',
        done: parsed.type === 'message_stop'
      })
    }
  };

// Initialize SearxNG with error handling
let searxng = null;

// Fallback search function
const fallbackSearch = async (query) => {
  console.log('Using fallback search for query:', query);
  return [{
    title: 'Fallback Result',
    url: 'https://example.com',
    snippet: 'SearxNG is currently unavailable. This is a fallback result.'
  }];
};

// Buffer class for accumulating content
class ContentBuffer {
  constructor() {
    this.buffer = '';
    this.minSendLength = 50;  // Minimum characters to accumulate before sending
  }

  add(content) {
    if (!content) return null;
    this.buffer += content;
    
    if (this.buffer.length >= this.minSendLength) {
      const toSend = this.buffer;
      this.buffer = '';
      return toSend;
    }
    return null;
  }

  flush() {
    if (this.buffer.length > 0) {
      const toSend = this.buffer;
      this.buffer = '';
      return toSend;
    }
    return null;
  }
}

app.post('/api/stream-search', async (req, res) => {
  const { 
    query, 
    model = DEFAULT_MODEL,
    mode = 'default'
  } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  // Get credentials from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    // Decode credentials
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');

    if (!username || !password) {
      return res.status(401).json({ error: 'Invalid credentials format' });
    }

    let searchResults = [];
    try {
      // Create a new SearxNG instance for this request
      const searxng = new SearxNGTool({ username, password });
      searchResults = await searxng.search(query);
    } catch (searchError) {
      console.error('Search error:', searchError);
      searchResults = [{
        title: 'Search Error',
        url: 'https://example.com',
        snippet: 'SearxNG search failed. Using fallback result.'
      }];
    }

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Send search results
    res.write(`data: ${JSON.stringify({
      type: 'search',
      data: searchResults
    })}\n\n`);

    // Enhanced source formatting to include titles and snippets
    const formattedSources = searchResults.map((result, index) => {
      return `${index + 1}. ${result.title}
URL: ${result.url}
Content: ${result.snippet}
`;
    }).join('\n');

    // Prepare messages with mode-specific instructions
    let systemMessage = `You are a helpful research assistant that provides well-structured, markdown-formatted responses.`;
    
    if (mode === 'quick') {
      systemMessage += ` Provide brief, concise summaries focusing on the most important points.`;
    }
    
    systemMessage += ` Format your response as follows:
- Use clear, concise language
- Use proper markdown formatting
- Cite sources using [[n]](url) format, where n is the source number
- Citations must be inline within sentences
- Start with a brief overview
- Use bullet points for multiple items
- Bold key terms with **term**
- Maintain professional tone
- Do not say "according to sources" or similar phrases
- Use the provided title, URL, and content from each source to inform your response`;

    const userMessage = `Please analyze the following query and provide a ${mode === 'quick' ? 'brief ' : ''}response using the provided sources. Cite all claims using the [[n]](url) format.

Query: "${query}"

Sources for reference:
${formattedSources}

Remember to cite claims using [[n]](sourceURL) format, where n corresponds to the source number above.`;

    const modelConfig = MODEL_CONFIGS[model];
    console.log(`model:${model}`)
    const apiKey = model.startsWith('gpt') ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
    const contentBuffer = new ContentBuffer();
    
    const response = await axios({
      method: 'post',
      url: modelConfig.apiUrl,
      headers: modelConfig.headers(apiKey),
      data: modelConfig.formatData([
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
      ]),
      responseType: 'stream'
    });

    response.data.on('data', (chunk) => {
      try {
        const lines = chunk.toString().split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              const finalContent = contentBuffer.flush();
              if (finalContent) {
                res.write(`data: ${JSON.stringify({
                  type: 'inference',
                  data: finalContent
                })}\n\n`);
              }
              res.write(`data: [DONE]\n\n`);
              return;
            }
            
            try {
              if (data && data.trim() && data !== '[DONE]') {
                let parsed;
                try {
                  parsed = JSON.parse(data);
                } catch (parseError) {
                  console.error('Parsing error for chunk:', data);
                  console.error('Parse error details:', parseError);
                  continue;
                }
    
                let content;
                if (model.startsWith('gpt')) {
                  content = parsed.choices?.[0]?.delta?.content;
                } else {
                  content = parsed.delta?.text;
                }
    
                if (content) {
                  const bufferedContent = contentBuffer.add(content);
                  if (bufferedContent) {
                    res.write(`data: ${JSON.stringify({
                      type: 'inference',
                      data: bufferedContent
                    })}\n\n`);
                  }
                }
              }
            } catch (e) {
              console.error('Error processing data chunk:', {
                chunk: data.substring(0, 100),
                error: e.message,
                model: model,
                timestamp: new Date().toISOString()
              });
            }
          }
        }
      } catch (error) {
        console.error('Error processing chunk:', {
          error: error.message,
          chunk: chunk.toString().substring(0, 100),
          timestamp: new Date().toISOString()
        });
      }
    });
    
    response.data.on('error', (error) => {
      console.error('Stream error:', {
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
      
      try {
        res.write(`data: ${JSON.stringify({
          type: 'error',
          data: 'Stream processing error occurred'
        })}\n\n`);
      } catch (e) {
        console.error('Failed to send error to client:', e);
      }
      
      res.end();
    });

    response.data.on('end', async () => {
      try {
        // Create start and end of day timestamps
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
    
        await JamieMetricLog.findOneAndUpdate(
          {
            userId: username,
            timestamp: {
              $gte: startOfDay,
              $lte: endOfDay
            }
          },
          {
            $setOnInsert: {
              userId: username,
              timestamp: startOfDay,
              mode: mode,
            },
            $inc: { dailyRequestCount: 1 }
          },
          {
            upsert: true,
            new: true
          }
        );
      } catch (logError) {
        console.error('Error logging metrics:', logError);
      }
    
      const finalContent = contentBuffer.flush();
      if (finalContent) {
        res.write(`data: ${JSON.stringify({
          type: 'inference',
          data: finalContent
        })}\n\n`);
      }
      res.end();
    });

  } catch (error) {
    console.error('Streaming search error:', error);
    if (error.response?.data) {
      console.error('API Error Response:', error.response.data);
    }
    res.write(`data: ${JSON.stringify({
      type: 'error',
      data: error.message
    })}\n\n`);
    res.end();
  }
});

app.post('/api/feedback', async (req, res) => {
  const { email, feedback, timestamp, mode } = req.body;

  // console.log('Received feedback:', {
  //   email,
  //   feedback,
  //   timestamp,
  //   mode,
  //   receivedAt: new Date().toISOString()
  // });

  try {
    // Validate required fields
    if (!email || !feedback) {
      return res.status(400).json({
        error: 'Email and feedback are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Invalid email format'
      });
    }

    // Create new feedback document
    const newFeedback = new JamieFeedback({
      email,
      feedback,
      timestamp,
      mode,
      status: 'RECEIVED',
      state: 'NEW'
    });

    // Save to MongoDB
    await newFeedback.save();

    // Return success response
    res.status(200).json({
      message: 'Feedback received successfully',
    });

  } catch (error) {
    console.error('Error processing feedback:', error);
    res.status(500).json({
      error: 'Internal server error processing feedback'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    availableModels: Object.keys(MODEL_CONFIGS),
    searxngStatus: searxng ? 'connected' : 'disconnected'
  });
});

// Validate required environment variables
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is required');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Available models: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
});