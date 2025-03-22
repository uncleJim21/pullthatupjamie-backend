require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { OpenAI } = require('openai');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})
const { SearxNGTool } = require('./agent-tools/searxngTool');
const {findSimilarDiscussions, getFeedsDetails, getClipById, getEpisodeByGuid, getParagraphWithEpisodeData, getFeedById, getParagraphWithFeedData, getTextForTimeRange} = require('./agent-tools/pineconeTools.js')
const mongoose = require('mongoose');
const {JamieFeedback} = require('./models/JamieFeedback.js');
const {generateInvoiceAlbyAPI,getIsInvoicePaid} = require('./utils/lightning-utils')
const { RateLimitedInvoiceGenerator } = require('./utils/rate-limited-invoice');
const invoiceGenerator = new RateLimitedInvoiceGenerator();
const { initializeInvoiceDB } = require('./utils/invoice-db');
const {initializeRequestsDB, checkFreeEligibility, freeRequestMiddleware} = require('./utils/requests-db')
const {squareRequestMiddleware, initializeJamieUserDB, upsertJamieUser} = require('./utils/jamie-user-db')
const DatabaseBackupManager = require('./utils/DatabaseBackupManager');
const path = require('path');
const {DEBUG_MODE, printLog} = require('./constants.js')
const ClipUtils = require('./utils/ClipUtils');
const { getPodcastFeed } = require('./utils/LandingPageService');
const {WorkProductV2, calculateLookupHash} = require('./models/WorkProductV2')
const ClipQueueManager = require('./utils/ClipQueueManager');
const FeedCacheManager = require('./utils/FeedCacheManager');
const jwt = require('jsonwebtoken');
const { ProPodcastDetails } = require('./models/ProPodcastDetails.js');
const {getProPodcastByAdminEmail} = require('./utils/ProPodcastUtils.js')
const podcastRunHistoryRoutes = require('./routes/podcastRunHistory');
const userPreferencesRoutes = require('./routes/userPreferences');
const { v4: uuidv4 } = require('uuid');
const DigitalOceanSpacesManager = require('./utils/DigitalOceanSpacesManager');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const debugRoutes = require('./routes/debugRoutes');

const mongoURI = process.env.MONGO_URI;
const invoicePoolSize = 1;

const processingCache = new Map();
const resultCache = new Map();

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });

const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", () => {
  console.log("Connected to MongoDB!");
});

const app = express();

// Middleware
app.use(cors());
app.enable('trust proxy');
app.set('trust proxy', true);
app.use(express.json());

// Environment variables with defaults
const PORT = process.env.PORT || 4131;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gpt-3.5-turbo';

const validateSpacesConfig = () => {
  const required = [
    'SPACES_ENDPOINT',
    'SPACES_ACCESS_KEY_ID',
    'SPACES_SECRET_ACCESS_KEY',
    'SPACES_BUCKET_NAME'
  ];

  console.log('Environment variables loaded:', {
    hasSpacesEndpoint: !!process.env.SPACES_ENDPOINT,
    hasAccessKeyId: !!process.env.SPACES_ACCESS_KEY_ID,
    hasSecretKey: !!process.env.SPACES_SECRET_ACCESS_KEY,
    hasBucketName: !!process.env.SPACES_BUCKET_NAME,
    hasClipBucket: !!process.env.SPACES_CLIP_BUCKET_NAME,
    hasClipAccessKey: !!process.env.SPACES_CLIP_ACCESS_KEY_ID,
    hasClipSecretKey: !!process.env.SPACES_CLIP_SECRET_KEY
  });
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
    return false;
  }
  
  // Also check if SPACES_CLIP related variables are available
  if (!process.env.SPACES_CLIP_BUCKET_NAME) {
    console.warn('SPACES_CLIP_BUCKET_NAME not defined, clip uploads may not work');
  }
  
  if (!process.env.SPACES_CLIP_ACCESS_KEY_ID || !process.env.SPACES_CLIP_SECRET_KEY) {
    console.warn('SPACES_CLIP_ACCESS_KEY_ID or SPACES_CLIP_SECRET_KEY not defined, using default credentials');
  }
  
  return true;
};

// Create spacesManager instance
let spacesManager = null;
let clipSpacesManager = null;

// Initialize spacesManager
if (validateSpacesConfig()) {
  try {
    spacesManager = new DigitalOceanSpacesManager(
      process.env.SPACES_ENDPOINT,
      process.env.SPACES_ACCESS_KEY_ID,
      process.env.SPACES_SECRET_ACCESS_KEY
    );
    console.log('Spaces manager initialized successfully');

    // Initialize clip spaces manager with clip-specific credentials if available
    const clipAccessKeyId = process.env.SPACES_CLIP_ACCESS_KEY_ID || process.env.SPACES_ACCESS_KEY_ID;
    const clipSecretKey = process.env.SPACES_CLIP_SECRET_KEY || process.env.SPACES_SECRET_ACCESS_KEY;
    
    clipSpacesManager = new DigitalOceanSpacesManager(
      process.env.SPACES_ENDPOINT,
      clipAccessKeyId,
      clipSecretKey
    );
    console.log('Clip spaces manager initialized successfully');
  } catch (error) {
    console.error('Error initializing spaces manager:', error);
  }
}

