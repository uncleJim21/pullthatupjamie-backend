const express = require('express');
const router = express.Router();
const {
  getEpisodeByGuid,
  getParagraphWithEpisodeData,
  getFeedById,
  getParagraphWithFeedData,
  getTextForTimeRange
} = require('../agent-tools/pineconeTools.js');

// Twitter-related imports for test endpoints
const { TwitterApi } = require('twitter-api-v2');
const { getTwitterTokens, updateTwitterTokens } = require('../utils/ProPodcastUtils');
const { validatePrivs } = require('../middleware/validate-privs');

// Upload media using OAuth 1.0a (required for media uploads)
async function uploadMediaWithOAuth1a(buffer, contentType, tokens) {
    console.log('[DEBUG] Starting OAuth 1.0a media upload...', {
        totalBytes: buffer.length,
        contentType
    });

    try {
        // Check if we have OAuth 1.0a tokens
        if (!tokens.oauth1AccessToken || !tokens.oauth1AccessSecret) {
            throw new Error('OAuth 1.0a tokens not found. Please authorize media uploads first via /api/twitter/oauth1-auth');
        }

        // Create OAuth 1.0a client using proper OAuth 1.0a tokens
        const oauth1Client = new TwitterApi({
            appKey: process.env.TWITTER_CONSUMER_KEY,
            appSecret: process.env.TWITTER_CONSUMER_SECRET,
            accessToken: tokens.oauth1AccessToken,    // Real OAuth 1.0a access token
            accessSecret: tokens.oauth1AccessSecret,  // Real OAuth 1.0a access secret
        });
        
        console.log('[DEBUG] Uploading media with OAuth 1.0a...');
        
        // Use the built-in chunked upload method with OAuth 1.0a
        const mediaId = await oauth1Client.v1.uploadMedia(buffer, {
            mimeType: contentType,
            chunkLength: 5 * 1024 * 1024, // 5MB chunks
            target: 'tweet',
            additionalOwners: undefined,
            maxConcurrentUploads: 1,
            shared: false
        });
        
        console.log('[DEBUG] OAuth 1.0a media upload successful, media ID:', mediaId);
        return mediaId;
    } catch (error) {
        console.error('[DEBUG] OAuth 1.0a media upload error:', {
            message: error.message,
            code: error.code,
            data: error.data,
            stack: error.stack
        });
        throw error;
    }
}

