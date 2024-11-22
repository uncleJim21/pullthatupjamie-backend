require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto')
const { SearxNGTool } = require('./agent-tools/searxngTool');
const mongoose = require('mongoose');

const mongoURI = process.env.MONGO_URI;

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });

const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", () => {
  console.log("Connected to MongoDB!");
});

const JamieFeedbackSchema = new mongoose.Schema({
  email: String,
  feedback: String,
  timestamp: String,
  mode: String,
  status: String,
  state: String
});

const JamieFeedback = mongoose.model("JamieFeedback", JamieFeedbackSchema);


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
  const { query, model = DEFAULT_MODEL, mode = 'default', history = [] } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  if (!Array.isArray(history) || !history.every(msg => msg.role && msg.content)) {
    return res.status(400).json({ error: 'Invalid history format' });
  }

  console.log(`Received history: ${JSON.stringify(history, null, 2)}`);

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const contentBuffer = new ContentBuffer();

  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');
    if (!username || !password) {
      return res.status(401).json({ error: 'Invalid credentials format' });
    }

    // Perform SearxNG Search
    let searchResults = [];
    try {
      const searxng = new SearxNGTool({ username, password });
      searchResults = await searxng.search(query);
    } catch (searchError) {
      console.error('SearxNG search error:', JSON.stringify(searchError, null, 2));
      searchResults = [{
        title: 'Search Error',
        url: 'https://example.com',
        snippet: 'SearxNG search failed. Using fallback result.'
      }];
    }

    // Format sources with numbers
    const formattedSources = searchResults.map((result, index) => {
      const safeSnippet = result.snippet ? result.snippet : 'No snippet available';
      return `${index + 1}. **${result.title}**  
URL: [${result.url}](${result.url})  
Content: ${safeSnippet}`;
    }).join('\n\n');

    const systemMessage = `
You are a helpful assistant that provides well-structured, markdown-formatted responses. Cite sources inline using the [[n]](url) format. Format your response as follows:
Adhere to the following guidelines:
- Use clear, concise language
- Use proper markdown formatting
- Cite sources using [[n]](url) format, where n is the source number
- Citations must be inline within sentences
- Start with a brief overview
- Use bullet points for multiple items
- Bold key terms with **term**
- Maintain professional tone
- Do not say "according to sources" or similar phrases
- Do not say Analysis of "Query" as the title. Instead structure it as Overview, key points etc
- Use the provided title, URL, and content from each source to inform your response;
- Be context-aware by leveraging conversation history.`;

    const messages = [
      { role: 'system', content: systemMessage },
      ...history,
      { role: 'user', content: `Analyze the following query using the provided sources:\n\n${query}\n\nSources:\n${formattedSources}` }
    ];

    console.log(`GPT Messages: ${JSON.stringify(messages, null, 2)}`);

    // Immediately send SearxNG search results to the client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({
      type: 'search',
      data: searchResults
    })}\n\n`);

    const modelConfig = MODEL_CONFIGS[model];
    const apiKey = process.env.OPENAI_API_KEY;
    const requestData = modelConfig.formatData(messages);

    const response = await axios({
      method: 'post',
      url: modelConfig.apiUrl,
      headers: modelConfig.headers(apiKey),
      data: requestData,
      responseType: 'stream'
    });

    // Stream GPT response
    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      lines.forEach((line) => {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            const finalContent = contentBuffer.flush();
            if (finalContent) {
              res.write(`data: ${JSON.stringify({ type: 'inference', data: finalContent })}\n\n`);
            }
            res.write(`data: [DONE]\n\n`);
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || parsed.delta?.text;
            if (content) {
              const bufferedContent = contentBuffer.add(content);
              if (bufferedContent) {
                res.write(`data: ${JSON.stringify({ type: 'inference', data: bufferedContent })}\n\n`);
              }
            }
          } catch (error) {
            console.error('Error parsing GPT response:', JSON.stringify(error, null, 2));
          }
        }
      });
    });

    response.data.on('end', () => {
      const finalContent = contentBuffer.flush();
      if (finalContent) {
        res.write(`data: ${JSON.stringify({ type: 'inference', data: finalContent })}\n\n`);
      }
      res.end();
    });

    response.data.on('error', (error) => {
      console.error('Stream error:', JSON.stringify(error, null, 2));
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', data: 'Error occurred while streaming response' })}\n\n`);
      } catch (e) {
        console.error('Failed to send error to client:', e);
      }
      res.end();
    });
  } catch (error) {
    console.error('Streaming search error:', JSON.stringify(error, null, 2));
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', data: error.message })}\n\n`);
      } catch (writeError) {
        console.error('Failed to send error to client:', JSON.stringify(writeError, null, 2));
      }
    }
  }
});





