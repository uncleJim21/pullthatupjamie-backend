require('dotenv').config();//
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { OpenAI } = require('openai');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})
const { SearxNGTool } = require('./agent-tools/searxngTool');
const {findSimilarDiscussions, getFeedsDetails, getClipById, getEpisodeByGuid, getParagraphWithEpisodeData, getFeedById, getParagraphWithFeedData, getTextForTimeRange, getQuickStats} = require('./agent-tools/pineconeTools.js')
const mongoose = require('mongoose');
const {JamieFeedback} = require('./models/JamieFeedback.js');
const {generateInvoiceAlbyAPI,getIsInvoicePaid} = require('./utils/lightning-utils')
const { RateLimitedInvoiceGenerator } = require('./utils/rate-limited-invoice');
const invoiceGenerator = new RateLimitedInvoiceGenerator();
const { initializeInvoiceDB } = require('./utils/invoice-db');
const {initializeRequestsDB, checkFreeEligibility, freeRequestMiddleware} = require('./utils/requests-db')
const {squareRequestMiddleware, initializeJamieUserDB, upsertJamieUser} = require('./utils/jamie-user-db')
const DatabaseBackupManager = require('./utils/DatabaseBackupManager');
const Scheduler = require('./utils/Scheduler');
const callIngestor = require('./utils/callIngestor');
const path = require('path');
const {DEBUG_MODE, SCHEDULER_ENABLED, SCHEDULED_INGESTOR_TIMES, printLog} = require('./constants.js')
const ClipUtils = require('./utils/ClipUtils');
const { getPodcastFeed } = require('./utils/LandingPageService');
const {WorkProductV2, calculateLookupHash} = require('./models/WorkProductV2')
const QueueJob = require('./models/QueueJob');
const ClipQueueManager = require('./utils/ClipQueueManager');
const FeedCacheManager = require('./utils/FeedCacheManager');
const jwt = require('jsonwebtoken');
const { ProPodcastDetails } = require('./models/ProPodcastDetails.js');
const {getProPodcastByAdminEmail} = require('./utils/ProPodcastUtils.js')
const podcastRunHistoryRoutes = require('./routes/podcastRunHistory');
const podcastPreferencesRoutes = require('./routes/podcastPreferencesRoutes');
const appPreferencesRoutes = require('./routes/appPreferencesRoutes');
const onDemandRunsRoutes = require('./routes/onDemandRuns');
const adminEntitlementsRoutes = require('./routes/adminEntitlements');
const { v4: uuidv4 } = require('uuid');
const DigitalOceanSpacesManager = require('./utils/DigitalOceanSpacesManager');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const debugRoutes = require('./routes/debugRoutes');
const ScheduledPodcastFeed = require('./models/ScheduledPodcastFeed.js');
const twitterRoutes = require('./routes/twitterRoutes');
const socialPostRoutes = require('./routes/socialPostRoutes');
const nostrRoutes = require('./routes/nostrRoutes');
const cookieParser = require('cookie-parser'); // Add this line
const { OnDemandQuota } = require('./models/OnDemandQuota');
const mentionsRoutes = require('./routes/mentions');
const automationSettingsRoutes = require('./routes/automationSettingsRoutes');
const { User } = require('./models/User');
const { Entitlement } = require('./models/Entitlement');
const { updateEntitlementConfig } = require('./utils/entitlements');
const { checkAdminMode } = require('./middleware/authMiddleware');
const { serviceHmac } = require('./middleware/hmac');
const GarbageCollector = require('./utils/GarbageCollector');


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

// CORS configuration
const corsOptions = {
    origin: [
        'http://localhost:3000',
        'http://localhost:3001', 
        'https://pullthatupjamie.ai',
        'https://www.pullthatupjamie.ai'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type', 
        'Authorization',
        'sec-ch-ua',
        'sec-ch-ua-mobile',
        'sec-ch-ua-platform',
        'User-Agent',
        'Accept',
        'Accept-Language',
        'Accept-Encoding',
        'Referer',
        'Origin',
        'X-Requested-With'
    ],
    credentials: true
};

// Middleware
app.use(cors(corsOptions));
app.enable('trust proxy');
app.set('trust proxy', true);
app.use(express.json());
app.use(cookieParser()); // Add this line before session middleware

// Add session middleware
const session = require('express-session');
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: true,
  saveUninitialized: true,
  rolling: true, // Extends session lifetime on activity
  cookie: {
    secure: false, // Set to false for local development
    httpOnly: true,
    sameSite: 'lax',
    domain: 'localhost',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  },
  name: 'connect.sid' // Explicitly set the cookie name
}));

// Environment variables with defaults
const PORT = process.env.PORT || 4132;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gpt-4o-mini';

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

