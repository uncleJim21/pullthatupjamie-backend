const express = require('express');
const router = express.Router();
const { TwitterApi } = require('twitter-api-v2');
const { updateTwitterTokens, getTwitterTokens, getProPodcastByAdminEmail } = require('../utils/ProPodcastUtils');
const { validatePrivs } = require('../middleware/validate-privs');
const jwt = require('jsonwebtoken');

// Get the port from environment variables
const PORT = process.env.PORT || 4132;

// Temporary in-memory store for OAuth state
const oauthStateStore = new Map();

/**
 * GET/POST /api/twitter/x-oauth
 * Initiate Twitter OAuth flow
 */
router.all('/x-oauth', async (req, res) => {
    try {
        // Get token from either Authorization header or request body
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith('Bearer ') 
            ? authHeader.split(' ')[1]
            : req.body?.token;

        if (!token) {
            return res.status(401).json({ 
                error: 'Not authenticated',
                message: 'Bearer token required'
            });
        }

        // Verify the JWT token
        const decoded = jwt.verify(token, process.env.CASCDR_AUTH_SECRET);
        
        // Get the podcast details using the email from the token
        const podcast = await getProPodcastByAdminEmail(decoded.email);
        
        if (!podcast) {
            return res.status(401).json({ 
                error: 'Not authorized',
                message: 'No podcast found for this admin email'
            });
        }

        // Log the request details
        console.log('OAuth Initiation:', {
            headers: req.headers,
            cookies: req.cookies,
            sessionID: req.sessionID,
            hasSession: !!req.session,
            port: PORT,
            session: req.session,
            userAgent: req.headers['user-agent']
        });

        const client = new TwitterApi({
            clientId: process.env.TWITTER_CLIENT_ID,
            clientSecret: process.env.TWITTER_CLIENT_SECRET,
        });

        // Log the callback URL being used
        const callbackUrl = process.env.TWITTER_CALLBACK_URL || `http://localhost:${PORT}/api/twitter/callback`;
        console.log('Using callback URL:', callbackUrl);

        const { url, codeVerifier, state } = await client.generateOAuth2AuthLink(
            callbackUrl,
            { 
                scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'],
                codeChallengeMethod: 'S256'
            }
        );

        // Store OAuth state in both session and temporary store
        const oauthData = {
            codeVerifier,
            state,
            timestamp: Date.now(),
            adminEmail: decoded.email // Store admin email in OAuth state
        };
        
        // Store in session
        req.session.twitterOAuth = oauthData;
        
        // Store in temporary store with state as key
        oauthStateStore.set(state, oauthData);

        // Force session save before sending response
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ 
                    error: 'Failed to save session',
                    details: err.message 
                });
            }

            // Set cookie explicitly with all required options
            res.cookie('connect.sid', req.sessionID, {
                httpOnly: true,
                secure: false,
                sameSite: 'lax',
                domain: 'localhost',
                path: '/',
                maxAge: 24 * 60 * 60 * 1000 // 24 hours
            });

            // If the request is from curl or has a JSON content type, return JSON response
            if (req.headers['user-agent']?.includes('curl') || req.headers['content-type']?.includes('application/json')) {
                return res.json({ 
                    success: true,
                    authUrl: url,
                    sessionID: req.sessionID,
                    state: state,
                    cookie: {
                        name: 'connect.sid',
                        value: req.sessionID,
                        options: {
                            httpOnly: true,
                            secure: false,
                            sameSite: 'lax',
                            domain: 'localhost',
                            path: '/',
                            maxAge: 24 * 60 * 60 * 1000
                        }
                    }
                });
            }

            // For browser requests, redirect directly to the auth URL
            res.redirect(url);
        });
    } catch (error) {
        console.error('Twitter auth error:', error);
        res.status(500).json({ 
            error: 'Failed to initialize Twitter auth',
            details: error.message 
        });
    }
});

/**
 * GET /api/twitter/callback
 * Handle Twitter OAuth callback
 */