const dbBackupManager = new DatabaseBackupManager({
  spacesEndpoint: process.env.SPACES_ENDPOINT,
  accessKeyId: process.env.SPACES_ACCESS_KEY_ID,
  secretAccessKey: process.env.SPACES_SECRET_ACCESS_KEY,
  bucketName: process.env.SPACES_BUCKET_NAME,
  backupInterval: 1000 * 60 * 60 * 1 // 1 hour
});

const feedCacheManager = new FeedCacheManager({
  endpoint: process.env.SPACES_ENDPOINT,
  accessKeyId: process.env.SPACES_ACCESS_KEY_ID,
  secretAccessKey: process.env.SPACES_SECRET_ACCESS_KEY,
  bucketName: process.env.SPACES_BUCKET_NAME
});

const clipUtils = new ClipUtils();
const clipQueueManager = new ClipQueueManager({
  maxConcurrent: 2,
  maxQueueSize: 100
}, clipUtils);

//Validates user meets one of three requirements:
//1. Has valid BOLT11 invoice payment hash + preimage (proof that they paid)
//2. The user has a valid subscription through CASCDR's square payment gateway
//3. The user is eligible for free usage based on their IP address
const jamieAuthMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const route = req.path;

  console.log('[INFO] Checking Jamie authentication...');

  if (authHeader) {
      if (!authHeader.startsWith('Basic ')) {//checks for BOLT11 (1 above)
          const [preimage, paymentHash] = authHeader.split(':');
          if (!preimage || !paymentHash) {
              return res.status(401).json({
                  error: 'Authentication required: missing preimage or payment hash',
              });
          }

          // Validate the preimage
          const isValid = await getIsInvoicePaid(preimage, paymentHash);
          if (!isValid) {
              return res.status(401).json({
                  error: 'Invalid payment credentials',
              });
          }

          // Store validated credentials
          req.auth = { preimage, paymentHash };
          console.log('[INFO] Valid lightning payment credentials provided.');
          return next();
      }

      // Try subscription auth with square
      await squareRequestMiddleware(req, res, () => {//Checks if user has valid sub based on email provided in header
          // Only proceed to free middleware if Square auth didn't set isValidSquareAuth
          if (!req.auth?.isValidSquareAuth) {
              console.log('[INFO] Square auth failed, trying free tier');
              return freeRequestMiddleware(req, res, next);// If not check if the user requests from an IP eligible
          }
      });
      
      // If we got valid Square auth, we're done
      if (req.auth?.isValidSquareAuth) {
          return next();
      }
  } else {
      // No auth header, fallback to free request middleware
      console.log('[INFO] No authentication provided. Falling back to free eligibility.');
      return freeRequestMiddleware(req, res, next);
  }
};