app.post('/api/stream-search', async (req, res) => {
  const { query, model = DEFAULT_MODEL, mode = 'default', history = [] } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  // Validate message history format
  if (!Array.isArray(history) || !history.every(msg => msg.role && msg.content)) {
    return res.status(400).json({ error: 'Invalid history format' });
  }

  console.log(`Received history: ${JSON.stringify(history, null, 2)}`);

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');
    if (!username || !password) {
      return res.status(401).json({ error: 'Invalid credentials format' });
    }

    // Query SearxNG for the current request
    let searchResults = [];
    try {
      const searxng = new SearxNGTool({ username, password });
      searchResults = await searxng.search(query);
    } catch (searchError) {
      console.error('SearxNG search error:', JSON.stringify(searchError, null, 2));
      searchResults = [{
        title: 'Search Error',
        url: 'https://example.com',
        snippet: 'SearxNG search failed. Using fallback result.'
      }];
    }

    // Format sources for the assistant prompt
    const formattedSources = searchResults.map((result, index) => {
      return `${index + 1}. ${result.title}\nURL: ${result.url}\nContent: ${result.snippet}`;
    }).join('\n');

    // Prepare messages for GPT
    let systemMessage = `You are a helpful research assistant that provides well-structured, markdown-formatted responses.`;

    if (mode === 'quick') {
      systemMessage += ` Provide brief, concise summaries focusing on the most important points.`;
    }

    systemMessage += `
Format your response as follows:
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

Query: "${query}

In the scenario where the query is vague, heavily weight the results from the chat history to infer what is meant by the query in your response. Please stick to the above prescribed format regardless."

Sources for reference:
${formattedSources}

Remember to cite claims using [[n]](sourceURL) format, where n corresponds to the source number above.`;

    // Combine history with the current query
    const messages = [
      { role: 'system', content: systemMessage },
      ...history,
      { role: 'user', content: userMessage }
    ];

    console.log(`GPT Messages: ${JSON.stringify(messages, null, 2)}`);

    // Send messages to GPT
    const modelConfig = MODEL_CONFIGS[model];
    const apiKey = process.env.OPENAI_API_KEY;
    const requestData = modelConfig.formatData(messages);
    const contentBuffer = new ContentBuffer();

    const response = await axios({
      method: 'post',
      url: modelConfig.apiUrl,
      headers: modelConfig.headers(apiKey),
      data: requestData,
      responseType: 'stream'
    });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Stream GPT response
    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      lines.forEach((line) => {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            const finalContent = contentBuffer.flush();
            if (finalContent) {
              res.write(`data: ${JSON.stringify({ type: 'inference', data: finalContent })}\n\n`);
            }
            res.write(`data: [DONE]\n\n`);
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || parsed.delta?.text;
            if (content) {
              const bufferedContent = contentBuffer.add(content);
              if (bufferedContent) {
                res.write(`data: ${JSON.stringify({ type: 'inference', data: bufferedContent })}\n\n`);
              }
            }
          } catch (error) {
            console.error('Error parsing GPT response:', JSON.stringify(error, null, 2));
          }
        }
      });
    });

    response.data.on('end', () => {
      const finalContent = contentBuffer.flush();
      if (finalContent) {
        res.write(`data: ${JSON.stringify({ type: 'inference', data: finalContent })}\n\n`);
      }
      res.end();
    });

    response.data.on('error', (error) => {
      console.error('Stream error:', JSON.stringify(error, null, 2));
      res.write(`data: ${JSON.stringify({ type: 'error', data: 'Error occurred while streaming response' })}\n\n`);
      res.end();
    });
  } catch (error) {
    console.error('Streaming search error:', JSON.stringify(error, null, 2));
    res.write(`data: ${JSON.stringify({ type: 'error', data: error.message })}\n\n`);
    res.end();
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