router.get('/callback', async (req, res) => {
    try {
        // Log the callback request details
        console.log('Callback Request:', {
            query: req.query,
            headers: req.headers,
            cookies: req.cookies,
            sessionID: req.sessionID,
            hasSession: !!req.session,
            fullSession: req.session,
            userAgent: req.headers['user-agent']
        });

        const { code, state } = req.query;
        
        // Debug session state
        console.log('Session state in callback:', {
            hasTwitterOAuth: !!req.session.twitterOAuth,
            sessionState: req.session.twitterOAuth?.state,
            receivedState: state,
            sessionTimestamp: req.session.twitterOAuth?.timestamp,
            sessionID: req.sessionID,
            fullSession: req.session,
            cookies: req.cookies
        });
        
        // Try to get OAuth state from temporary store first
        const oauthData = oauthStateStore.get(state);
        
        if (!oauthData) {
            console.error('No OAuth state found in temporary store');
            return res.status(400).json({ 
                error: 'No OAuth state found in session',
                debug: {
                    hasSession: !!req.session,
                    sessionID: req.sessionID,
                    cookies: req.cookies,
                    userAgent: req.headers['user-agent']
                }
            });
        }

        // Verify state matches
        if (state !== oauthData.state) {
            console.error('State mismatch:', {
                storedState: oauthData.state,
                receivedState: state,
                sessionID: req.sessionID,
                hasSession: !!req.session,
                cookies: req.cookies
            });
            return res.status(400).json({ 
                error: 'Invalid state parameter',
                debug: {
                    hasSession: !!req.session,
                    sessionID: req.sessionID,
                    receivedState: state,
                    storedState: oauthData.state,
                    cookies: req.cookies
                }
            });
        }

        // Create a new client for token exchange
        const client = new TwitterApi({
            clientId: process.env.TWITTER_CLIENT_ID,
            clientSecret: process.env.TWITTER_CLIENT_SECRET,
        });

        // Exchange code for tokens
        const { accessToken, refreshToken, expiresIn } = await client.loginWithOAuth2({
            code,
            codeVerifier: oauthData.codeVerifier,
            redirectUri: process.env.TWITTER_CALLBACK_URL || `http://localhost:${PORT}/api/twitter/callback`
        });

        // Create a new client with the access token to get user info
        const userClient = new TwitterApi(accessToken);
        const user = await userClient.v2.me();

        // Store tokens in ProPodcastDetails using admin email from OAuth state
        if (oauthData.adminEmail) {
            await updateTwitterTokens(oauthData.adminEmail, {
                oauthToken: accessToken,
                oauthTokenSecret: refreshToken,
                twitterId: user.data.id,
                twitterUsername: user.data.username
            });
        }

        // Store tokens in session for backward compatibility
        req.session.twitterTokens = {
            accessToken,
            refreshToken,
            expiresAt: Date.now() + (expiresIn * 1000),
            twitterId: user.data.id,
            twitterUsername: user.data.username
        };

        // Clean up the temporary store
        oauthStateStore.delete(state);

        // Save session before redirecting
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ 
                    error: 'Failed to save session',
                    details: err.message 
                });
            }

            // Redirect to success page with correct path
            res.redirect('/api/twitter/auth-success');
        });
    } catch (error) {
        console.error('Twitter callback error:', error);
        res.status(500).json({ 
            error: 'Failed to complete Twitter authentication',
            details: error.message 
        });
    }
});

/**
 * GET /api/twitter/auth-success
 * Success page after Twitter OAuth
 */