// Middleware to verify podcast admin privileges
const verifyPodcastAdminMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Extract token
    const token = authHeader.substring(7);
    
    // Verify JWT token
    const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
    
    // Fetch podcast details for this admin
    const proPod = await getProPodcastByAdminEmail(decoded.email);
    
    if (!proPod || !proPod.feedId) {
      return res.status(403).json({ 
        error: 'Unauthorized. You are not registered as a podcast admin.' 
      });
    }
    
    // Store feedId and admin email in request object for later use
    req.podcastAdmin = {
      email: decoded.email,
      feedId: proPod.feedId
    };
    
    next();
  } catch (error) {
    console.error('Podcast admin verification error:', error.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

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


app.get('/api/get-available-feeds', async (req, res) => {
  try {
      console.log('Fetching available feeds from cache');
      const results = await feedCacheManager.getFeeds();
      
      // Ensure we have results before sending response
      if (!Array.isArray(results)) {
          throw new Error('Invalid feed data format');
      }

      // Send response with results
      res.json({ 
          results, 
          count: results.length,
          cacheTime: feedCacheManager.lastUpdateTime
      });
  } catch (error) {
      console.error('Error fetching available feeds:', error);
      // Send proper error response
      res.status(500).json({ 
          error: 'Failed to fetch available feeds',
          details: error.message 
      });
  }
});


app.post('/api/validate-privs', async (req, res) => {
  const { token } = req.body;

  if (!token) {
      return res.status(400).json({ error: 'Token is required' });
  }

  try {
      const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
      console.log(`Authenticated email: ${decoded.email}`);
      const proPod = await getProPodcastByAdminEmail(decoded.email);
      console.log(`found proPod:${JSON.stringify(proPod,null,2)}`)
      let privs = {}
      if(proPod && proPod.feedId){
        privs = {feedId:proPod.feedId,access:"admin"}
      }
      return res.json({ privs});
  } catch (error) {
      console.error('JWT validation error:', error.message);
      return res.status(401).json({ error: 'Invalid or expired token' });
  }
});

///Clips related

app.post('/api/make-clip', jamieAuthMiddleware, async (req, res) => {
  const { clipId, timestamps } = req.body;

  if (!clipId) {
      return res.status(400).json({ error: 'clipId is required' });
  }

  const clipData = await getClipById(clipId);
  if (!clipData) {
      return res.status(404).json({ error: 'Clip not found', clipId });
  }

  try {
      // Calculate lookup hash ONCE, at the beginning
      const lookupHash = calculateLookupHash(clipData, timestamps);

      // Check if this exists already
      const existingClip = await WorkProductV2.findOne({ lookupHash });
      if (existingClip) {
          if (existingClip.cdnFileId) {
              return res.status(200).json({
                  status: 'completed',
                  lookupHash,
                  url: existingClip.cdnFileId
              });
          }
          return res.status(202).json({
              status: 'processing',
              lookupHash,
              pollUrl: `/api/clip-status/${lookupHash}`
          });
      }

      // Extract just the essential identifiers
      const guid = clipData.additionalFields?.guid || 
                  (clipData.shareLink && clipData.shareLink.includes('_p') ? 
                   clipData.shareLink.split('_p')[0] : null);
      
      const feedId = clipData.additionalFields?.feedId || null;
      
      // Get the start and end times
      const timeStart = timestamps ? timestamps[0] : clipData.timeContext?.start_time;
      const timeEnd = timestamps ? timestamps[1] : clipData.timeContext?.end_time;
      
      // Get the accurate text for the time range
      let clipText = clipData.quote || "";
      
      if (guid && timeStart !== undefined && timeEnd !== undefined) {
          const accurateText = await getTextForTimeRange(guid, timeStart, timeEnd);
          if (accurateText) {
              clipText = accurateText;
          }
      }
      
      // Prepare the minimal result object with just the essential data
      const resultData = {
          resultSchemaVersion: 2025321,
          feedId: feedId,
          guid: guid,
          shareLink: clipData.shareLink,
          clipText: clipText,
          timeStart: timeStart,
          timeEnd: timeEnd,
      };

      // Create initial record with the minimal result data
      await WorkProductV2.create({
          type: 'ptuj-clip',
          lookupHash,
          status: 'queued',
          cdnFileId: null,
          result: resultData
      });

      // Queue the job WITHOUT awaiting
      clipQueueManager.enqueueClip(clipData, timestamps, lookupHash).catch(err => {
          console.error('Error queuing clip:', err);
          // Update DB with error status if queue fails
          WorkProductV2.findOneAndUpdate(
              { lookupHash },
              { status: 'failed', error: err.message }
          ).catch(console.error);
      });

      // Return immediately
      return res.status(202).json({
          status: 'processing',
          lookupHash,
          pollUrl: `/api/clip-status/${lookupHash}`
      });

  } catch (error) {
      console.error('Error in make-clip:', error);
      return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/clip-queue-status/:lookupHash', async (req, res) => {
  const { lookupHash } = req.params;
  const estimatedWait = await clipQueueManager.getEstimatedWaitTime(lookupHash);
  res.json({ estimatedWait });
});

// Status check endpoint
app.get('/api/clip-status/:lookupHash', async (req, res) => {
  const { lookupHash } = req.params;

  try {
      const clip = await WorkProductV2.findOne({ lookupHash });

      if (!clip) {
          return res.status(404).json({ status: 'not_found' });
      }

      if (clip.cdnFileId) {
          return res.json({
              status: 'completed',
              url: clip.cdnFileId
          });
      }

      // Get queue position if still processing
      const queueStatus = await clipQueueManager.getEstimatedWaitTime(lookupHash);
      
      return res.json({
          status: clip.status || 'processing',
          queuePosition: queueStatus,
          lookupHash
      });

  } catch (error) {
      console.error('Error checking clip status:', error);
      return res.status(500).json({ error: 'Internal server error' });
  }
});

async function processClip(clip, timestamps) {
  try {
    console.log(`Processing clip with clipId:${clip.shareLink}`);
    
    // If timestamps provided, update clip time context
    if (timestamps?.length >= 2) {
      clip.timeContext = {
        start_time: timestamps[0],
        end_time: timestamps[1]
      };
    }

    const videoUrl = await clipUtils.processClip(clip,timestamps);
    return videoUrl;
  } catch (error) {
    console.error('Error in processClip:', error);
    throw error;
  }
}

app.get('/api/clip/:id', async (req, res) => {
  try {
      const clipId = req.params.id;
      console.log('Fetching clip:', clipId);
      
      const clip = await getClipById(clipId);
      
      if (!clip) {
          console.log('Clip not found:', clipId);
          return res.status(404).json({ 
              error: 'Clip not found',
              clipId 
          });
      }

      res.json({ clip });
  } catch (error) {
      console.error('Error fetching clip:', error);
      res.status(500).json({ 
          error: 'Failed to fetch clip',
          details: error.message,
          clipId: req.params.id
      });
  }
});


app.get('/api/render-clip/:lookupHash', async (req, res) => {
  const { lookupHash } = req.params;

  try {
    // Find the clip in WorkProductV2
    const clip = await WorkProductV2.findOne({ lookupHash });

    if (!clip) {
      return res.status(404).json({ 
        error: 'Clip not found',
        lookupHash 
      });
    }

    // If clip is not yet processed
    if (!clip.cdnFileId) {
      return res.status(202).json({
        status: 'processing',
        message: 'Clip is still being processed',
        lookupHash
      });
    }

    console.log(`Rendering clip: ${JSON.stringify(clip, null, 2)}`);

    // Set content type for HTML
    res.setHeader('Content-Type', 'text/html');

    // Extract preview image if available
    const previewImage = clip.result?.previewImageId || clip.cdnFileId.replace('.mp4', '-preview.png');

    // Return HTML with embedded video player optimized for TikTok-style viewing
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
          
          <meta name="twitter:card" content="player">
          <meta name="twitter:title" content="Trending Video Clip">
          <meta name="twitter:description" content="Watch this short clip now!">
          <meta name="twitter:player" content="${clip.cdnFileId}">
          <meta name="twitter:player:width" content="720">
          <meta name="twitter:player:height" content="1280">
          <meta name="twitter:image" content="${previewImage}">
          
          <meta property="og:title" content="Trending Video Clip">
          <meta property="og:description" content="Watch this short video now!">
          <meta property="og:image" content="${previewImage}">
          <meta property="og:video" content="${clip.cdnFileId}">
          <meta property="og:video:type" content="video/mp4">
          <meta property="og:video:width" content="720">
          <meta property="og:video:height" content="1280">
          
          <style>
            body, html {
              margin: 0;
              padding: 0;
              width: 100%;
              height: 100%;
              background: black;
              display: flex;
              align-items: center;
              justify-content: center;
              overflow: hidden;
              font-family: Arial, sans-serif;
            }
            .video-wrapper {
              position: relative;
              width: 100vw;
              height: 100vh;
              display: flex;
              justify-content: center;
              align-items: center;
              overflow: hidden;
            }
            .background {
              position: absolute;
              width: 100%;
              height: 100%;
              background: url('${previewImage}') center center / cover no-repeat;
              filter: blur(20px) brightness(0.5);
              z-index: 1;
            }
            .video-container {
              position: relative;
              z-index: 2;
              width: 90%;
              max-width: 450px;
              height: auto;
              border-radius: 12px;
              overflow: hidden;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            }
            video {
              width: 100%;
              height: auto;
              border-radius: 12px;
              object-fit: cover;
            }
          </style>
        </head>
        <body>
          <div class="video-wrapper">
            <div class="background"></div>
            <div class="video-container">
              <video controls playsinline autoplay loop muted>
                <source src="${clip.cdnFileId}" type="video/mp4">
                Your browser does not support the video tag.
              </video>
            </div>
          </div>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('Error rendering clip:', error);
    res.status(500).json({ 
      error: 'Failed to render clip',
      details: error.message 
    });
  }
});



///Podcast Search

// Add this endpoint to your Express server (server.js/index.js)

app.get('/api/podcast-feed/:feedId', async (req, res) => {
  const { feedId } = req.params;
  console.log(`Fetching podcast feed for ID: ${feedId}`);
  
  try {
    const response = await getPodcastFeed(feedId);
    
    // Add cache headers
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(response);
  } catch (error) {
    console.error('Error fetching podcast feed:', error);
    const statusCode = error.message === 'Feed not found' ? 404 : 500;
    res.status(statusCode).json({ 
      error: error.message || 'Failed to fetch podcast feed'
    });
  }
});

app.post('/api/search-quotes', async (req, res) => {
  let { query,feedIds=[], limit = 5 } = req.body;
  limit = Math.floor((process.env.MAX_PODCAST_SEARCH_RESULTS ? process.env.MAX_PODCAST_SEARCH_RESULTS : 50, limit))
  printLog(`/api/search-quotes req:`,req)

  try {
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: query
    });
    
    const embedding = embeddingResponse.data[0].embedding;

    // Search for similar discussions using the embedding
    const similarDiscussions = await findSimilarDiscussions({
      embedding,
      feedIds,
      limit,
      query
    });

    // Format and return the results
    printLog(`---------------------------`)
    printLog(`results:${JSON.stringify(similarDiscussions,null,2)}`)
    printLog(`~~~~~~~~~~~~~~~~~~~~~~~~~~~`)
    const results = similarDiscussions.map(discussion => ({
      shareUrl: discussion.shareUrl,
      shareLink:discussion.shareLink,
      quote: discussion.quote,
      episode: discussion.episode,
      creator: discussion.creator,
      audioUrl: discussion.audioUrl,
      episodeImage: discussion.episodeImage,
      listenLink: discussion.listenLink,
      date: discussion.date,
      similarity: {
          combined: discussion.similarity.combined,
          vector: discussion.similarity.vector
      },
      timeContext: discussion.timeContext
  }));

    res.json({
      query,
      results,
      total: results.length,
      model: "text-embedding-ada-002" // Include model info for reference
    });

  } catch (error) {
    console.error('Search quotes error:', error);
    res.status(500).json({ 
      error: 'Failed to search quotes',
      details: error.message 
    });
  }
});

app.post('/api/stream-search', jamieAuthMiddleware, async (req, res) => {
  const { query, model = DEFAULT_MODEL, mode = 'default' } = req.body;
 
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }
 
  try {
    let searchResults = [];
    const { email, preimage, paymentHash } = req.auth || {};
 
    try {
      // Create a new SearxNG instance
      const searxngConfig = {
        username: process.env.ANON_AUTH_USERNAME,
        password: process.env.ANON_AUTH_PW
      };
 
      const searxng = new SearxNGTool(searxngConfig);
      searchResults = (await searxng.search(query)).slice(0, 10);
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
 
    // Prepare formatted sources
    const formattedSources = searchResults.map((result, index) => {
      return `${index + 1}. ${result.title}\nURL: ${result.url}\nContent: ${result.snippet}\n`;
    }).join('\n');
 
    // Construct messages for LLM
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
    - Pay very close attention to numerical figures given. Be certain to not misinterpret those. Simply write those exactly as written.
    - Use the provided title, URL, and content from each source to inform your response`;
    const userMessage = `Query: "${query}"\n\nSources:\n${formattedSources}`;
 
    const modelConfig = MODEL_CONFIGS[model];
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
      const lines = chunk.toString().split('\n');
      lines.forEach((line) => {
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
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
    
          try {
            const parsed = JSON.parse(data);
            let content;
            
            if (model.startsWith('gpt')) {
              content = parsed.choices?.[0]?.delta?.content;
            } else {
              // Handle Claude format
              if (parsed.type === 'content_block_start') {
                return; // Skip content block start messages
              }
              if (parsed.type === 'content_block_stop') {
                return; // Skip content block stop messages
              }
              if (parsed.type === 'ping') {
                return; // Skip ping messages
              }
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
          } catch (e) {
            if (e instanceof SyntaxError) {
              console.error('JSON Parse Error:', {
                data: data.substring(0, 100),
                error: e.message
              });
              return; // Skip malformed JSON
            }
            throw e;
          }
        }
      });
    });
 
    response.data.on('end', () => {
      const finalContent = contentBuffer.flush();
      if (finalContent) {
        res.write(`data: ${JSON.stringify({
          type: 'inference',
          data: finalContent
        })}\n\n`);
      }
      res.end();
    });
 
    response.data.on('error', (error) => {
      console.error('Stream error:', error);
      res.write(`data: ${JSON.stringify({
        type: 'error',
        data: 'Stream processing error occurred'
      })}\n\n`);
      res.end();
    });
  } catch (error) {
    console.error('Streaming search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
 });

//check if the user is eligible for free usage based on IP address
app.get('/api/check-free-eligibility', checkFreeEligibility);



//get a pool of BOLT11 invoices to store in the client and use for auth as needed
app.get('/invoice-pool', async (req, res) => {
  try {
    const invoices = await invoiceGenerator.generateInvoicePool(
      invoicePoolSize,
      generateInvoiceAlbyAPI
    );

    if (invoices.length === 0) {
      return res.status(503).json({ 
        error: 'Failed to generate any invoices, please try again later' 
      });
    }

    // Return whatever invoices we managed to generate
    res.status(200).json({ 
      invoices,
      poolSize: invoices.length 
    });
  } catch (error) {
    console.error('Error generating invoice pool:', error);
    res.status(500).json({ error: 'Failed to generate invoices' });
  }
});

//Syncs remote auth server with this server for future request validation
app.post('/register-sub', async (req, res) => {
  try {
      const { email, token } = req.body;
      
      if (!email || !token) {
          return res.status(400).json({ error: 'Email and token are required' });
      }

      // First validate with auth server using axios
      const authResponse = await axios.get(`${process.env.CASCDR_AUTH_SERVER_URL}/validate-subscription`, {
          headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
          }
      });

      const authData = authResponse.data;

      if (!authData.subscriptionValid) {
          return res.status(403).json({ error: 'Subscription not active' });
      }

      // If validated, register/update user in jamie-users db
      await upsertJamieUser(email, 'active');

      console.log(`[INFO] Registered subscription for validated email: ${email}`);
      res.status(201).json({ 
          message: 'Subscription registered successfully',
          email 
      });
  } catch (error) {
      console.error('[ERROR] Failed to register subscription:', error);
      if (error.response) {
          // Error response from auth server
          return res.status(error.response.status).json({ 
              error: 'Auth server validation failed',
              details: error.response.data
          });
      }
      res.status(500).json({ error: 'Failed to register subscription' });
  }
});


//collects data from user submitted feedback form
app.post('/api/feedback', async (req, res) => {
  const { email, feedback, timestamp, mode } = req.body;
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

// Helper function for sanitizing file names
function sanitizeFileName(fileName) {
  // First, strip any path information by extracting just the file name
  const fileNameOnly = fileName.split('/').pop().split('\\').pop();
  
  // Remove path traversal characters and potentially harmful characters
  const sanitized = fileNameOnly
    .replace(/\.\.\//g, '') // Remove path traversal
    .replace(/[/\\]/g, '_') // Replace slashes with underscores
    .replace(/[^a-zA-Z0-9._-]/g, '_') // Replace other special characters
    .trim();
  
  // Ensure the file name isn't empty after sanitization
  return sanitized || 'unnamed_file';
}

app.post("/api/generate-presigned-url", verifyPodcastAdminMiddleware, async (req, res) => {
  const { fileName, fileType, acl = 'public-read' } = req.body;

  if (!fileName || !fileType) {
    return res.status(400).json({ error: "File name and type are required" });
  }

  // Validate allowed file types
  const allowedFileTypes = [
    // Audio formats
    'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm',
    // Image formats
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    // Video formats
    'video/mp4', 'video/webm', 'video/ogg',
    // Documents
    'application/pdf'
  ];

  if (!allowedFileTypes.includes(fileType)) {
    return res.status(400).json({ 
      error: "File type not allowed",
      allowedTypes: allowedFileTypes
    });
  }

  try {
    // Check if clipSpacesManager is initialized
    if (!clipSpacesManager) {
      return res.status(503).json({ error: "Clip storage service not available" });
    }
    
    // Get the clip bucket name from environment variable - same as used in ClipUtils
    const bucketName = process.env.SPACES_CLIP_BUCKET_NAME;
    if (!bucketName) {
      return res.status(503).json({ error: "Clip bucket not configured" });
    }
    
    // Use feedId from verified podcast admin
    const { feedId } = req.podcastAdmin;
    
    // Generate a safe path using the feedId and a timestamp to ensure uniqueness
    const timestamp = new Date().getTime();
    
    // Use the same path structure that works for ClipUtils
    const key = `jamie-pro/${feedId}/uploads/${timestamp}-${sanitizeFileName(fileName)}`;
    const expiresIn = 3600; // URL validity in seconds (1 hour)
    
    // Set max file size based on file type (100MB for audio/video, 10MB for images, 5MB for docs)
    let maxSizeBytes = 100 * 1024 * 1024; // Default to 100MB
    
    if (fileType.startsWith('image/')) {
      maxSizeBytes = 10 * 1024 * 1024; // 10MB for images
    } else if (fileType === 'application/pdf') {
      maxSizeBytes = 5 * 1024 * 1024; // 5MB for PDFs
    }

    // Generate pre-signed URL using the clip-specific spaces manager
    const uploadUrl = await clipSpacesManager.generatePresignedUploadUrl(
      bucketName, 
      key, 
      fileType, 
      expiresIn,
      maxSizeBytes,
      acl
    );

    console.log(`Generated pre-signed URL for ${bucketName}/${key}`);

    res.json({ 
      uploadUrl, 
      key,
      feedId,
      publicUrl: `https://${bucketName}.${process.env.SPACES_ENDPOINT}/${key}`,
      maxSizeBytes,
      maxSizeMB: Math.round(maxSizeBytes / (1024 * 1024))
    });
  } catch (error) {
    console.error("Error generating pre-signed URL:", error);
    res.status(500).json({ error: "Could not generate pre-signed URL" });
  }
});