// Initialize transcript spaces manager with dedicated credentials
let transcriptSpacesManager = null;
if (process.env.TRANSCRIPT_SPACES_ACCESS_KEY_ID && 
    process.env.TRANSCRIPT_SPACES_SECRET_KEY && 
    process.env.TRANSCRIPT_SPACES_BUCKET_NAME) {
  try {
    transcriptSpacesManager = new DigitalOceanSpacesManager(
      process.env.SPACES_ENDPOINT,
      process.env.TRANSCRIPT_SPACES_ACCESS_KEY_ID,
      process.env.TRANSCRIPT_SPACES_SECRET_KEY,
      {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 10000, // Fixed typo: to000 -> 10000
        timeout: 30000
      }
    );
    console.log('Transcript spaces manager initialized successfully');
  } catch (error) {
    console.error('Error initializing transcript spaces manager:', error);
  }
} else {
  console.warn('Transcript spaces credentials not provided. Transcript access may be limited.');
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

// Initialize podcast RSS cache manager
const PodcastRssCacheManager = require('./utils/PodcastRssCacheManager');
const podcastRssCache = new PodcastRssCacheManager();
global.podcastRssCache = podcastRssCache; // Make it globally available

const clipUtils = new ClipUtils();
const clipQueueManager = new ClipQueueManager({
  maxConcurrent: 4,
  maxQueueSize: 100
}, clipUtils, generateSubtitlesForClip);

// Initialize the scheduler if enabled
const scheduler = SCHEDULER_ENABLED ? new Scheduler() : null;

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
    'gpt-4o-mini': {
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      headers: (apiKey) => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }),
      formatData: (messages) => ({
        model: 'gpt-4o-mini',
        messages,
        stream: true,
        temperature: 0.0
      }),
      parseContent: (parsed) => ({
        content: parsed.choices[0].delta.content,
        done: false
      })
    },
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
    'claude-3-5-sonnet': {
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
          model: 'claude-3-5-sonnet-20241022',
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

// Add this function to generate subtitles
async function generateSubtitlesForClip(clipData, start, end) {
  const debugPrefix = `[SUBTITLE-DEBUG][${Date.now()}]`;
  console.log(`${debugPrefix} ========== SUBTITLE GENERATION STARTING ==========`);
  console.log(`${debugPrefix} generateSubtitlesForClip called with start: ${start}, end: ${end}`);
  console.log(`${debugPrefix} Duration: ${end - start}s`);
  
  if (!clipData) {
    console.error(`${debugPrefix} clipData is null or undefined, cannot generate subtitles`);
    return [];
  }
  
  // Dump the entire clipData for debugging
  console.log(`${debugPrefix} Full clipData structure: ${JSON.stringify(clipData, null, 2)}`);
  
  // Extract podcast GUID from clipData with more extensive logging
  let guid = null;
  
  // Try all possible paths to find the GUID
  if (clipData.additionalFields?.guid) {
    guid = clipData.additionalFields.guid;
    console.log(`${debugPrefix} Found GUID in clipData.additionalFields.guid: ${guid}`);
  } else if (clipData.shareLink && clipData.shareLink.includes('_p')) {
    guid = clipData.shareLink.split('_p')[0];
    console.log(`${debugPrefix} Extracted GUID from shareLink: ${guid}`);
  } else if (clipData.additionalMetadata?.guid) {
    guid = clipData.additionalMetadata.guid;
    console.log(`${debugPrefix} Found GUID in clipData.additionalMetadata.guid: ${guid}`);
  } else {
    console.warn(`${debugPrefix} No podcast GUID found in any expected location in clipData`);
    console.log(`${debugPrefix} clipData.additionalFields: ${JSON.stringify(clipData.additionalFields || {})}`);
    console.log(`${debugPrefix} clipData.shareLink: ${clipData.shareLink}`);
    console.log(`${debugPrefix} clipData.additionalMetadata: ${JSON.stringify(clipData.additionalMetadata || {})}`);
  }
  
  if (!guid) {
    console.error(`${debugPrefix} FATAL: No podcast GUID found in clip data, cannot generate subtitles`);
    return [];
  }
  
  try {
    console.time(`${debugPrefix} Subtitle-Generation-Time`);
    console.log(`${debugPrefix} Calling getWordTimestampsFromFullTranscriptJSON with guid: ${guid}, start: ${start}, end: ${end}`);
    
    // Get real word timestamps from the transcript JSON
    const subtitles = await getWordTimestampsFromFullTranscriptJSON(guid, start, end);
    console.timeEnd(`${debugPrefix} Subtitle-Generation-Time`);
    
    // Detailed subtitle validation and stats
    if (!subtitles || !Array.isArray(subtitles)) {
      console.error(`${debugPrefix} Invalid subtitles returned (not an array): ${typeof subtitles}`);
      return [];
    }
    
    console.log(`${debugPrefix} Generated ${subtitles.length} subtitles for clip`);
    
    if (subtitles.length === 0) {
      console.warn(`${debugPrefix} No subtitles found in the specified time range ${start}s to ${end}s`);
      return [];
    }
    
    // Calculate subtitle coverage and statistics
    const clipDuration = end - start;
    const subtitlesDuration = subtitles.reduce((total, sub) => total + (sub.end - sub.start), 0);
    const coverage = (subtitlesDuration / clipDuration) * 100;
    
    console.log(`${debugPrefix} Subtitle Statistics:`);
    console.log(`${debugPrefix} - Total clip duration: ${clipDuration.toFixed(2)}s`);
    console.log(`${debugPrefix} - Total subtitles duration: ${subtitlesDuration.toFixed(2)}s`);
    console.log(`${debugPrefix} - Coverage: ${coverage.toFixed(2)}%`);
    console.log(`${debugPrefix} - First subtitle: ${JSON.stringify(subtitles[0])}`);
    console.log(`${debugPrefix} - Last subtitle: ${JSON.stringify(subtitles[subtitles.length - 1])}`);
    
    // Validate subtitle timing - check for overlap or gaps
    let hasOverlaps = false;
    let hasGaps = false;
    let previousEnd = 0;
    
    for (let i = 0; i < subtitles.length; i++) {
      const current = subtitles[i];
      
      // Check for basic validity
      if (typeof current.start !== 'number' || typeof current.end !== 'number') {
        console.warn(`${debugPrefix} Invalid subtitle timing at index ${i}: ${JSON.stringify(current)}`);
        continue;
      }
      
      // Check if this subtitle starts before it ends
      if (current.start >= current.end) {
        console.warn(`${debugPrefix} Subtitle at index ${i} has start >= end: ${JSON.stringify(current)}`);
      }
      
      // Check for overlap with previous subtitle
      if (i > 0 && current.start < previousEnd) {
        hasOverlaps = true;
        console.warn(`${debugPrefix} Subtitle overlap detected: ${JSON.stringify(subtitles[i-1])} and ${JSON.stringify(current)}`);
      }
      
      // Check for gap with previous subtitle (more than 0.5s)
      if (i > 0 && current.start - previousEnd > 0.5) {
        hasGaps = true;
        console.warn(`${debugPrefix} Gap detected between subtitles: ${previousEnd}s to ${current.start}s (${(current.start - previousEnd).toFixed(2)}s)`);
      }
      
      previousEnd = current.end;
    }
    
    console.log(`${debugPrefix} Subtitle validation complete - Overlaps: ${hasOverlaps}, Gaps: ${hasGaps}`);
    console.log(`${debugPrefix} ========== SUBTITLE GENERATION COMPLETE ==========`);
    
    return subtitles;
  } catch (error) {
    console.error(`${debugPrefix} FAILED TO GENERATE SUBTITLES: ${error.message}`);
    console.error(`${debugPrefix} Stack trace: ${error.stack}`);
    console.log(`${debugPrefix} ========== SUBTITLE GENERATION FAILED ==========`);
    return [];
  }
}

app.post('/api/make-clip', jamieAuthMiddleware, async (req, res) => {
  const debugPrefix = `[MAKE-CLIP][${Date.now()}]`;
  console.log(`${debugPrefix} ==== /api/make-clip ENDPOINT CALLED ====`);
  const { clipId, timestamps } = req.body;

  console.log(`${debugPrefix} Request body: ${JSON.stringify(req.body)}`);
  
  if (!clipId) {
      console.error(`${debugPrefix} Missing required parameter: clipId`);
      return res.status(400).json({ error: 'clipId is required' });
  }

  try {
      // 1. Get clip data (keep this - it's fast)
      console.log(`${debugPrefix} Fetching clip data for clipId: ${clipId}`);
      const clipData = await getClipById(clipId);
      if (!clipData) {
          console.error(`${debugPrefix} Clip not found for clipId: ${clipId}`);
          return res.status(404).json({ error: 'Clip not found', clipId });
      }

      // 2. Calculate lookup hash (keep this - it's fast)
      const lookupHash = calculateLookupHash(clipData, timestamps);
      console.log(`${debugPrefix} Calculated lookupHash: ${lookupHash}`);

      // 3. Check if this exists already (keep this - it's fast)
      const existingClip = await WorkProductV2.findOne({ lookupHash });
      if (existingClip) {
          if (existingClip.cdnFileId) {
              console.log(`${debugPrefix} Clip already exists with URL: ${existingClip.cdnFileId}`);
              return res.status(200).json({
                  status: 'completed',
                  lookupHash,
                  url: existingClip.cdnFileId
              });
          }
          console.log(`${debugPrefix} Clip is already processing with lookupHash: ${lookupHash}`);
          return res.status(202).json({
              status: 'processing',
              lookupHash,
              pollUrl: `/api/clip-status/${lookupHash}`
          });
      }

      // 4. Create minimal initial record (keep this - it's fast)
      console.log(`${debugPrefix} Creating initial WorkProductV2 record...`);
      await WorkProductV2.create({
          type: 'ptuj-clip',
          lookupHash,
          status: 'queued',
          cdnFileId: null,
          result: {
              resultSchemaVersion: 2025321,
              feedId: clipData.additionalFields?.feedId || null,
              guid: clipData.additionalFields?.guid || null,
              shareLink: clipData.shareLink,
              clipText: clipData.quote || "", // Will be updated in background
              timeStart: timestamps ? timestamps[0] : clipData.timeContext?.start_time,
              timeEnd: timestamps ? timestamps[1] : clipData.timeContext?.end_time,
              hasSubtitles: false // Will be updated in background
          }
      });
      console.log(`${debugPrefix} Initial WorkProductV2 record created`);

      // 5. Queue the job for background processing (don't await)
      console.log(`${debugPrefix} Adding clip to the processing queue...`);
      clipQueueManager.enqueueClip(clipData, timestamps, lookupHash, null).catch(err => {
          console.error(`${debugPrefix} Error queuing clip: ${err.message}`);
          console.error(err.stack);
          // Update DB with error status if queue fails
          WorkProductV2.findOneAndUpdate(
              { lookupHash },
              { status: 'failed', error: err.message }
          ).catch(error => console.error(`${debugPrefix} Error updating WorkProductV2: ${error.message}`));
      });

      console.log(`${debugPrefix} Clip successfully queued. Returning response to client.`);
      // Return immediately - everything else happens in background
      return res.status(202).json({
          status: 'processing',
          lookupHash,
          pollUrl: `/api/clip-status/${lookupHash}`
      });

  } catch (error) {
      console.error(`${debugPrefix} Error in make-clip endpoint: ${error.message}`);
      console.error(`${debugPrefix} Stack trace: ${error.stack}`);
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

async function processClip(clip, timestamps, subtitles = null) {
  try {
    console.log(`Processing clip with clipId:${clip.shareLink}`);
    
    // If timestamps provided, update clip time context
    if (timestamps?.length >= 2) {
      clip.timeContext = {
        start_time: timestamps[0],
        end_time: timestamps[1]
      };
    }

    const videoUrl = await clipUtils.processClip(clip, timestamps, subtitles);
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

///Video Editing Endpoints

app.post('/api/edit-video', verifyPodcastAdminMiddleware, async (req, res) => {
  const debugPrefix = `[EDIT-VIDEO][${Date.now()}]`;
  console.log(`${debugPrefix} ==== /api/edit-video ENDPOINT CALLED ====`);
  const { cdnUrl, startTime, endTime, useSubtitles = false } = req.body;

  console.log(`${debugPrefix} Request body: ${JSON.stringify(req.body)}`);
  
  // Validate required parameters
  if (!cdnUrl) {
      console.error(`${debugPrefix} Missing required parameter: cdnUrl`);
      return res.status(400).json({ error: 'cdnUrl is required' });
  }

  if (startTime === undefined || endTime === undefined) {
      console.error(`${debugPrefix} Missing required parameters: startTime and endTime`);
      return res.status(400).json({ error: 'startTime and endTime are required' });
  }

  if (typeof startTime !== 'number' || typeof endTime !== 'number') {
      console.error(`${debugPrefix} Invalid parameter types: startTime and endTime must be numbers`);
      return res.status(400).json({ error: 'startTime and endTime must be numbers' });
  }

  try {
      console.log(`${debugPrefix} Processing edit request for: ${cdnUrl}`);
      console.log(`${debugPrefix} Time range: ${startTime}s to ${endTime}s (${endTime - startTime}s duration)`);
      
      const result = await clipUtils.processEditRequest(cdnUrl, startTime, endTime, useSubtitles, req.podcastAdmin?.feedId);
      
      console.log(`${debugPrefix} Edit request processed successfully: ${JSON.stringify(result)}`);
      return res.status(202).json(result);

  } catch (error) {
      console.error(`${debugPrefix} Error in edit-video endpoint: ${error.message}`);
      console.error(`${debugPrefix} Stack trace: ${error.stack}`);
      return res.status(500).json({ 
          error: 'Failed to process edit request',
          details: error.message 
      });
  }
});

// Status check endpoint for video edits
app.get('/api/edit-status/:lookupHash', async (req, res) => {
  const { lookupHash } = req.params;
  const debugPrefix = `[EDIT-STATUS][${lookupHash}]`;

  try {
      console.log(`${debugPrefix} Checking status for edit: ${lookupHash}`);
      
      const edit = await WorkProductV2.findOne({ lookupHash });

      if (!edit) {
          console.log(`${debugPrefix} Edit not found`);
          return res.status(404).json({ status: 'not_found' });
      }

      if (edit.status === 'completed' && edit.cdnFileId) {
          console.log(`${debugPrefix} Edit completed: ${edit.cdnFileId}`);
          return res.json({
              status: 'completed',
              url: edit.cdnFileId,
              lookupHash
          });
      }

      if (edit.status === 'failed') {
          console.log(`${debugPrefix} Edit failed: ${edit.error}`);
          return res.json({
              status: 'failed',
              error: edit.error,
              lookupHash
          });
      }

      console.log(`${debugPrefix} Edit still processing, status: ${edit.status}`);
      return res.json({
          status: edit.status || 'processing',
          lookupHash
      });

  } catch (error) {
      console.error(`${debugPrefix} Error checking edit status: ${error.message}`);
      return res.status(500).json({ 
          error: 'Failed to check edit status',
          details: error.message 
      });
  }
});

// Get all child edits of a parent video file
app.get('/api/edit-children/:parentFileName', verifyPodcastAdminMiddleware, async (req, res) => {
  const { parentFileName } = req.params;
  const debugPrefix = `[EDIT-CHILDREN][${parentFileName}]`;

  try {
    console.log(`${debugPrefix} Getting children for parent: ${parentFileName}`);
    
    // Remove extension from parent filename for base matching
    const parentFileBase = parentFileName.replace(/\.[^/.]+$/, "");
    
    // Find all edits for this parent file
    const childEdits = await WorkProductV2.find({
      type: 'video-edit',
      'result.parentFileBase': parentFileBase
    }).sort({ createdAt: -1 }); // Most recent first

    console.log(`${debugPrefix} Found ${childEdits.length} child edits`);

    // Format the response
    const formattedEdits = childEdits.map(edit => ({
      lookupHash: edit.lookupHash,
      status: edit.status,
      url: edit.cdnFileId,
      editRange: `${edit.result.editStart}s-${edit.result.editEnd}s`,
      duration: edit.result.editDuration,
      createdAt: edit.createdAt,
      originalUrl: edit.result.originalUrl
    }));

    return res.json({
      parentFileName,
      parentFileBase,
      childCount: formattedEdits.length,
      children: formattedEdits
    });

  } catch (error) {
    console.error(`${debugPrefix} Error getting child edits: ${error.message}`);
    return res.status(500).json({ 
      error: 'Failed to get child edits',
      details: error.message 
    });
  }
});

///Podcast Search

// Add this endpoint to your Express server (server.js/index.js)

app.get('/api/podcast-feed/:feedId', async (req, res) => {
  const { printLog } = require('./constants');
  const { feedId } = req.params;
  const requestStartTime = Date.now();
  
  printLog(`🚀 [TIMING] Starting podcast feed request for ID: ${feedId} at ${new Date().toISOString()}`);
  
  try {
    const serviceStartTime = Date.now();
    printLog(`📡 [TIMING] Calling getPodcastFeed service...`);
    
    const response = await getPodcastFeed(feedId);
    
    const serviceEndTime = Date.now();
    printLog(`✅ [TIMING] getPodcastFeed service completed in ${serviceEndTime - serviceStartTime}ms`);
    
    // Remove updatedAt field from response
    const cleanupStartTime = Date.now();
    if (response && typeof response === 'object') {
      delete response.updatedAt;
      delete response.twitterTokens;
      delete response.queuedEpisodeGuids;
    }
    const cleanupEndTime = Date.now();
    printLog(`🧹 [TIMING] Response cleanup completed in ${cleanupEndTime - cleanupStartTime}ms`);
    
    // Add cache headers
    res.setHeader('Cache-Control', 'public, max-age=300');
    
    const totalTime = Date.now() - requestStartTime;
    printLog(`🎯 [TIMING] Total request time: ${totalTime}ms`);
    printLog(`📊 [TIMING] Response contains ${response?.episodes?.length || 0} episodes`);
    
    res.json(response);
  } catch (error) {
    const errorTime = Date.now() - requestStartTime;
    printLog(`❌ [TIMING] Request failed after ${errorTime}ms - Error: ${error.message}`);
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
  const requestId = `STREAM-SEARCH-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const { query, model = DEFAULT_MODEL, mode = 'default' } = req.body;
  
  printLog(`[${requestId}] ========== STREAM SEARCH REQUEST STARTED ==========`);
  printLog(`[${requestId}] Request body:`, { query, model, mode });
  printLog(`[${requestId}] DEFAULT_MODEL:`, DEFAULT_MODEL);
  printLog(`[${requestId}] Auth info:`, req.auth);
 
  if (!query) {
    printLog(`[${requestId}] ERROR: Missing query parameter`);
    return res.status(400).json({ error: 'Query is required' });
  }
 
  try {
    let searchResults = [];
    const { email, preimage, paymentHash } = req.auth || {};
    
    printLog(`[${requestId}] ========== SEARXNG SEARCH PHASE ==========`);
 
    try {
      // Create a new SearxNG instance
      const searxngConfig = {
        username: process.env.ANON_AUTH_USERNAME,
        password: process.env.ANON_AUTH_PW
      };
      
      printLog(`[${requestId}] SearxNG config (username only):`, { username: searxngConfig.username });
 
      const searxng = new SearxNGTool(searxngConfig);
      printLog(`[${requestId}] SearxNG instance created, performing search for:`, query);
      
      const rawSearchResults = await searxng.search(query);
      printLog(`[${requestId}] Raw search results count:`, rawSearchResults.length);
      printLog(`[${requestId}] Raw search results sample:`, rawSearchResults.slice(0, 2));
      
      searchResults = rawSearchResults.slice(0, 10);
      printLog(`[${requestId}] Final search results count:`, searchResults.length);
      printLog(`[${requestId}] Final search results:`, searchResults);
    } catch (searchError) {
      printLog(`[${requestId}] SEARXNG ERROR:`, searchError);
      searchResults = [{
        title: 'Search Error',
        url: 'https://example.com',
        snippet: 'SearxNG search failed. Using fallback result.'
      }];
      printLog(`[${requestId}] Using fallback search results:`, searchResults);
    }
    
    printLog(`[${requestId}] ========== SSE SETUP PHASE ==========`);
 
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    printLog(`[${requestId}] SSE headers set`);
 
    // Send search results
    const searchDataPayload = {
      type: 'search',
      data: searchResults
    };
    printLog(`[${requestId}] Sending search data payload:`, searchDataPayload);
    res.write(`data: ${JSON.stringify(searchDataPayload)}\n\n`);
    printLog(`[${requestId}] Search results sent to client`);
    
    printLog(`[${requestId}] ========== LLM MESSAGE PREPARATION PHASE ==========`);
 
    // Prepare formatted sources
    const formattedSources = searchResults.map((result, index) => {

      // Get content, handling empty strings and undefined values
      const contentValue = result.snippet || result.content;
      const safeContent = (contentValue && contentValue.trim()) ? contentValue.trim() : 'No content available';
      
      const formatted = `${index + 1}. ${result.title}\nURL: ${result.url}\nContent: ${safeContent}\n`;
      printLog(`[${requestId}] Formatted source ${index + 1}:`, formatted);
      return formatted;
    }).join('\n');
    
    printLog(`[${requestId}] Complete formatted sources:`, formattedSources);
 
    // Construct messages for LLM
    let systemMessage = `You are a helpful research assistant that provides well-structured, markdown-formatted responses.`;
    
    if (mode === 'quick') {
      systemMessage += ` Provide brief, concise summaries focusing on the most important points.`;
    }
    
    systemMessage += ` Format your response as follows:
    - Use clear, concise language
    - Use proper markdown formatting
    - Cite sources using [[n]](url) format inline within sentences, where n is the source number (e.g., "Water is wet [[1]](https://example.com)")
    - Citations should appear immediately after relevant facts or claims
    - Start with a brief overview
    - Use bullet points for multiple items
    - Bold key terms with **term**
    - Maintain professional tone
    - Do not say "according to sources" or similar phrases
    - Pay very close attention to numerical figures given. Be certain to not misinterpret those. Simply write those exactly as written.
    - Use the provided title, URL, and content from each source to inform your response`;
    const userMessage = `Query: "${query}"\n\nSources:\n${formattedSources}`;
    
    printLog(`[${requestId}] System message:`, systemMessage);
    printLog(`[${requestId}] User message:`, userMessage);
    printLog(`[${requestId}] Selected model:`, model);
    
    printLog(`[${requestId}] ========== MODEL CONFIG PHASE ==========`);
    const modelConfig = MODEL_CONFIGS[model];
    printLog(`[${requestId}] Model config found:`, !!modelConfig);
    printLog(`[${requestId}] Model config details:`, {
      apiUrl: modelConfig?.apiUrl,
      hasFormatData: !!modelConfig?.formatData,
      hasHeaders: !!modelConfig?.headers
    });
    
    if (!modelConfig) {
      printLog(`[${requestId}] FATAL ERROR: No model config found for model:`, model);
      printLog(`[${requestId}] Available models:`, Object.keys(MODEL_CONFIGS));
      throw new Error(`Unsupported model: ${model}`);
    }
    
    const apiKey = model.startsWith('gpt') ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
    printLog(`[${requestId}] API key type:`, model.startsWith('gpt') ? 'OpenAI' : 'Anthropic');
    printLog(`[${requestId}] API key present:`, !!apiKey);
    printLog(`[${requestId}] API key length:`, apiKey?.length);
    
    const messages = [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ];
    printLog(`[${requestId}] Messages array:`, messages);
    
    const formattedData = modelConfig.formatData(messages);
    printLog(`[${requestId}] Formatted data for API:`, formattedData);
    
    const headers = modelConfig.headers(apiKey);
    printLog(`[${requestId}] Request headers:`, headers);
    
    const contentBuffer = new ContentBuffer();
    printLog(`[${requestId}] ContentBuffer created`);
    
    printLog(`[${requestId}] ========== API REQUEST PHASE ==========`);
    printLog(`[${requestId}] Making API request to:`, modelConfig.apiUrl);
 
    const response = await axios({
      method: 'post',
      url: modelConfig.apiUrl,
      headers: headers,
      data: formattedData,
      responseType: 'stream'
    });
    
    printLog(`[${requestId}] API response received, status:`, response.status);
    printLog(`[${requestId}] API response headers:`, response.headers);
    
    printLog(`[${requestId}] ========== STREAM PROCESSING PHASE ==========`);
 
    response.data.on('data', (chunk) => {
      const chunkString = chunk.toString();
      printLog(`[${requestId}] Received chunk (${chunkString.length} chars):`, chunkString.substring(0, 200) + (chunkString.length > 200 ? '...' : ''));
      
      const lines = chunkString.split('\n');
      lines.forEach((line, lineIndex) => {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          printLog(`[${requestId}] Processing data line ${lineIndex}:`, data);
          
          if (data === '[DONE]') {
            printLog(`[${requestId}] Received [DONE] signal`);
            const finalContent = contentBuffer.flush();
            if (finalContent) {
              printLog(`[${requestId}] Flushing final content:`, finalContent);
              res.write(`data: ${JSON.stringify({
                type: 'inference',
                data: finalContent
              })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
            printLog(`[${requestId}] Stream ended with [DONE]`);
            return;
          }
    
          try {
            const parsed = JSON.parse(data);
            printLog(`[${requestId}] Parsed JSON:`, parsed);
            let content;
            
            if (model.startsWith('gpt')) {
              content = parsed.choices?.[0]?.delta?.content;
              printLog(`[${requestId}] GPT content extracted:`, content);
            } else {
              // Handle Claude format
              printLog(`[${requestId}] Processing Claude format, type:`, parsed.type);
              if (parsed.type === 'content_block_start') {
                printLog(`[${requestId}] Skipping content_block_start`);
                return; // Skip content block start messages
              }
              if (parsed.type === 'content_block_stop') {
                printLog(`[${requestId}] Skipping content_block_stop`);
                return; // Skip content block stop messages
              }
              if (parsed.type === 'ping') {
                printLog(`[${requestId}] Skipping ping`);
                return; // Skip ping messages
              }
              content = parsed.delta?.text;
              printLog(`[${requestId}] Claude content extracted:`, content);
            }
    
            if (content) {
              printLog(`[${requestId}] Adding content to buffer:`, content);
              const bufferedContent = contentBuffer.add(content);
              if (bufferedContent) {
                printLog(`[${requestId}] Sending buffered content:`, bufferedContent);
                res.write(`data: ${JSON.stringify({
                  type: 'inference',
                  data: bufferedContent
                })}\n\n`);
              } else {
                printLog(`[${requestId}] Content added to buffer but not yet ready to send`);
              }
            } else {
              printLog(`[${requestId}] No content extracted from parsed data`);
            }
          } catch (e) {
            if (e instanceof SyntaxError) {
              printLog(`[${requestId}] JSON Parse Error:`, {
                data: data.substring(0, 100),
                error: e.message,
                fullData: data
              });
              return; // Skip malformed JSON
            }
            printLog(`[${requestId}] Non-JSON error:`, e);
            throw e;
          }
        } else if (line.trim()) {
          printLog(`[${requestId}] Non-data line:`, line);
        }
      });
    });
 
    response.data.on('end', () => {
      printLog(`[${requestId}] Stream ended naturally`);
      const finalContent = contentBuffer.flush();
      if (finalContent) {
        printLog(`[${requestId}] Flushing final content on end:`, finalContent);
        res.write(`data: ${JSON.stringify({
          type: 'inference',
          data: finalContent
        })}\n\n`);
      }
      res.end();
      printLog(`[${requestId}] ========== STREAM SEARCH COMPLETED ==========`);
    });
 
    response.data.on('error', (error) => {
      printLog(`[${requestId}] Stream error:`, error);
      res.write(`data: ${JSON.stringify({
        type: 'error',
        data: 'Stream processing error occurred'
      })}\n\n`);
      res.end();
      printLog(`[${requestId}] ========== STREAM SEARCH FAILED ==========`);
    });
  } catch (error) {
    printLog(`[${requestId}] FATAL ERROR:`, error);
    printLog(`[${requestId}] Error stack:`, error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
    printLog(`[${requestId}] ========== STREAM SEARCH FAILED ==========`);
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
    'audio/aac', 'audio/flac', 'audio/x-ms-wma', 'audio/vnd.wav', 'audio/basic',
    'audio/x-aiff', 'audio/x-m4a', 'audio/x-matroska', 'audio/xm', 'audio/midi',
    // Image formats
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp',
    'image/svg+xml', 'image/x-icon',
    // Video formats
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 
    'video/x-flv', 'video/x-matroska', 'video/3gpp', 'video/3gpp2', 'video/x-m4v',
    'video/mpeg', 'video/avi', 'video/mov', 'video/x-ms-wmv', 'video/x-ms-asf',
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
    const includeChildren = req.query.includeChildren !== 'false'; // Default to true
    
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
      .filter(item => !item.Key.includes('-children/')) // Filter out child edit files from main list
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

    // Add child relationship data if requested
    if (includeChildren) {
      console.log(`Adding child relationship data for ${uploads.length} uploads`);
      
      try {
        // Get all file bases for batch query
        const fileBases = uploads.map(upload => upload.fileName.replace(/\.[^/.]+$/, ""));
        
        // Single database query to get all child edits at once
        const allChildEdits = await WorkProductV2.find({
          type: 'video-edit',
          'result.parentFileBase': { $in: fileBases }
        }).sort({ createdAt: -1 });
        
        console.log(`Found ${allChildEdits.length} total child edits`);
        
        // Group child edits by parent file base
        const childEditsByParent = {};
        allChildEdits.forEach(edit => {
          const parentBase = edit.result.parentFileBase;
          if (!childEditsByParent[parentBase]) {
            childEditsByParent[parentBase] = [];
          }
          childEditsByParent[parentBase].push(edit);
        });
        
        // Add children to each upload
        uploads.forEach(upload => {
          const fileBase = upload.fileName.replace(/\.[^/.]+$/, "");
          const childEdits = childEditsByParent[fileBase] || [];
          
          upload.children = childEdits.map(edit => ({
            lookupHash: edit.lookupHash,
            status: edit.status,
            url: edit.cdnFileId,
            editRange: `${edit.result.editStart}s-${edit.result.editEnd}s`,
            duration: edit.result.editDuration,
            createdAt: edit.createdAt
          }));

          upload.childCount = upload.children.length;
          upload.hasChildren = upload.children.length > 0;
        });
        
      } catch (error) {
        console.error(`Failed to get children data: ${error.message}`);
        // Set empty children for all uploads on error
        uploads.forEach(upload => {
          upload.children = [];
          upload.childCount = 0;
          upload.hasChildren = false;
        });
      }
    }
    
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
      feedId,
      includeChildren,
      childrenSummary: includeChildren ? {
        totalParents: uploads.length,
        parentsWithChildren: uploads.filter(u => u.hasChildren).length,
        totalChildren: uploads.reduce((sum, u) => sum + (u.childCount || 0), 0)
      } : null
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

// Basic endpoint to get Pinecone index stats
app.get('/api/get-clip-count', async (req, res) => {
  try {
    const stats = await getQuickStats();
    const clipCount = stats.totalRecordCount;
    res.json({clipCount});
  } catch (error) {
    console.error('Error fetching index stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Queue monitoring endpoint
app.get('/api/queue-status', async (req, res) => {
  try {
    const status = await clipQueueManager.getQueueStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({ error: error.message });
  }
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
// Keep original route for backward compatibility
app.use('/api/user-prefs', podcastPreferencesRoutes);
// New route path
app.use('/api/podcast-preferences', podcastPreferencesRoutes);
app.use('/api/preferences', appPreferencesRoutes);
app.use('/api/on-demand', onDemandRunsRoutes);
app.use('/api/twitter', twitterRoutes);
app.use('/api/mentions', mentionsRoutes);
app.use('/api/social', socialPostRoutes);
app.use('/api/nostr', nostrRoutes);
app.use('/api/automation-settings', automationSettingsRoutes);

// Only enable admin and debug routes in debug mode
if (DEBUG_MODE) {
  console.log('🔍 Debug mode enabled - Admin and debug routes are accessible');
  app.use('/api/admin/entitlements', adminEntitlementsRoutes);
  app.use('/api/debug', debugRoutes);
  
  // Cleanup endpoint for limbo jobs (debug mode only)
  app.post('/api/debug/cleanup-limbo', async (req, res) => {
    try {
      // Find clips stuck in processing for more than 1 hour in both collections
      const cutoffTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      
      // Check WorkProductV2 for clips without cdnFileId but not failed
      const stuckWorkProducts = await WorkProductV2.find({
        $and: [
          { cdnFileId: { $in: [null, ''] } },
          { 
            $or: [
              { status: { $in: ['processing', undefined] } },
              { status: { $exists: false } }
            ]
          }
        ]
      });
      
      // Check QueueJob for old processing jobs
      const stuckQueueJobs = await QueueJob.find({
        status: 'processing',
        $or: [
          { heartbeatAt: { $lt: cutoffTime } },
          { heartbeatAt: { $exists: false } },
          { claimedAt: { $lt: cutoffTime } }
        ]
      });
      
      console.log(`Found ${stuckWorkProducts.length} stuck WorkProducts and ${stuckQueueJobs.length} stuck QueueJobs`);
      
      // Reset QueueJob entries to queued
      const queueJobResult = await QueueJob.updateMany(
        {
          status: 'processing',
          $or: [
            { heartbeatAt: { $lt: cutoffTime } },
            { heartbeatAt: { $exists: false } },
            { claimedAt: { $lt: cutoffTime } }
          ]
        },
        {
          status: 'queued',
          instanceId: null,
          claimedAt: null,
          heartbeatAt: null,
          startedAt: null,
          attempts: 0,
          lastError: null
        }
      );
      
      res.json({
        success: true,
        message: `Cleanup completed`,
        stuckWorkProducts: stuckWorkProducts.length,
        stuckQueueJobs: stuckQueueJobs.length,
        queueJobsReset: queueJobResult.modifiedCount,
        stuckWorkProductHashes: stuckWorkProducts.map(wp => wp.lookupHash),
        stuckQueueJobHashes: stuckQueueJobs.map(qj => qj.lookupHash)
      });
    } catch (error) {
      console.error('Error in limbo cleanup:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Debug endpoint to check podcast RSS cache status
  app.get('/api/debug/podcast-cache-status', async (req, res) => {
    try {
      const stats = global.podcastRssCache?.getCacheStats() || { error: 'Cache not initialized' };
      res.json({
        success: true,
        cacheStats: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error getting cache status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Debug endpoint to manually refresh podcast cache
  app.post('/api/debug/refresh-podcast-cache', async (req, res) => {
    try {
      const { feedId } = req.body;
      
      if (feedId) {
        // Refresh specific podcast
        const result = await global.podcastRssCache?.refreshPodcastData(feedId);
        res.json({
          success: true,
          message: `Refreshed cache for feedId: ${feedId}`,
          data: result ? 'Success' : 'Failed'
        });
      } else {
        // Refresh all podcasts
        const result = await global.podcastRssCache?.refreshAllPodcasts();
        res.json({
          success: true,
          message: 'Refreshed all podcast caches',
          result: result
        });
      }
    } catch (error) {
      console.error('Error refreshing podcast cache:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
}



app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DEBUG_MODE:`, process.env.DEBUG_MODE === 'true')
  console.log(`SCHEDULER_ENABLED:`, SCHEDULER_ENABLED)
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
    
    // Start Social Post Processor
    const SocialPostProcessor = require('./utils/SocialPostProcessor');
    const socialProcessor = new SocialPostProcessor();
    socialProcessor.start();
    console.log('Social post processor started successfully');
    
    // Start Garbage Collector
    const garbageCollector = new GarbageCollector();
    global.garbageCollector = garbageCollector; // Store globally for shutdown handlers
    garbageCollector.start();
    console.log('Garbage collector started successfully');
    
    // Set up hard-coded scheduled tasks in Chicago timezone if scheduler is enabled
    if (SCHEDULER_ENABLED) {
      console.log('Setting up scheduled tasks...');

      // Add a scheduled task to call the ingestor API using configured times
      const ingestorTimes = SCHEDULED_INGESTOR_TIMES;
        
      console.log(`Using ingestor schedule times: ${ingestorTimes.join(', ')} (Chicago time)`);
      
      scheduler.scheduleTask(
        'podcast-ingestor',
        ingestorTimes,
        async () => {
          try {
            const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
            console.log(`[SCHEDULED TASK] Starting podcast ingestion at ${now} (Chicago time)`);
            
            const result = await callIngestor();
            
            return result;
          } catch (error) {
            console.error(`[SCHEDULED TASK] Error triggering podcast ingestion:`, error.message);
          }
        }
      );

      // Schedule daily database backup at 3:00 AM Chicago time only if not in debug mode
      if (!DEBUG_MODE && dbBackupManager) {
        scheduler.scheduleTask(
          'database-backup',
          ['03:00'],
          () => {
            console.log('Running scheduled database backup');
            dbBackupManager.performBackup().catch(err => {
              console.error('Error in scheduled database backup:', err);
            });
          }
        );
      }

      // Schedule hourly podcast RSS cache refresh
      scheduler.scheduleTask(
        'podcast-rss-cache-refresh',
        ['00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '09:00', '10:00', '11:00', 
         '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'],
        async () => {
          try {
            const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
            console.log(`[SCHEDULED TASK] Starting podcast RSS cache refresh at ${now} (Chicago time)`);
            
            const result = await podcastRssCache.refreshAllPodcasts();
            console.log(`[SCHEDULED TASK] Podcast RSS cache refresh completed: ${result.successful} successful, ${result.failed} failed`);
            
            // Clean up expired entries
            podcastRssCache.cleanupExpiredEntries();
            
          } catch (error) {
            console.error(`[SCHEDULED TASK] Error in podcast RSS cache refresh:`, error.message);
          }
        }
      );
    } else {
      console.log('Scheduler is disabled. Skipping scheduled tasks setup.');
    }
    
    console.log('All systems initialized successfully');
  } catch (error) {
    console.error('Error during initialization:', error);
    // Don't exit the process, just log the error and continue without backups
    console.warn('Continuing without backup system...');
  }
});

// Update the shutdown handlers
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  if (SCHEDULER_ENABLED) {
    scheduler.stopAllTasks();
  }
  
  // ✅ GUARANTEED TRANSFER: Release jobs back to queue
  if (clipQueueManager) {
    await clipQueueManager.shutdown();
  }
  
  // Shutdown clip processing with memory cleanup
  if (clipUtils) {
    await clipUtils.shutdown();
    console.log('ClipUtils shutdown gracefully');
  }
  
  // Stop garbage collector gracefully
  if (global.garbageCollector) {
    global.garbageCollector.stop();
    console.log('Garbage collector stopped gracefully');
  }
  
  setTimeout(() => {
    mongoose.connection.close();
    process.exit(0);
  }, 1000);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  
  if (SCHEDULER_ENABLED) {
    scheduler.stopAllTasks();
  }
  
  // ✅ GUARANTEED TRANSFER: Release jobs back to queue
  if (clipQueueManager) {
    await clipQueueManager.shutdown();
  }
  
  // Shutdown clip processing with memory cleanup
  if (clipUtils) {
    await clipUtils.shutdown();
    console.log('ClipUtils shutdown gracefully');
  }
  
  // Stop garbage collector gracefully
  if (global.garbageCollector) {
    global.garbageCollector.stop();
    console.log('Garbage collector stopped gracefully');
  }
  
  // Close database connections and exit
  setTimeout(() => {
    mongoose.connection.close();
    process.exit(0);
  }, 1000);
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

/**
 * Alternative method to fetch transcript JSON directly from Digital Ocean Spaces
 * using dedicated transcript bucket credentials
 * 
 * @param {string} podGuid - The podcast GUID to fetch transcript for
 * @returns {Object} - The parsed transcript JSON data
 */
const formatTranscriptData = (transcriptData) => {
  if (!transcriptData) {
    console.error('Invalid transcript data: null or undefined');
    return null;
  }

  try {
    // The transcript data has a direct channels array
    if (!Array.isArray(transcriptData.channels)) {
      console.error('Invalid transcript structure - no channels array found');
      return null;
    }

    // Get the first channel's alternatives
    const channel = transcriptData.channels[0];
    if (!channel || !Array.isArray(channel.alternatives) || !channel.alternatives[0]) {
      console.error('Invalid transcript structure - missing channel data or alternatives');
      return null;
    }

    const alternative = channel.alternatives[0];
    
    // Format the transcript data
    const formattedData = {
      results: {
        channels: [{
          alternatives: [{
            confidence: alternative.confidence || 0,
            transcript: alternative.transcript || '',
            words: alternative.words || []
          }]
        }]
      },
      metadata: transcriptData.metadata || {},
      language_code: transcriptData.language_code || 'en-US',
      paragraphs: alternative.paragraphs || null
    };

    return formattedData;
  } catch (error) {
    console.error('Error formatting transcript data:', error);
    return null;
  }
};

const getTranscriptFromSpaces = async (podGuid) => {
  const debugPrefix = `[TRANSCRIPT-DEBUG][${Date.now()}]`;
  console.log(`${debugPrefix} getTranscriptFromSpaces START for guid: ${podGuid}`);
  
  if (!podGuid) {
    console.error(`${debugPrefix} Missing podGuid parameter`);
    throw new Error('Missing required parameter: podGuid');
  }
  
  if (!transcriptSpacesManager) {
    console.error(`${debugPrefix} Transcript spaces manager not initialized`);
    throw new Error('Transcript spaces manager not initialized');
  }
  
  try {
    console.time(`${debugPrefix} Transcript-Spaces-Fetch-Time`);
    
    // Construct the key for the transcript JSON file
    const transcriptKey = `${podGuid}.json`;
    console.log(`${debugPrefix} Fetching transcript with key: ${transcriptKey} from bucket: ${process.env.TRANSCRIPT_SPACES_BUCKET_NAME}`);
    
    // Get the file as buffer directly from Spaces
    const fileBuffer = await transcriptSpacesManager.getFileAsBuffer(
      process.env.TRANSCRIPT_SPACES_BUCKET_NAME,
      transcriptKey
    );
    
    console.timeEnd(`${debugPrefix} Transcript-Spaces-Fetch-Time`);
    console.log(`${debugPrefix} Transcript fetch completed successfully. File size: ${fileBuffer.length} bytes`);
    
    // Parse the JSON from the buffer
    let transcriptData;
    try {
      const jsonString = fileBuffer.toString('utf-8');
      transcriptData = JSON.parse(jsonString);
      console.log(`${debugPrefix} Successfully parsed transcript JSON`);
      
      // Format the transcript data before returning
      const formattedData = formatTranscriptData(transcriptData);
      if (!formattedData) {
        throw new Error('Failed to format transcript data: Invalid structure');
      }
      return formattedData;
    } catch (parseError) {
      console.error(`${debugPrefix} 🔴 Failed to parse transcript JSON: ${parseError.message}`);
      throw new Error(`Failed to parse transcript JSON: ${parseError.message}`);
    }
  } catch (error) {
    console.error(`${debugPrefix} 🔥 Failed to fetch transcript for GUID ${podGuid}: ${error.message}`);
    console.error(`${debugPrefix} Stack trace: ${error.stack}`);
    throw error;
  }
};

// Now let's add a temporary test endpoint to verify the new transcript access method

// TEMPORARY TEST ENDPOINT - Remove after testing
app.get('/api/test-transcript/:guid', async (req, res) => {
  try {
    const { guid } = req.params;
    console.log(`TESTING transcript access for GUID: ${guid}`);
    
    // Try the new method
    let transcript = null;
    let error = null;
    
    try {
      console.time('New-Method-Time');
      transcript = await getTranscriptFromSpaces(guid);
      console.timeEnd('New-Method-Time');
      console.log('SUCCESS: New transcript access method worked!');
    } catch (err) {
      error = err;
      console.error('ERROR: New transcript access method failed:', err.message);
    }
    
    // Return the result
    if (transcript) {
      res.json({
        success: true,
        message: 'Transcript successfully retrieved using new method',
        transcript: transcript
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: error?.message || 'Unknown error',
        guid
      });
    }
  } catch (error) {
    console.error('Error in test endpoint:', error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      stack: error.stack
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

// Promotional tweet generation endpoint with jamie-assist name (refactored to service)
const { streamJamieAssist } = require('./utils/JamieAssistService');
app.post('/api/jamie-assist/:lookupHash', jamieAuthMiddleware, async (req, res) => {
  try {
    const { lookupHash } = req.params;
    const { additionalPrefs = "" } = req.body;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    await streamJamieAssist(res, lookupHash, additionalPrefs);
  } catch (error) {
    console.error('Error in jamie-assist:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to generate promotional content', details: error.message });
    }
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// HMAC-only duplicate endpoint for service-to-service access
app.post('/api/internal/jamie-assist/:lookupHash', serviceHmac({ requiredScopes: ['svc:jamie:assist'] }), async (req, res) => {
  try {
    const { lookupHash } = req.params;
    const { additionalPrefs = "" } = req.body;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    await streamJamieAssist(res, lookupHash, additionalPrefs);
  } catch (error) {
    console.error('Error in internal jamie-assist:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to generate promotional content', details: error.message });
    }
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// Add back the getFullTranscriptJSON function after getTranscriptFromSpaces
const getFullTranscriptJSON = async (podGuid) => {
  const debugPrefix = `[SUBTITLE-DEBUG][${Date.now()}]`;
  console.log(`${debugPrefix} getFullTranscriptJSON START for guid: ${podGuid}`);
  
  if (!podGuid) {
    console.error(`${debugPrefix} Missing podGuid parameter in getFullTranscriptJSON`);
    throw new Error('Missing required parameter: podGuid');
  }
  
  try {
    const transcriptUrl = `https://cascdr-transcripts.nyc3.cdn.digitaloceanspaces.com/${podGuid}.json`;
    console.log(`${debugPrefix} Fetching transcript from URL: ${transcriptUrl}`);
    
    console.time(`${debugPrefix} Transcript-API-Call`);
    let response;
    try {
      response = await axios.get(transcriptUrl, {
        timeout: 10000, // 10 second timeout
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'JamieAgent/1.0'
        }
      });
      console.timeEnd(`${debugPrefix} Transcript-API-Call`);
    } catch (fetchError) {
      console.timeEnd(`${debugPrefix} Transcript-API-Call`);
      console.error(`${debugPrefix} 🔴 HTTP request failed: ${fetchError.message}`);
      
      if (fetchError.response) {
        // The request was made and the server responded with a status code
        console.error(`${debugPrefix} Response status: ${fetchError.response.status}`);
        console.error(`${debugPrefix} Response headers: ${JSON.stringify(fetchError.response.headers)}`);
      } else if (fetchError.request) {
        // The request was made but no response was received
        console.error(`${debugPrefix} No response received. Network error or timeout.`);
      }
      
      throw new Error(`Failed to fetch transcript: ${fetchError.message}`);
    }
    
    console.log(`${debugPrefix} Transcript API Response status: ${response.status}`);
    console.log(`${debugPrefix} Response headers: ${JSON.stringify(response.headers)}`);
    console.log(`${debugPrefix} Response size: ${
      typeof response.data === 'string' 
        ? `${response.data.length} characters` 
        : `${JSON.stringify(response.data).length} characters (JSON)`
    }`);
    
    // Check if response.data is already an object or a string that needs parsing
    let transcriptData;
    if (typeof response.data === 'string') {
      console.log(`${debugPrefix} Response is a string, attempting to parse JSON...`);
      try {
        transcriptData = JSON.parse(response.data);
        console.log(`${debugPrefix} Successfully parsed JSON string to object`);
      } catch (parseError) {
        console.error(`${debugPrefix} 🔴 Failed to parse transcript JSON: ${parseError.message}`);
        
        // Try to show a sample of the response to debug content issues
        const sampleLength = Math.min(response.data.length, 500);
        console.log(`${debugPrefix} First ${sampleLength} chars of response: ${response.data.substring(0, sampleLength)}...`);
        
        // Check for common issues
        if (response.data.includes('AccessDenied')) {
          console.error(`${debugPrefix} Response appears to contain an Access Denied error`);
        } else if (response.data.includes('<!DOCTYPE html>')) {
          console.error(`${debugPrefix} Response appears to be HTML, not JSON`);
        } else if (response.data.trim() === '') {
          console.error(`${debugPrefix} Response is an empty string`);
        }
        
        throw new Error(`Failed to parse transcript JSON: ${parseError.message}`);
      }
    } else {
      console.log(`${debugPrefix} Response is already an object, no parsing needed`);
      transcriptData = response.data;
    }
    
    // Validate transcript data structure
    console.log(`${debugPrefix} Validating transcript data structure...`);
    console.log(`${debugPrefix} Transcript data top-level keys: ${Object.keys(transcriptData || {}).join(', ')}`);
    
    if (!transcriptData) {
      console.error(`${debugPrefix} 🔴 Transcript data is null or undefined`);
      throw new Error('Invalid transcript data: null or undefined');
    }
    
    if (!transcriptData.results) {
      console.error(`${debugPrefix} 🔴 Invalid transcript data: missing 'results' property`);
      console.log(`${debugPrefix} Transcript structure: ${JSON.stringify(transcriptData).substring(0, 200)}...`);
      throw new Error('Invalid transcript data: missing results property');
    }
    
    // Validate results structure
    if (!transcriptData.results.channels || !Array.isArray(transcriptData.results.channels)) {
      console.error(`${debugPrefix} 🔴 Invalid transcript data: missing or invalid 'channels' array`);
      console.log(`${debugPrefix} Results keys: ${Object.keys(transcriptData.results).join(', ')}`);
      
      // Try to create a minimal valid structure to avoid null errors downstream
      transcriptData.results.channels = [];
      console.warn(`${debugPrefix} Created empty channels array to avoid null errors`);
    }
    
    // Log transcript metadata if available
    if (transcriptData.metadata) {
      console.log(`${debugPrefix} Transcript metadata: ${JSON.stringify(transcriptData.metadata)}`);
    }
    
    // Check for word count to validate content
    let wordCount = 0;
    if (transcriptData.results.channels && 
        transcriptData.results.channels[0] && 
        transcriptData.results.channels[0].alternatives && 
        transcriptData.results.channels[0].alternatives[0] &&
        Array.isArray(transcriptData.results.channels[0].alternatives[0].words)) {
      
      wordCount = transcriptData.results.channels[0].alternatives[0].words.length;
      console.log(`${debugPrefix} Transcript contains ${wordCount} words`);
      
      // Try to detect if the transcript might be incomplete
      const sampleWords = transcriptData.results.channels[0].alternatives[0].words.slice(0, 3);
      console.log(`${debugPrefix} Sample words: ${JSON.stringify(sampleWords)}`);
    } else {
      console.warn(`${debugPrefix} ⚠️ Transcript does not contain any words or has invalid structure`);
    }
    
    console.log(`${debugPrefix} getFullTranscriptJSON COMPLETE for guid: ${podGuid}`);
    return transcriptData;
  } catch (error) {
    console.error(`${debugPrefix} 🔥 Failed to fetch transcript for GUID ${podGuid}: ${error.message}`);
    console.error(`${debugPrefix} Stack trace: ${error.stack}`);
    throw error;
  }
};

/**
 * Gets word timestamps from a transcript, using the new spaces method first and falling back to HTTP
 */
const getWordTimestampsFromFullTranscriptJSON = async (guid, startTime, endTime) => {
  const debugPrefix = `[SUBTITLE-DEBUG][${Date.now()}]`;
  console.log(`${debugPrefix} getWordTimestampsFromFullTranscriptJSON START with guid: ${guid}, startTime: ${startTime}, endTime: ${endTime}`);
  
  if (!guid) {
    console.error(`${debugPrefix} Missing guid in getWordTimestampsFromFullTranscriptJSON`);
    throw new Error('Missing required parameter: guid');
  }
  
  // Validate time parameters
  if (startTime === undefined || endTime === undefined) {
    console.error(`${debugPrefix} Missing time parameters in getWordTimestampsFromFullTranscriptJSON`);
    throw new Error('Missing required time parameters');
  }
  
  if (startTime >= endTime) {
    console.error(`${debugPrefix} Invalid time range: startTime (${startTime}) >= endTime (${endTime})`);
    throw new Error(`Invalid time range: startTime (${startTime}) >= endTime (${endTime})`);
  }
  
  console.time(`${debugPrefix} GetTranscript-Total`);
  let transcriptJSON;
  
  try {
    // First try to get the transcript using the new Spaces method
    console.log(`${debugPrefix} Attempting to get transcript using Spaces method first`);
    try {
      console.time(`${debugPrefix} GetTranscript-Spaces`);
      const transcriptKey = `${guid}.json`;
      const fileBuffer = await transcriptSpacesManager.getFileAsBuffer(
        process.env.TRANSCRIPT_SPACES_BUCKET_NAME,
        transcriptKey
      );
      console.log(`${debugPrefix} Raw file size: ${fileBuffer.length} bytes`);
      
      const jsonString = fileBuffer.toString('utf-8');
      console.log(`${debugPrefix} JSON string length: ${jsonString.length} characters`);
      
      // Handle double-encoded JSON
      try {
        // First try parsing as regular JSON
        transcriptJSON = JSON.parse(jsonString);
        
        // If the result is a string and looks like JSON, parse it again
        if (typeof transcriptJSON === 'string' && 
            (transcriptJSON.trim().startsWith('{') || transcriptJSON.trim().startsWith('['))) {
          console.log(`${debugPrefix} Detected double-encoded JSON, parsing again`);
          transcriptJSON = JSON.parse(transcriptJSON);
        }
        
        console.log(`${debugPrefix} Successfully parsed JSON, top-level keys:`, Object.keys(transcriptJSON));
      } catch (parseError) {
        console.error(`${debugPrefix} Failed to parse JSON: ${parseError.message}`);
        throw parseError;
      }
      
      console.timeEnd(`${debugPrefix} GetTranscript-Spaces`);
      console.log(`${debugPrefix} Successfully retrieved transcript from Spaces`);
    } catch (spacesError) {
      // If Spaces method fails, fall back to the HTTP method
      console.timeEnd(`${debugPrefix} GetTranscript-Spaces`);
      console.warn(`${debugPrefix} ⚠️ Spaces method failed: ${spacesError.message}. Falling back to HTTP method.`);
      
      console.time(`${debugPrefix} GetTranscript-HTTP`);
      const transcriptUrl = `https://cascdr-transcripts.nyc3.cdn.digitaloceanspaces.com/${guid}.json`;
      const response = await axios.get(transcriptUrl);
      transcriptJSON = response.data;
      console.log(`${debugPrefix} Successfully retrieved transcript using fallback HTTP method`);
      console.timeEnd(`${debugPrefix} GetTranscript-HTTP`);
    }
    
    console.timeEnd(`${debugPrefix} GetTranscript-Total`);
    
    // Log the structure we received
    console.log(`${debugPrefix} Transcript structure:`, {
      topLevelKeys: Object.keys(transcriptJSON),
      hasChannels: !!transcriptJSON.channels,
      hasResults: !!transcriptJSON.results,
      hasResultsChannels: !!(transcriptJSON.results && transcriptJSON.results.channels)
    });
    
    // Handle different transcript formats
    let words = [];
    
    // Case 1: Direct channels format
    if (transcriptJSON.channels && transcriptJSON.channels[0] && transcriptJSON.channels[0].alternatives) {
      console.log(`${debugPrefix} Processing direct channels format transcript`);
      words = transcriptJSON.channels[0].alternatives[0].words || [];
    }
    // Case 2: Results format
    else if (transcriptJSON.results && transcriptJSON.results.channels && transcriptJSON.results.channels[0] && transcriptJSON.results.channels[0].alternatives) {
      console.log(`${debugPrefix} Processing results format transcript`);
      words = transcriptJSON.results.channels[0].alternatives[0].words || [];
    }
    else {
      console.error(`${debugPrefix} 🔴 Could not find words in any supported structure`);
      throw new Error('Could not find words in transcript structure');
    }
    
    console.log(`${debugPrefix} Found ${words.length} words in transcript`);
    
    // Log sample of words
    if (words.length > 0) {
      console.log(`${debugPrefix} Sample word structure:`, words[0]);
    }
    
    // Filter words by time range
    console.time(`${debugPrefix} WordFilter`);
    const filteredWords = words.filter(word => {
      const wordStart = parseFloat(word.start);
      return wordStart >= startTime && wordStart <= endTime;
    });
    console.timeEnd(`${debugPrefix} WordFilter`);
    
    console.log(`${debugPrefix} Filtered words count: ${filteredWords.length} (time range ${startTime}-${endTime})`);
    
    // Format the words for subtitles
    const subtitles = filteredWords.map(word => ({
      text: word.word,
      start: parseFloat(word.start),
      end: parseFloat(word.end),
      confidence: word.confidence || 0
    }));
    
    // Log sample of formatted subtitles
    if (subtitles.length > 0) {
      console.log(`${debugPrefix} Sample subtitle structure:`, subtitles[0]);
    }
    
    console.log(`${debugPrefix} getWordTimestampsFromFullTranscriptJSON COMPLETE`);
    return subtitles;
  } catch (error) {
    console.timeEnd(`${debugPrefix} GetTranscript-Total`);
    console.error(`${debugPrefix} 🔥 Error getting word timestamps: ${error.message}`);
    console.error(`${debugPrefix} Stack trace: ${error.stack}`);
    throw error;
  }
};

// Add the temporary endpoint for testing transcript retrieval
app.get('/api/test-transcript/:guid', async (req, res) => {
  const debugPrefix = `[TEST-TRANSCRIPT][${Date.now()}]`;
  const guid = req.params.guid;
  
  console.log(`${debugPrefix} Testing transcript retrieval for GUID: ${guid}`);
  
  if (!guid) {
    console.error(`${debugPrefix} Missing GUID parameter`);
    return res.status(400).json({ error: 'Missing required parameter: guid' });
  }
  
  try {
    console.time(`${debugPrefix} SpacesMethod`);
    console.log(`${debugPrefix} Attempting to retrieve transcript using Spaces method`);
    
    // Get the transcript object without validation
    let transcriptData;
    try {
      // Use transcriptSpacesManager to get raw file
      const transcriptKey = `${guid}.json`;
      const fileBuffer = await transcriptSpacesManager.getFileAsBuffer(
        process.env.TRANSCRIPT_SPACES_BUCKET_NAME,
        transcriptKey
      );
      
      // Parse the JSON
      const jsonString = fileBuffer.toString('utf-8');
      transcriptData = JSON.parse(jsonString);
      
      // Log success and return complete data
      console.log(`${debugPrefix} Successfully retrieved transcript data`);
      console.log(`${debugPrefix} Top-level keys: ${Object.keys(transcriptData || {}).join(', ')}`);
      
      // Return the complete transcript data
      return res.json({
        success: true,
        method: 'spaces',
        guid,
        transcript: transcriptData,
        rawStructure: {
          hasResults: !!transcriptData.results,
          hasChannels: !!transcriptData.channels,
          hasResultsChannels: !!(transcriptData.results && transcriptData.results.channels),
          topLevelKeys: Object.keys(transcriptData)
        }
      });
    } catch (error) {
      console.error(`${debugPrefix} Error retrieving transcript data: ${error.message}`);
      return res.status(500).json({
        success: false,
        error: error.message,
        guid
      });
    }
  } catch (error) {
    console.error(`${debugPrefix} Outer error in test endpoint: ${error.message}`);
    res.status(500).json({ 
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// ====================================================
// TEMPORARY TEST ENDPOINTS - REMOVE BEFORE PRODUCTION
// These endpoints are for debugging transcript processing
// ====================================================

/**
 * Test endpoint to get raw transcript data
 * @route GET /api/debug/raw-transcript/:guid
 * @description Returns the completely raw transcript data as received from storage
 * @access Private
 * @param {string} guid - The podcast GUID
 * @returns {Object} Raw transcript data
 */
app.get('/api/debug/raw-transcript/:guid', async (req, res) => {
  const debugPrefix = `[DEBUG-RAW-TRANSCRIPT][${Date.now()}]`;
  const guid = req.params.guid;
  
  console.log(`${debugPrefix} Testing raw transcript retrieval for GUID: ${guid}`);
  
  if (!guid) {
    console.error(`${debugPrefix} Missing GUID parameter`);
    return res.status(400).json({ error: 'Missing required parameter: guid' });
  }
  
  try {
    // Get raw transcript data from Spaces
    const transcriptKey = `${guid}.json`;
    const fileBuffer = await transcriptSpacesManager.getFileAsBuffer(
      process.env.TRANSCRIPT_SPACES_BUCKET_NAME,
      transcriptKey
    );
    
    // Parse the JSON
    const jsonString = fileBuffer.toString('utf-8');
    const transcriptData = JSON.parse(jsonString);
    
    // Return the complete raw data with metadata about its structure
    return res.json({
      success: true,
      guid,
      rawData: transcriptData,
      structureInfo: {
        topLevelKeys: Object.keys(transcriptData),
        hasResults: !!transcriptData.results,
        hasChannels: !!transcriptData.channels,
        hasResultsChannels: !!(transcriptData.results && transcriptData.results.channels),
        fileSize: fileBuffer.length,
        jsonStringLength: jsonString.length
      }
    });
  } catch (error) {
    console.error(`${debugPrefix} Error retrieving raw transcript: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: error.message,
      guid
    });
  }
});

/**
 * Test endpoint to get formatted transcript data
 * @route GET /api/debug/formatted-transcript/:guid
 * @description Returns the transcript data after initial formatting
 * @access Private
 * @param {string} guid - The podcast GUID
 * @returns {Object} Formatted transcript data
 */
app.get('/api/debug/formatted-transcript/:guid', async (req, res) => {
  const debugPrefix = `[DEBUG-FORMATTED-TRANSCRIPT][${Date.now()}]`;
  const guid = req.params.guid;
  
  console.log(`${debugPrefix} Testing formatted transcript retrieval for GUID: ${guid}`);
  
  if (!guid) {
    console.error(`${debugPrefix} Missing GUID parameter`);
    return res.status(400).json({ error: 'Missing required parameter: guid' });
  }
  
  try {
    // Get raw transcript data
    const transcriptKey = `${guid}.json`;
    const fileBuffer = await transcriptSpacesManager.getFileAsBuffer(
      process.env.TRANSCRIPT_SPACES_BUCKET_NAME,
      transcriptKey
    );
    
    // Parse the JSON
    const jsonString = fileBuffer.toString('utf-8');
    const rawData = JSON.parse(jsonString);
    
    // Apply formatting
    const formattedData = formatTranscriptData(rawData);
    
    // Return both raw and formatted data for comparison
    return res.json({
      success: true,
      guid,
      rawData,
      formattedData,
      structureInfo: {
        rawTopLevelKeys: Object.keys(rawData),
        formattedTopLevelKeys: formattedData ? Object.keys(formattedData) : [],
        hasWords: !!(formattedData?.results?.channels?.[0]?.alternatives?.[0]?.words),
        wordCount: formattedData?.results?.channels?.[0]?.alternatives?.[0]?.words?.length || 0
      }
    });
  } catch (error) {
    console.error(`${debugPrefix} Error processing transcript: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: error.message,
      guid
    });
  }
});

/**
 * Debug endpoint for subtitle generation
 * @route GET /api/debug/subtitles/:guid
 * @description Returns detailed debug information about subtitle generation
 * @access Private
 * @param {string} guid - The podcast GUID
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @returns {Object} Debug information about subtitle generation
 */
app.get('/api/debug/subtitles/:guid', async (req, res) => {
  const debugPrefix = `[DEBUG-SUBTITLES][${Date.now()}]`;
  const { guid } = req.params;
  const startTime = parseFloat(req.query.startTime) || 0;
  const endTime = parseFloat(req.query.endTime) || 60;
  
  console.log(`${debugPrefix} Starting subtitle debug for GUID: ${guid}, time range: ${startTime}-${endTime}s`);
  
  try {
    // Step 1: Get raw transcript data
    console.log(`${debugPrefix} Step 1: Getting raw transcript data`);
    const transcriptKey = `${guid}.json`;
    const fileBuffer = await transcriptSpacesManager.getFileAsBuffer(
      process.env.TRANSCRIPT_SPACES_BUCKET_NAME,
      transcriptKey
    );
    console.log(`${debugPrefix} Raw file size: ${fileBuffer.length} bytes`);
    
    // Step 2: Parse JSON
    console.log(`${debugPrefix} Step 2: Parsing JSON`);
    const jsonString = fileBuffer.toString('utf-8');
    const rawData = JSON.parse(jsonString);
    console.log(`${debugPrefix} Raw data structure:`, {
      topLevelKeys: Object.keys(rawData),
      hasChannels: !!rawData.channels,
      hasResults: !!rawData.results,
      hasResultsChannels: !!(rawData.results && rawData.results.channels)
    });
    
    // Step 3: Extract words
    console.log(`${debugPrefix} Step 3: Extracting words`);
    let words = [];
    if (rawData.channels && rawData.channels[0] && rawData.channels[0].alternatives) {
      words = rawData.channels[0].alternatives[0].words || [];
    } else if (rawData.results && rawData.results.channels && rawData.results.channels[0] && rawData.results.channels[0].alternatives) {
      words = rawData.results.channels[0].alternatives[0].words || [];
    }
    console.log(`${debugPrefix} Found ${words.length} words in transcript`);
    
    // Step 4: Filter words by time range
    console.log(`${debugPrefix} Step 4: Filtering words by time range ${startTime}-${endTime}s`);
    const filteredWords = words.filter(word => {
      const wordStart = parseFloat(word.start);
      return wordStart >= startTime && wordStart <= endTime;
    });
    console.log(`${debugPrefix} Filtered to ${filteredWords.length} words in time range`);
    
    // Step 5: Format subtitles
    console.log(`${debugPrefix} Step 5: Formatting subtitles`);
    const subtitles = filteredWords.map(word => ({
      text: word.word,
      start: parseFloat(word.start),
      end: parseFloat(word.end),
      confidence: word.confidence || 0
    }));
    
    // Return detailed debug information
    return res.json({
      success: true,
      guid,
      timeRange: { startTime, endTime },
      rawDataStructure: {
        topLevelKeys: Object.keys(rawData),
        hasChannels: !!rawData.channels,
        hasResults: !!rawData.results,
        hasResultsChannels: !!(rawData.results && rawData.results.channels)
      },
      wordCounts: {
        total: words.length,
        filtered: filteredWords.length
      },
      sampleWords: words.slice(0, 5),
      sampleFilteredWords: filteredWords.slice(0, 5),
      subtitles: subtitles.slice(0, 5), // Return first 5 subtitles as sample
      fullSubtitles: subtitles // Return all subtitles
    });
    
  } catch (error) {
    console.error(`${debugPrefix} Error in subtitle debug: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
      guid
    });
  }
});

// Add this new debug endpoint to print raw transcript content
app.get('/api/debug/raw-transcript-content/:guid', async (req, res) => {
  const debugPrefix = `[DEBUG-RAW-CONTENT][${Date.now()}]`;
  const guid = req.params.guid;
  
  console.log(`${debugPrefix} Printing raw transcript content for GUID: ${guid}`);
  
  if (!guid) {
    console.error(`${debugPrefix} Missing GUID parameter`);
    return res.status(400).json({ error: 'Missing required parameter: guid' });
  }
  
  try {
    // Get raw transcript data from Spaces
    const transcriptKey = `${guid}.json`;
    const fileBuffer = await transcriptSpacesManager.getFileAsBuffer(
      process.env.TRANSCRIPT_SPACES_BUCKET_NAME,
      transcriptKey
    );
    
    // Get the raw string content
    const jsonString = fileBuffer.toString('utf-8');
    
    // Print first 100 characters to console
    console.log(`${debugPrefix} First 100 characters of transcript:`);
    console.log(jsonString.substring(0, 100));
    
    // Try to parse the JSON
    let parsedData;
    try {
      parsedData = JSON.parse(jsonString);
      console.log(`${debugPrefix} Successfully parsed JSON`);
    } catch (parseError) {
      console.error(`${debugPrefix} Failed to parse JSON: ${parseError.message}`);
      parsedData = null;
    }
    
    // Return the complete data
    return res.json({
      success: true,
      guid,
      first100Chars: jsonString.substring(0, 100),
      fileSize: fileBuffer.length,
      isJson: jsonString.trim().startsWith('{') || jsonString.trim().startsWith('['),
      parseError: parsedData === null ? 'Failed to parse JSON' : null,
      parsedData: parsedData ? Object.keys(parsedData).slice(0, 5) : null
    });
  } catch (error) {
    console.error(`${debugPrefix} Error retrieving transcript content: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: error.message,
      guid
    });
  }
});

// Add a debug endpoint to trigger the ingestor manually (only in debug mode)
if (DEBUG_MODE) {
  app.post('/api/debug/trigger-ingestor', async (req, res) => {
    try {
      const jobId = `manual-job-${Date.now()}`;
      console.log(`[DEBUG] Manually triggering ingestor with job ID: ${jobId}`);
      
      const result = await callIngestor(jobId);
      
      res.json({
        success: true,
        message: 'Ingestor triggered successfully',
        jobId,
        result
      });
    } catch (error) {
      console.error('Error triggering ingestor:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Simple debug endpoint to validate HMAC auth end-to-end
  app.post('/api/debug/test-hmac', serviceHmac({ requiredScopes: ['svc:test'] }), (req, res) => {
    res.json({
      ok: true,
      method: req.method,
      path: req.path,
      keyId: req.serviceAuth?.keyId || null,
      scopes: req.serviceAuth?.scopes || [],
      echo: req.body || null
    });
  });
    
  
  // Debug endpoint to monitor video processing statistics
  app.get('/api/debug/clip-processing-stats', (req, res) => {
    try {
      const stats = clipUtils.getProcessingStats();
      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        stats
      });
    } catch (error) {
      console.error('Error getting clip processing stats:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Add a debug endpoint to manually trigger garbage collection
  app.post('/api/debug/trigger-gc', async (req, res) => {
    try {
      console.log(`[DEBUG] Manually triggering garbage collection`);
      
      // Get the garbage collector instance
      const garbageCollector = new GarbageCollector();
      await garbageCollector.runCleanup();
      
      res.json({
        success: true,
        message: 'Garbage collection triggered successfully',
        status: garbageCollector.getStatus()
      });
    } catch (error) {
      console.error('Error triggering garbage collection:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
  
  // Add a debug endpoint to check garbage collector status
  app.get('/api/debug/gc-status', (req, res) => {
    try {
      const garbageCollector = new GarbageCollector();
      res.json({
        success: true,
        status: garbageCollector.getStatus()
      });
    } catch (error) {
      console.error('Error getting garbage collector status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Debug endpoint: show DB connection info and current user's jamieAssistDefaults
  app.get('/api/debug/db-info', async (req, res) => {
    try {
      const conn = mongoose.connection;
      const info = {
        host: conn.host,
        port: conn.port,
        name: conn.name,
        readyState: conn.readyState
      };

      let prefs = null;
      try {
        const authHeader = req.headers.authorization || '';
        if (authHeader.startsWith('Bearer ')) {
          const token = authHeader.split(' ')[1];
          const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
          const { User } = require('./models/User');
          const user = await User.findOne({ email: decoded.email })
            .read('primary')
            .select('+app_preferences')
            .lean();
          prefs = {
            email: decoded.email,
            jamieAssistDefaults: user?.app_preferences?.data?.jamieAssistDefaults ?? null,
            schemaVersion: user?.app_preferences?.schemaVersion ?? null
          };
        }
      } catch (_) {}

      res.json({ connection: info, userPreferences: prefs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Debug endpoint: list all user docs matching token email and their jamieAssistDefaults
  app.get('/api/debug/user-docs', async (req, res) => {
    try {
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing token' });
      }
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
      const { User } = require('./models/User');
      const docs = await User.find({ email: decoded.email })
        .read('primary')
        .select('+app_preferences email')
        .lean();
      const simplified = docs.map(d => ({
        _id: d._id,
        email: d.email,
        jamieAssistDefaults: d?.app_preferences?.data?.jamieAssistDefaults ?? null,
        schemaVersion: d?.app_preferences?.schemaVersion ?? null
      }));
      res.json({ count: simplified.length, docs: simplified });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Debug endpoint: get the most recent Nostr post with full URL details
  app.get('/api/debug/latest-nostr-post', async (req, res) => {
    try {
      const SocialPost = require('./models/SocialPost');
      
      // Get the most recent posted Nostr post
      const latestPost = await SocialPost.findOne({
        platform: 'nostr',
        status: 'posted'
      })
      .sort({ postedAt: -1 })
      .lean();

      if (!latestPost) {
        return res.status(404).json({ 
          error: 'No posted Nostr posts found' 
        });
      }

      // Extract the URL details
      const urlDetails = {
        fullUrl: latestPost.platformData?.nostrPostUrl,
        urlLength: latestPost.platformData?.nostrPostUrl?.length || 0,
        isTruncated: latestPost.platformData?.nostrPostUrl?.endsWith('...') || false,
        eventId: latestPost.platformData?.nostrEventId,
        eventIdLength: latestPost.platformData?.nostrEventId?.length || 0
      };

      res.json({
        success: true,
        post: {
          _id: latestPost._id,
          adminEmail: latestPost.adminEmail,
          status: latestPost.status,
          postedAt: latestPost.postedAt,
          content: latestPost.content,
          platformData: latestPost.platformData
        },
        urlAnalysis: urlDetails,
        message: 'Latest posted Nostr post retrieved successfully'
      });

    } catch (error) {
      console.error('Error fetching latest Nostr post:', error);
      res.status(500).json({ 
        error: 'Failed to fetch latest Nostr post',
        details: error.message 
      });
    }
  });
}