router.get('/auth-success', (req, res) => {
    if (!req.session.twitterTokens) {
        return res.status(400).send('No Twitter tokens found. Please try the OAuth flow again.');
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Twitter Auth Success</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    max-width: 800px;
                    margin: 0 auto;
                    padding: 20px;
                    line-height: 1.6;
                }
                .success-message {
                    background-color: #e8f5e9;
                    border: 1px solid #c8e6c9;
                    border-radius: 4px;
                    padding: 20px;
                    margin: 20px 0;
                }
                .token-info {
                    background-color: #f5f5f5;
                    border: 1px solid #e0e0e0;
                    border-radius: 4px;
                    padding: 20px;
                    margin: 20px 0;
                    word-break: break-all;
                }
                .action-section {
                    background-color: #e3f2fd;
                    border: 1px solid #bbdefb;
                    border-radius: 4px;
                    padding: 20px;
                    margin: 20px 0;
                }
                button {
                    background-color: #1da1f2;
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 16px;
                }
                button:hover {
                    background-color: #1991da;
                }
                #result {
                    margin-top: 20px;
                    padding: 10px;
                    border-radius: 4px;
                }
                .success {
                    background-color: #e8f5e9;
                    border: 1px solid #c8e6c9;
                }
                .error {
                    background-color: #ffebee;
                    border: 1px solid #ffcdd2;
                }
                .tweet-input {
                    width: 100%;
                    padding: 10px;
                    margin: 10px 0;
                    border: 1px solid #e0e0e0;
                    border-radius: 4px;
                    font-size: 16px;
                }
                .tweet-input:focus {
                    outline: none;
                    border-color: #1da1f2;
                }
            </style>
        </head>
        <body>
            <h1>Twitter Authentication Successful!</h1>
            <div class="success-message">
                <h2>✅ Successfully connected to Twitter</h2>
                <p>Your Twitter account has been successfully connected. You can now close this page.</p>
            </div>
            <div class="token-info">
                <h3>Token Information:</h3>
                <p><strong>User ID:</strong> ${req.session.twitterTokens.twitterId}</p>
                <p><strong>Expires At:</strong> ${new Date(req.session.twitterTokens.expiresAt).toLocaleString()}</p>
            </div>
            <div class="action-section">
                <h3>Post a Tweet</h3>
                <input type="text" id="tweetText" class="tweet-input" placeholder="What's happening?" value="Hello World!">
                <button onclick="postTweet()">Post Tweet</button>
                <div id="result"></div>
            </div>

            <script>
                async function postTweet() {
                    const resultDiv = document.getElementById('result');
                    const tweetText = document.getElementById('tweetText').value;
                    
                    if (!tweetText) {
                        resultDiv.innerHTML = '<h4>❌ Error</h4><p>Please enter some text for your tweet</p>';
                        resultDiv.className = 'error';
                        return;
                    }
                    
                    resultDiv.innerHTML = 'Posting tweet...';
                    resultDiv.className = '';
                    
                    try {
                        const response = await fetch('/api/twitter/tweet', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ text: tweetText })
                        });
                        
                        const data = await response.json();
                        
                        if (response.ok) {
                            resultDiv.innerHTML = \`
                                <h4>✅ Tweet Posted Successfully!</h4>
                                <p>Check your Twitter profile to see the tweet.</p>
                                <p><strong>Tweet ID:</strong> \${data.tweet.id}</p>
                            \`;
                            resultDiv.className = 'success';
                        } else {
                            resultDiv.innerHTML = \`
                                <h4>❌ Error Posting Tweet</h4>
                                <p>\${data.message || data.error}</p>
                            \`;
                            resultDiv.className = 'error';
                        }
                    } catch (error) {
                        resultDiv.innerHTML = \`
                            <h4>❌ Error</h4>
                            <p>\${error.message}</p>
                        \`;
                        resultDiv.className = 'error';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

/**
 * GET/POST /api/twitter/oauth1-auth
 * Initiate Twitter OAuth 1.0a flow for media uploads
 */
router.all('/oauth1-auth', validatePrivs, async (req, res) => {
    try {
        console.log('Starting OAuth 1.0a flow...');
        console.log('Environment check:', {
            hasConsumerKey: !!process.env.TWITTER_CONSUMER_KEY,
            hasConsumerSecret: !!process.env.TWITTER_CONSUMER_SECRET,
            consumerKeyPrefix: process.env.TWITTER_CONSUMER_KEY?.substring(0, 10) + '...',
        });

        // Create OAuth 1.0a client
        const client = new TwitterApi({
            appKey: process.env.TWITTER_CONSUMER_KEY,
            appSecret: process.env.TWITTER_CONSUMER_SECRET,
        });

        const callbackUrl = process.env.TWITTER_CALLBACK_URL?.replace('/callback', '/oauth1-callback') || 
                           `http://localhost:${PORT}/api/twitter/oauth1-callback`;
        
        console.log('Starting OAuth 1.0a flow with callback:', callbackUrl);

        try {
            // Generate OAuth 1.0a auth link
            const authLink = await client.generateAuthLink(callbackUrl, { linkMode: 'authorize' });
            
            console.log('OAuth 1.0a auth link generated successfully');
            
            // Store OAuth state with admin email
            const oauthData = {
                oauth_token: authLink.oauth_token,
                oauth_token_secret: authLink.oauth_token_secret,
                timestamp: Date.now(),
                adminEmail: req.user.adminEmail
            };
            
            // Store in temporary store
            oauthStateStore.set(authLink.oauth_token, oauthData);

            console.log('OAuth 1.0a auth link generated:', authLink.url);

            // Return the auth URL
            res.json({
                success: true,
                authUrl: authLink.url,
                oauth_token: authLink.oauth_token,
                message: 'Please visit the auth URL to authorize media upload permissions'
            });

        } catch (authError) {
            console.error('OAuth 1.0a auth link generation failed:', {
                message: authError.message,
                code: authError.code,
                data: authError.data,
                stack: authError.stack
            });
            throw authError;
        }

    } catch (error) {
        console.error('OAuth 1.0a auth error:', error);
        res.status(500).json({
            error: 'Failed to initialize OAuth 1.0a auth',
            details: error.message,
            debug: {
                hasConsumerKey: !!process.env.TWITTER_CONSUMER_KEY,
                hasConsumerSecret: !!process.env.TWITTER_CONSUMER_SECRET,
                errorCode: error.code
            }
        });
    }
});