app.get("/api/list-uploads", verifyPodcastAdminMiddleware, async (req, res) => {
  try {
    // Check if clipSpacesManager is initialized
    if (!clipSpacesManager) {
      return res.status(503).json({ error: "Clip storage service not available" });
    }
    
    // Get the clip bucket name from environment variable - same as used in ClipUtils
    const bucketName = process.env.SPACES_CLIP_BUCKET_NAME;
    if (!bucketName) {
      return res.status(503).json({ error: "Clip bucket not configured" });
    }
    
    // Use feedId from verified podcast admin
    const { feedId } = req.podcastAdmin;
    
    // Define the prefix for this podcast admin's uploads
    const prefix = `jamie-pro/${feedId}/uploads/`;
    
    // Parse pagination parameters
    const pageSize = 50; // Fixed page size of 50 items
    const page = parseInt(req.query.page) || 1; // Default to page 1 if not specified
    
    if (page < 1) {
      return res.status(400).json({ error: "Page number must be 1 or greater" });
    }
    
    // Create a new S3 client for this operation
    const client = clipSpacesManager.createClient();
    
    // Set up pagination parameters for S3 listing
    let continuationToken = null;
    let allContents = [];
    let hasMoreItems = true;
    let totalCount = 0;
    let directoryCount = 0; // Track total number of directories across all pages
    
    // If we're requesting a page other than the first, we need to fetch all previous pages
    // to get the correct continuation token
    // It's not ideal, but S3 doesn't support direct offset pagination
    let currentPage = 1;
    
    while (hasMoreItems && currentPage <= page) {
      const listParams = {
        Bucket: bucketName,
        Prefix: prefix,
        MaxKeys: pageSize
      };
      
      // Add the continuation token if we have one from a previous request
      if (continuationToken) {
        listParams.ContinuationToken = continuationToken;
      }
      
      // Execute the command
      const command = new ListObjectsV2Command(listParams);
      const response = await client.send(command);
      
      // Count directories in this response
      const directoriesInThisPage = (response.Contents || []).filter(item => item.Key.endsWith('/')).length;
      directoryCount += directoriesInThisPage;
      
      // Update total count (including directories for now)
      totalCount += response.Contents?.length || 0;
      
      // If this is the page we want, store the contents
      if (currentPage === page) {
        allContents = response.Contents || [];
      }
      
      // Check if there are more items to fetch
      hasMoreItems = response.IsTruncated;
      
      // Update the continuation token for the next request
      continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
      
      // Move to the next page
      currentPage++;
    }
    
    // Process the results to make them more user-friendly
    const uploads = allContents
      .filter(item => !item.Key.endsWith('/')) // Filter out directory entries
      .map(item => {
        // Extract just the filename from the full path
        const fileName = item.Key.replace(prefix, '');
        
        return {
          key: item.Key,
          fileName: fileName,
          size: item.Size,
          lastModified: item.LastModified,
          publicUrl: `https://${bucketName}.${process.env.SPACES_ENDPOINT}/${item.Key}`
        };
      });
    
    // Calculate pagination metadata
    const hasNextPage = hasMoreItems;
    const hasPreviousPage = page > 1;
    
    // Calculate the real total count by subtracting all directories
    const realTotalCount = totalCount - directoryCount;
    
    // Return the list of uploads with pagination metadata
    res.json({
      uploads,
      pagination: {
        page,
        pageSize,
        hasNextPage,
        hasPreviousPage,
        totalCount: realTotalCount
      },
      feedId
    });
    
  } catch (error) {
    console.error("Error listing uploads:", error);
    res.status(500).json({ 
      error: "Failed to list uploads", 
      details: error.message 
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

process.on('uncaughtException', (err) => {
  console.error("🔥 Uncaught Exception:", err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error("🚨 Unhandled Promise Rejection:", reason);
});

app.use('/api/podcast-runs', podcastRunHistoryRoutes);
app.use('/api/user-prefs', userPreferencesRoutes);

// Only enable debug routes in debug mode
if (DEBUG_MODE) {
  console.log('🔍 Debug mode enabled - Debug routes are accessible');
  app.use('/api/debug', debugRoutes);
}

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DEBUG_MODE:`, process.env.DEBUG_MODE === 'true')
  console.log(`Available models: ${Object.keys(MODEL_CONFIGS).join(', ')}`);

  //Initialize local dbs for speedy auth
  try {
    if (!validateSpacesConfig()) {
      console.warn('Database backup system disabled due to missing configuration');
    } else {
      
      if(!DEBUG_MODE){
        await dbBackupManager.initialize();
        console.log('Database backup system initialized successfully');
      }
    }
    
    // Initialize databases
    await initializeInvoiceDB();
    await initializeRequestsDB();
    await initializeJamieUserDB();
    await feedCacheManager.initialize();
    console.log('Feed cache manager initialized successfully');
    
    console.log('All systems initialized successfully');
  } catch (error) {
    console.error('Error during initialization:', error);
    // Don't exit the process, just log the error and continue without backups
    console.warn('Continuing without backup system...');
  }
});

// Add this new endpoint for testing episode retrieval
app.get('/api/episode/:guid', async (req, res) => {
  try {
    const { guid } = req.params;
    console.log(`Fetching episode data for GUID: ${guid}`);
    
    const episode = await getEpisodeByGuid(guid);
    
    if (!episode) {
      return res.status(404).json({ 
        error: 'Episode not found',
        guid 
      });
    }

    res.json({ episode });
  } catch (error) {
    console.error('Error fetching episode:', error);
    res.status(500).json({ 
      error: 'Failed to fetch episode data',
      details: error.message,
      guid: req.params.guid
    });
  }
});

// Add an endpoint to get paragraph with its episode data
app.get('/api/paragraph-with-episode/:paragraphId', async (req, res) => {
  try {
    const { paragraphId } = req.params;
    console.log(`Fetching paragraph with episode data for ID: ${paragraphId}`);
    
    const result = await getParagraphWithEpisodeData(paragraphId);
    
    if (!result || !result.paragraph) {
      return res.status(404).json({ 
        error: 'Paragraph not found',
        paragraphId 
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching paragraph with episode:', error);
    res.status(500).json({ 
      error: 'Failed to fetch paragraph with episode data',
      details: error.message,
      paragraphId: req.params.paragraphId
    });
  }
});

// Add this new endpoint for testing feed retrieval
app.get('/api/feed/:feedId', async (req, res) => {
  try {
    const { feedId } = req.params;
    console.log(`Fetching feed data for feedId: ${feedId}`);
    
    const feed = await getFeedById(feedId);
    
    if (!feed) {
      return res.status(404).json({ 
        error: 'Feed not found',
        feedId 
      });
    }

    res.json({ feed });
  } catch (error) {
    console.error('Error fetching feed:', error);
    res.status(500).json({ 
      error: 'Failed to fetch feed data',
      details: error.message,
      feedId: req.params.feedId
    });
  }
});

// Add an endpoint to get paragraph with its feed data
app.get('/api/paragraph-with-feed/:paragraphId', async (req, res) => {
  try {
    const { paragraphId } = req.params;
    console.log(`Fetching paragraph with feed data for ID: ${paragraphId}`);
    
    const result = await getParagraphWithFeedData(paragraphId);
    
    if (!result || !result.paragraph) {
      return res.status(404).json({ 
        error: 'Paragraph not found',
        paragraphId 
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching paragraph with feed:', error);
    res.status(500).json({ 
      error: 'Failed to fetch paragraph with feed data',
      details: error.message,
      paragraphId: req.params.paragraphId
    });
  }
});

app.get('/api/clip-details/:lookupHash', async (req, res) => {
  try {
    const { lookupHash } = req.params;
    
    // Get the clip from WorkProductV2
    const clip = await WorkProductV2.findOne({ lookupHash });
    
    if (!clip) {
      return res.status(404).json({ error: 'Clip not found' });
    }
    
    // If we have the essential identifiers, fetch the detailed data
    const result = clip.result || {};
    const { feedId, guid } = result;
    
    // Only fetch additional data if we have the identifiers
    let feedData = null;
    let episodeData = null;
    
    if (feedId && guid) {
      // Fetch feed and episode data in parallel
      [feedData, episodeData] = await Promise.all([
        getFeedById(feedId),
        getEpisodeByGuid(guid)
      ]);
    }
    
    // Combine the data
    const detailedResult = {
      ...result,
      cdnFileId: clip.cdnFileId,
      feed: feedData,
      episode: episodeData
    };
    
    res.json(detailedResult);
  } catch (error) {
    console.error('Error fetching clip details:', error);
    res.status(500).json({ 
      error: 'Failed to fetch clip details',
      details: error.message
    });
  }
});

// Promotional tweet generation endpoint with jamie-assist name
app.post('/api/jamie-assist/:lookupHash', jamieAuthMiddleware, async (req, res) => {
  try {
    const { lookupHash } = req.params;
    const { additionalPrefs = {} } = req.body;
    
    console.log(`[INFO] Jamie Assist generating promotional content for clip: ${lookupHash}`);
    
    // Get the clip from WorkProductV2
    const clip = await WorkProductV2.findOne({ lookupHash });
    
    if (!clip) {
      return res.status(404).json({ error: 'Clip not found' });
    }
    
    // If we have the essential identifiers, fetch the detailed data
    const result = clip.result || {};
    const { feedId, guid, clipText } = result;
    
    if (!clipText) {
      return res.status(400).json({ error: 'Clip has no text content' });
    }
    
    // Fetch feed and episode data in parallel
    let feedData = null;
    let episodeData = null;
    
    if (feedId && guid) {
      [feedData, episodeData] = await Promise.all([
        getFeedById(feedId),
        getEpisodeByGuid(guid)
      ]);
    }
    
    // Prepare context for the LLM
    const context = {
      clipText: clipText || "No clip text available",
      episodeTitle: episodeData?.title || result.episodeTitle || "Unknown episode",
      feedTitle: feedData?.title || result.feedTitle || "Unknown podcast",
      episodeDescription: episodeData?.description || result.episodeDescription || "",
      feedDescription: feedData?.description || result.feedDescription || "",
      additionalPrefs
    };
    
    // Set up streaming response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Create the prompt for the LLM
    const prompt = `
You are a social media expert who creates engaging promotional tweets for podcast clips.

Here's information about the clip:
- Podcast: ${context.feedTitle}
- Episode: ${context.episodeTitle}
- Clip Text: "${context.clipText}"
${context.episodeDescription ? `- Episode Description: ${context.episodeDescription}` : ''}
${context.feedDescription ? `- Podcast Description: ${context.feedDescription}` : ''}

${additionalPrefs.tone ? `Tone preference: ${additionalPrefs.tone}` : 'Use an engaging, conversational tone'}
${additionalPrefs.length ? `Length preference: ${additionalPrefs.length}` : 'Keep the tweet under 280 characters'}
${additionalPrefs.hashtags ? `Hashtag preference: ${additionalPrefs.hashtags}` : 'Include 1-2 relevant hashtags'}
${additionalPrefs.customInstructions ? `Additional instructions: ${additionalPrefs.customInstructions}` : ''}

Create a compelling promotional tweet that:
1. Captures the essence of the clip
2. Entices people to listen
3. Is shareable and attention-grabbing
4. Includes relevant context about the podcast/episode
5. Follows Twitter's character limit (280 chars)

Write only the tweet text, without any explanations or quotation marks.
`;

    // Call OpenAI with streaming
    const stream = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [{ role: "user", content: prompt }],
      stream: true,
      temperature: 0.7,
      max_tokens: 300
    });
    
    // Stream the response to the client
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }
    
    // End the stream
    res.write('data: [DONE]\n\n');
    res.end();
    
  } catch (error) {
    console.error('Error in jamie-assist:', error);
    
    // If headers haven't been sent yet, return a JSON error
    if (!res.headersSent) {
      return res.status(500).json({ 
        error: 'Failed to generate promotional content',
        details: error.message
      });
    }
    
    // If streaming has started, send error in the stream
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