// Debug endpoint for episode retrieval
router.get('/episode/:guid', async (req, res) => {
  try {
    const { guid } = req.params;
    console.log(`[DEBUG] Fetching episode data for GUID: ${guid}`);
    
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

// Debug endpoint for paragraph with episode data
router.get('/paragraph-with-episode/:paragraphId', async (req, res) => {
  try {
    const { paragraphId } = req.params;
    console.log(`[DEBUG] Fetching paragraph with episode data for ID: ${paragraphId}`);
    
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

// Debug endpoint for feed retrieval
router.get('/feed/:feedId', async (req, res) => {
  try {
    const { feedId } = req.params;
    console.log(`[DEBUG] Fetching feed data for feedId: ${feedId}`);
    
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

// Debug endpoint for paragraph with feed data
router.get('/paragraph-with-feed/:paragraphId', async (req, res) => {
  try {
    const { paragraphId } = req.params;
    console.log(`[DEBUG] Fetching paragraph with feed data for ID: ${paragraphId}`);
    
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

// Add this new endpoint to debugRoutes.js
router.get('/text-for-timerange/:guid/:startTime/:endTime', async (req, res) => {
  try {
    const { guid, startTime, endTime } = req.params;
    console.log(`[DEBUG] Fetching text for GUID: ${guid}, time range: ${startTime}-${endTime}`);
    
    const text = await getTextForTimeRange(
      guid, 
      parseFloat(startTime), 
      parseFloat(endTime)
    );
    
    if (!text) {
      return res.status(404).json({ 
        error: 'No text found for the specified time range',
        guid,
        startTime,
        endTime
      });
    }

    res.json({ text });
  } catch (error) {
    console.error('Error fetching text for time range:', error);
    res.status(500).json({ 
      error: 'Failed to fetch text for time range',
      details: error.message,
      guid: req.params.guid,
      startTime: req.params.startTime,
      endTime: req.params.endTime
    });
  }
});

/**
 * POST /api/debug/twitter/test-auth
 * Test different authentication methods to diagnose 403 errors
 */
router.post('/twitter/test-auth', validatePrivs, async (req, res) => {
    try {
        // Get tokens from database
        const tokens = await getTwitterTokens(req.user.adminEmail);
        if (!tokens) {
            return res.status(401).json({ 
                error: 'Not authenticated',
                message: 'Please complete Twitter OAuth first'
            });
        }

        const results = {
            oauth2Tests: {},
            diagnostics: {
                hasTokens: !!tokens,
                tokenFields: Object.keys(tokens || {}),
                environment: {
                    hasClientId: !!process.env.TWITTER_CLIENT_ID,
                    hasClientSecret: !!process.env.TWITTER_CLIENT_SECRET,
                    hasConsumerKey: !!process.env.TWITTER_CONSUMER_KEY,
                    hasConsumerSecret: !!process.env.TWITTER_CONSUMER_SECRET
                }
            }
        };

        // Test OAuth 2.0 token
        try {
            console.log('[DEBUG] Testing OAuth 2.0 authentication...');
            const client = new TwitterApi(tokens.oauthToken);
            
            // Test basic user info
            const user = await client.v2.me();
            results.oauth2Tests.userInfo = {
                success: true,
                username: user.data.username,
                id: user.data.id
            };

            // Test posting a simple tweet (without media)
            try {
                const testTweet = await client.v2.tweet({
                    text: '[DEBUG] Test tweet from API - ' + new Date().toISOString()
                });
                results.oauth2Tests.simpleTweet = {
                    success: true,
                    tweetId: testTweet.data.id
                };
            } catch (tweetError) {
                results.oauth2Tests.simpleTweet = {
                    success: false,
                    error: tweetError.message,
                    code: tweetError.code
                };
            }

        } catch (oauth2Error) {
            results.oauth2Tests.error = {
                message: oauth2Error.message,
                code: oauth2Error.code
            };
        }

        // Check if we have OAuth 1.0a credentials available
        if (process.env.TWITTER_CONSUMER_KEY && process.env.TWITTER_CONSUMER_SECRET) {
            try {
                console.log('[DEBUG] OAuth 1.0a credentials detected, but we need user tokens...');
                results.oauth1Available = true;
                results.note = 'OAuth 1.0a credentials available but user authentication needed';
            } catch (oauth1Error) {
                results.oauth1Available = false;
                results.oauth1Error = oauth1Error.message;
            }
        } else {
            results.oauth1Available = false;
            results.note = 'No OAuth 1.0a credentials configured';
        }

        res.json({
            success: true,
            message: 'Authentication diagnostics completed',
            results
        });

    } catch (error) {
        console.error('[DEBUG] Error in auth diagnostics:', error);
        res.status(500).json({ 
            error: 'Failed to run diagnostics',
            details: error.message
        });
    }
});

/**
 * POST /api/debug/twitter/test-media-upload
 * Test media upload with different approaches
 */
router.post('/twitter/test-media-upload', validatePrivs, async (req, res) => {
    try {
        // Get tokens from database
        const tokens = await getTwitterTokens(req.user.adminEmail);
        if (!tokens) {
            return res.status(401).json({ 
                error: 'Not authenticated',
                message: 'Please complete Twitter OAuth first'
            });
        }

        const { mediaUrl } = req.body;
        if (!mediaUrl) {
            return res.status(400).json({
                error: 'Missing mediaUrl',
                message: 'Please provide a media URL to test'
            });
        }

        const results = {
            tokenInfo: {
                hasOAuth2Token: !!tokens.oauthToken,
                hasOAuth1Token: !!tokens.oauth1AccessToken,
                tokenFieldsAvailable: Object.keys(tokens)
            },
            tests: []
        };

        // Download the media first
        console.log('[DEBUG] Downloading media from URL:', mediaUrl);
        const response = await fetch(mediaUrl, {
            headers: {
                'Accept': '*/*',
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
        }
        
        const contentType = response.headers.get('content-type') || 'video/mp4';
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        console.log('[DEBUG] Media downloaded:', {
            contentType,
            size: buffer.length
        });

        // Test 1: OAuth 2.0 with standard approach
        try {
            console.log('[DEBUG] Test 1: OAuth 2.0 standard upload...');
            const client = new TwitterApi(tokens.oauthToken);
            
            const mediaId = await client.v1.uploadMedia(buffer, {
                mimeType: contentType,
                chunkLength: 5 * 1024 * 1024,
                target: 'tweet'
            });
            
            results.tests.push({
                method: 'OAuth 2.0 Standard',
                success: true,
                mediaId: mediaId
            });
            
        } catch (error) {
            results.tests.push({
                method: 'OAuth 2.0 Standard',
                success: false,
                error: error.message,
                code: error.code
            });
        }

        // Test 2: Try OAuth 1.0a media upload (the correct method!)
        if (tokens.oauth1AccessToken && tokens.oauth1AccessSecret) {
            try {
                console.log('[DEBUG] Test 2: OAuth 1.0a media upload...');
                
                const mediaId = await uploadMediaWithOAuth1a(buffer, contentType, tokens);
                
                results.tests.push({
                    method: 'OAuth 1.0a Media Upload',
                    success: true,
                    mediaId: mediaId,
                    size: buffer.length
                });
                
            } catch (error) {
                results.tests.push({
                    method: 'OAuth 1.0a Media Upload',
                    success: false,
                    error: error.message,
                    code: error.code,
                    data: error.data
                });
            }
        } else {
            results.tests.push({
                method: 'OAuth 1.0a Media Upload',
                success: false,
                error: 'OAuth 1.0a tokens not available',
                note: 'Complete OAuth 1.0a authorization first via /api/twitter/oauth1-auth'
            });
        }

        res.json({
            success: true,
            message: 'Media upload tests completed',
            results
        });

    } catch (error) {
        console.error('[DEBUG] Test media upload error:', error);
        res.status(500).json({
            error: 'Failed to test media upload',
            details: error.message
        });
    }
});

/**
 * POST /api/debug/twitter/clear-tokens
 * Clear stored Twitter tokens (useful for re-authentication with new scopes)
 */
router.post('/twitter/clear-tokens', validatePrivs, async (req, res) => {
    try {
        // Clear tokens from database by setting them to null
        await updateTwitterTokens(req.user.adminEmail, {
            oauthToken: null,
            oauthTokenSecret: null,
            twitterId: null,
            twitterUsername: null,
            oauth1AccessToken: null,
            oauth1AccessSecret: null,
            oauth1TwitterId: null,
            oauth1TwitterUsername: null
        });

        res.json({
            success: true,
            message: 'Twitter tokens cleared successfully. You can now re-authenticate with updated permissions.'
        });
    } catch (error) {
        console.error('[DEBUG] Error clearing Twitter tokens:', error);
        res.status(500).json({ 
            error: 'Failed to clear Twitter tokens',
            details: error.message
        });
    }
});

module.exports = router; 