/**
 * GET /api/twitter/oauth1-callback
 * Handle Twitter OAuth 1.0a callback for media uploads
 */
router.get('/oauth1-callback', async (req, res) => {
    try {
        const { oauth_token, oauth_verifier } = req.query;
        
        console.log('OAuth 1.0a callback:', { oauth_token, oauth_verifier });

        // Get stored OAuth data
        const oauthData = oauthStateStore.get(oauth_token);
        if (!oauthData) {
            return res.status(400).json({
                error: 'Invalid OAuth state',
                message: 'OAuth token not found or expired'
            });
        }

        // Create client with request tokens
        const client = new TwitterApi({
            appKey: process.env.TWITTER_CONSUMER_KEY,
            appSecret: process.env.TWITTER_CONSUMER_SECRET,
            accessToken: oauth_token,
            accessSecret: oauthData.oauth_token_secret,
        });

        // Exchange for access tokens
        const { client: loggedClient, accessToken, accessSecret } = await client.login(oauth_verifier);
        
        // Get user info
        const user = await loggedClient.v1.verifyCredentials();
        
        console.log('OAuth 1.0a login successful for user:', user.screen_name);

        // Update database with OAuth 1.0a tokens (alongside existing OAuth 2.0 tokens)
        const existingTokens = await getTwitterTokens(oauthData.adminEmail);
        await updateTwitterTokens(oauthData.adminEmail, {
            ...existingTokens, // Keep existing OAuth 2.0 tokens
            oauth1AccessToken: accessToken,      // Add OAuth 1.0a tokens
            oauth1AccessSecret: accessSecret,
            oauth1TwitterId: user.id_str,
            oauth1TwitterUsername: user.screen_name
        });

        // Clean up temporary store
        oauthStateStore.delete(oauth_token);

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Media Upload Authorization Success</title>
                <style>
                    body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
                    .success { background-color: #e8f5e9; border: 1px solid #c8e6c9; border-radius: 4px; padding: 20px; margin: 20px 0; }
                </style>
            </head>
            <body>
                <h1>Media Upload Authorization Successful!</h1>
                <div class="success">
                    <h2>✅ Successfully authorized media uploads</h2>
                    <p>Your Twitter account <strong>@${user.screen_name}</strong> is now authorized for media uploads.</p>
                    <p>You can now close this page and try uploading media to your tweets.</p>
                </div>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('OAuth 1.0a callback error:', error);
        res.status(500).json({
            error: 'Failed to complete OAuth 1.0a authentication',
            details: error.message
        });
    }
});

/**
 * Upload media using OAuth 1.0a (required for media uploads)
 */
async function uploadMediaWithOAuth1a(buffer, contentType, tokens) {
    console.log('Starting OAuth 1.0a media upload...', {
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
        
        console.log('Uploading media with OAuth 1.0a...');
        
        // Use the built-in chunked upload method with OAuth 1.0a
        const mediaId = await oauth1Client.v1.uploadMedia(buffer, {
            mimeType: contentType,
            chunkLength: 5 * 1024 * 1024, // 5MB chunks
            target: 'tweet',
            additionalOwners: undefined,
            maxConcurrentUploads: 1,
            shared: false
        });
        
        console.log('OAuth 1.0a media upload successful, media ID:', mediaId);
        return mediaId;
    } catch (error) {
        console.error('OAuth 1.0a media upload error:', {
            message: error.message,
            code: error.code,
            data: error.data,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * POST /api/twitter/tweet
 * Post a tweet using stored tokens
 */
router.post('/tweet', validatePrivs, async (req, res) => {
    try {
        // Get tokens from database
        const tokens = await getTwitterTokens(req.user.adminEmail);
        if (!tokens) {
            return res.status(401).json({ 
                error: 'Not authenticated',
                message: 'Please complete Twitter OAuth first'
            });
        }

        // Get tweet text and media URL from request body
        const { text, mediaUrl } = req.body;
        if (!text) {
            return res.status(400).json({
                error: 'Missing text',
                message: 'Please provide tweet text'
            });
        }

        // Create Twitter client with stored access token
        const client = new TwitterApi(tokens.oauthToken);

        // Test the token by making a simple API call first
        try {
            console.log('Testing token validity...');
            const testUser = await client.v2.me();
            console.log('Token is valid for user:', testUser.data.username);
        } catch (tokenError) {
            console.error('Token validation failed:', tokenError);
            return res.status(401).json({
                error: 'Invalid or expired Twitter token',
                message: 'Please re-authenticate with Twitter',
                details: tokenError.message
            });
        }

        let mediaIds = [];
        
        // Upload media to Twitter if provided
        if (mediaUrl) {
            try {
                console.log('Downloading media from URL:', mediaUrl);
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
                console.log('Media content type:', contentType);
                
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                console.log('Media buffer size:', buffer.length, 'bytes');
                
                console.log('Uploading media to Twitter using OAuth 1.0a...');
                
                // Use OAuth 1.0a for media uploads (required for media uploads)
                const mediaId = await uploadMediaWithOAuth1a(buffer, contentType, tokens);
                mediaIds.push(mediaId);
                
                console.log('Media upload successful, media ID:', mediaId);
            } catch (error) {
                console.error('Media upload error details:', {
                    message: error.message,
                    code: error.code,
                    data: error.data,
                    stack: error.stack
                });
                throw new Error(`Failed to upload media to Twitter: ${error.message}`);
            }
        }

        // Post the tweet with media if available
        const tweetPayload = {
            text
        };

        if (mediaIds.length > 0) {
            tweetPayload.media = {
                media_ids: mediaIds
            };
        }

        console.log('Posting tweet with payload:', tweetPayload);
        const tweet = await client.v2.tweet(tweetPayload);

        res.json({
            success: true,
            message: 'Tweet posted successfully',
            tweet: tweet.data
        });
    } catch (error) {
        console.error('Error posting tweet:', error);
        res.status(500).json({ 
            error: 'Failed to post tweet',
            details: error.message
        });
    }
});

/**
 * POST /api/twitter/tokens
 * Get Twitter token status for the authenticated podcast
 */
router.post('/tokens', validatePrivs, async (req, res) => {
    try {
        const tokens = await getTwitterTokens(req.user.adminEmail);
        if (!tokens) {
            return res.json({ authenticated: false });
        }
        res.json({ 
            authenticated: true,
            twitterId: tokens.twitterId,
            twitterUsername: tokens.twitterUsername,
            hasOAuth1Tokens: !!(tokens.oauth1AccessToken && tokens.oauth1AccessSecret)
        });
    } catch (error) {
        console.error('Error getting Twitter tokens:', error);
        res.status(500).json({ error: 'Failed to get Twitter tokens' });
    }
});

module.exports = router; 