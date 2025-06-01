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
 * Upload media using chunked upload (required for videos)
 */
async function uploadMediaChunked(client, buffer, contentType) {
    console.log('Starting chunked upload...', {
        totalBytes: buffer.length,
        contentType
    });

    try {
        // Use the built-in chunked upload method from twitter-api-v2
        console.log('Uploading media using built-in chunked upload...');
        
        const mediaId = await client.v1.uploadMedia(buffer, {
            mimeType: contentType,
            chunkLength: 5 * 1024 * 1024, // 5MB chunks
            target: 'tweet',
            additionalOwners: undefined,
            maxConcurrentUploads: 1,
            shared: false
        });
        
        console.log('Media upload successful, media ID:', mediaId);
        return mediaId;
    } catch (error) {
        console.error('Chunked upload error:', {
            message: error.message,
            code: error.code,
            data: error.data,
            stack: error.stack
        });
        throw error;
    }
}

/**
 * Upload media using X API v1.1 with OAuth 2.0 (trying the working approach)
 * Uses the v1.1 chunked upload process but with OAuth 2.0 authentication
 */
async function uploadMediaV2(accessToken, buffer, contentType) {
    console.log('Starting X API v1.1 media upload with OAuth 2.0...', {
        totalBytes: buffer.length,
        contentType
    });

    try {
        // Use the correct v1.1 endpoint with OAuth 2.0
        const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';
        
        // Step 1: INIT - Initialize the upload
        console.log('Step 1: Initializing media upload...');
        
        const initFormData = new FormData();
        initFormData.append('command', 'INIT');
        initFormData.append('media_type', contentType);
        initFormData.append('total_bytes', buffer.length.toString());
        
        // Set media category based on content type
        if (contentType.startsWith('video/')) {
            initFormData.append('media_category', 'tweet_video');
        } else if (contentType.startsWith('image/')) {
            initFormData.append('media_category', 'tweet_image');
        }

        const initResponse = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            },
            body: initFormData
        });

        if (!initResponse.ok) {
            const errorText = await initResponse.text();
            throw new Error(`INIT failed: ${initResponse.status} ${initResponse.statusText} - ${errorText}`);
        }

        const initData = await initResponse.json();
        console.log('INIT response:', initData);
        
        const mediaId = initData.media_id_string;
        const chunkSize = 5 * 1024 * 1024; // 5MB chunks
        const totalChunks = Math.ceil(buffer.length / chunkSize);

        // Step 2: APPEND - Upload chunks
        console.log(`Step 2: Uploading ${totalChunks} chunks...`);
        
        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, buffer.length);
            const chunk = buffer.slice(start, end);
            
            console.log(`Uploading chunk ${i + 1}/${totalChunks} (${chunk.length} bytes)`);
            
            const appendFormData = new FormData();
            appendFormData.append('command', 'APPEND');
            appendFormData.append('media_id', mediaId);
            appendFormData.append('segment_index', i.toString());
            appendFormData.append('media', new Blob([chunk], { type: 'application/octet-stream' }));

            const appendResponse = await fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                },
                body: appendFormData
            });

            if (!appendResponse.ok) {
                const errorText = await appendResponse.text();
                throw new Error(`APPEND chunk ${i} failed: ${appendResponse.status} ${appendResponse.statusText} - ${errorText}`);
            }
            
            console.log(`Chunk ${i + 1}/${totalChunks} uploaded successfully`);
        }

        // Step 3: FINALIZE - Complete the upload
        console.log('Step 3: Finalizing media upload...');
        
        const finalizeFormData = new FormData();
        finalizeFormData.append('command', 'FINALIZE');
        finalizeFormData.append('media_id', mediaId);

        const finalizeResponse = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            },
            body: finalizeFormData
        });

        if (!finalizeResponse.ok) {
            const errorText = await finalizeResponse.text();
            throw new Error(`FINALIZE failed: ${finalizeResponse.status} ${finalizeResponse.statusText} - ${errorText}`);
        }

        const finalizeData = await finalizeResponse.json();
        console.log('FINALIZE response:', finalizeData);

        // Step 4: STATUS - Check processing status if needed
        if (finalizeData.processing_info) {
            console.log('Step 4: Checking processing status...');
            
            let processingComplete = false;
            let maxRetries = 60; // Maximum wait time of 60 seconds
            
            while (!processingComplete && maxRetries > 0) {
                const statusResponse = await fetch(`${uploadUrl}?command=STATUS&media_id=${mediaId}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                });

                if (!statusResponse.ok) {
                    const errorText = await statusResponse.text();
                    throw new Error(`STATUS check failed: ${statusResponse.status} ${statusResponse.statusText} - ${errorText}`);
                }

                const statusData = await statusResponse.json();
                console.log('STATUS response:', statusData);

                if (statusData.processing_info) {
                    const state = statusData.processing_info.state;
                    
                    if (state === 'succeeded') {
                        processingComplete = true;
                        console.log('Media processing completed successfully');
                    } else if (state === 'failed') {
                        throw new Error('Media processing failed');
                    } else {
                        // Still processing, wait and retry
                        console.log(`Media processing state: ${state}, waiting...`);
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
                        maxRetries--;
                    }
                } else {
                    // No processing_info means it's ready
                    processingComplete = true;
                    console.log('Media is ready (no processing required)');
                }
            }

            if (!processingComplete) {
                throw new Error('Media processing timed out');
            }
        }

        console.log('X API v1.1 media upload with OAuth 2.0 successful, media ID:', mediaId);
        return mediaId;
        
    } catch (error) {
        console.error('X API v1.1 media upload with OAuth 2.0 error:', {
            message: error.message,
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
            twitterUsername: tokens.twitterUsername
        });
    } catch (error) {
        console.error('Error getting Twitter tokens:', error);
        res.status(500).json({ error: 'Failed to get Twitter tokens' });
    }
});

/**
 * POST /api/twitter/test-auth
 * Test different authentication methods to diagnose 403 errors
 */
router.post('/test-auth', validatePrivs, async (req, res) => {
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
            console.log('Testing OAuth 2.0 authentication...');
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
                    text: 'Test tweet from API - ' + new Date().toISOString()
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
                console.log('OAuth 1.0a credentials detected, but we need user tokens...');
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
        console.error('Error in auth diagnostics:', error);
        res.status(500).json({ 
            error: 'Failed to run diagnostics',
            details: error.message
        });
    }
});

/**
 * POST /api/twitter/test-media-upload
 * Test media upload with different approaches
 */
router.post('/test-media-upload', validatePrivs, async (req, res) => {
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
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        console.log('Media downloaded:', {
            contentType,
            size: buffer.length
        });

        // Test 1: OAuth 2.0 with standard approach
        try {
            console.log('Test 1: OAuth 2.0 standard upload...');
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

        // Test 2: OAuth 2.0 with Bearer token (if different)
        try {
            console.log('Test 2: OAuth 2.0 Bearer token approach...');
            const bearerClient = new TwitterApi(tokens.oauthToken);
            
            // Try simple upload first
            const mediaId = await bearerClient.v1.uploadMedia(buffer, {
                mimeType: contentType,
                type: contentType.startsWith('video/') ? 'video' : 'image'
            });
            
            results.tests.push({
                method: 'OAuth 2.0 Bearer Simple',
                success: true,
                mediaId: mediaId
            });
            
        } catch (error) {
            results.tests.push({
                method: 'OAuth 2.0 Bearer Simple',
                success: false,
                error: error.message,
                code: error.code,
                data: error.data
            });
        }

        // Test 3: Try different upload options
        try {
            console.log('Test 3: OAuth 2.0 with different options...');
            const client = new TwitterApi(tokens.oauthToken);
            
            const mediaId = await client.v1.uploadMedia(buffer, {
                mimeType: contentType,
                // Remove chunkLength to see if that's causing issues
                target: 'tweet',
                shared: false
            });
            
            results.tests.push({
                method: 'OAuth 2.0 No Chunking',
                success: true,
                mediaId: mediaId
            });
            
        } catch (error) {
            results.tests.push({
                method: 'OAuth 2.0 No Chunking',
                success: false,
                error: error.message,
                code: error.code,
                data: error.data,
                headers: error.headers
            });
        }

        // Test 4: Try manual approach with fetch
        try {
            console.log('Test 4: Manual fetch approach...');
            
            // Convert buffer to base64 for manual upload
            const base64Data = buffer.toString('base64');
            
            const uploadResponse = await fetch('https://upload.twitter.com/1.1/media/upload.json', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + tokens.oauthToken,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    'media_data': base64Data,
                    'media_category': contentType.startsWith('video/') ? 'tweet_video' : 'tweet_image'
                })
            });

            if (uploadResponse.ok) {
                const uploadResult = await uploadResponse.json();
                results.tests.push({
                    method: 'Manual Fetch Upload',
                    success: true,
                    mediaId: uploadResult.media_id_string
                });
            } else {
                const errorText = await uploadResponse.text();
                results.tests.push({
                    method: 'Manual Fetch Upload',
                    success: false,
                    error: 'HTTP ' + uploadResponse.status + ': ' + errorText,
                    code: uploadResponse.status,
                    headers: Object.fromEntries(uploadResponse.headers.entries())
                });
            }
            
        } catch (error) {
            results.tests.push({
                method: 'Manual Fetch Upload',
                success: false,
                error: error.message
            });
        }

        // Test 5: Check token permissions by verifying credentials
        try {
            console.log('Test 5: Checking token permissions...');
            const client = new TwitterApi(tokens.oauthToken);
            
            // Try to get user with detailed fields to see permissions
            const user = await client.v2.me({
                'user.fields': 'public_metrics'
            });
            
            results.tests.push({
                method: 'Token Permissions Check',
                success: true,
                userInfo: {
                    id: user.data.id,
                    username: user.data.username,
                    publicMetrics: user.data.public_metrics
                }
            });
            
        } catch (error) {
            results.tests.push({
                method: 'Token Permissions Check',
                success: false,
                error: error.message,
                code: error.code
            });
        }

        // Test 6: Try OAuth 1.0a media upload (the correct method!)
        if (tokens.oauth1AccessToken && tokens.oauth1AccessSecret) {
            try {
                console.log('Test 6: OAuth 1.0a media upload...');
                
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
        console.error('Test media upload error:', error);
        res.status(500).json({
            error: 'Failed to test media upload',
            details: error.message
        });
    }
});

/**
 * POST /api/twitter/test-v2-media-upload
 * Test the new X API v2 media upload endpoints
 */
router.post('/test-v2-media-upload', validatePrivs, async (req, res) => {
    try {
        // Get tokens from database
        const tokens = await getTwitterTokens(req.user.adminEmail);
        if (!tokens) {
            return res.status(401).json({ 
                error: 'Not authenticated',
                message: 'Please complete Twitter OAuth first'
            });
        }

        console.log('Testing X API v2 media upload...');
        
        // Test with the same video URL that was failing before
        const mediaUrl = 'https://cascdr-chads-stay-winning.nyc3.cdn.digitaloceanspaces.com/AXOSgpT7LRXs-5oD.mp4';
        
        console.log('Downloading test video from URL:', mediaUrl);
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
        
        console.log('Testing X API v2 media upload with OAuth 2.0...');
        
        // Use the new X API v2 media upload
        const mediaId = await uploadMediaV2(tokens.oauthToken, buffer, contentType);
        
        console.log('X API v2 media upload successful! Media ID:', mediaId);

        res.json({
            success: true,
            message: 'X API v2 media upload test successful',
            mediaId: mediaId,
            videoSize: buffer.length,
            contentType: contentType
        });
        
    } catch (error) {
        console.error('X API v2 media upload test error:', {
            message: error.message,
            stack: error.stack
        });
        
        res.status(500).json({
            error: 'X API v2 media upload test failed',
            details: error.message
        });
    }
});

/**
 * POST /api/twitter/clear-tokens
 * Clear stored Twitter tokens (useful for re-authentication with new scopes)
 */
router.post('/clear-tokens', validatePrivs, async (req, res) => {
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
        console.error('Error clearing Twitter tokens:', error);
        res.status(500).json({ 
            error: 'Failed to clear Twitter tokens',
            details: error.message
        });
    }
});

/**
 * POST /api/twitter/test-simple-upload
 * Test simple media upload approaches to diagnose the issue
 */
router.post('/test-simple-upload', validatePrivs, async (req, res) => {
    try {
        // Get tokens from database
        const tokens = await getTwitterTokens(req.user.adminEmail);
        if (!tokens) {
            return res.status(401).json({ 
                error: 'Not authenticated',
                message: 'Please complete Twitter OAuth first'
            });
        }

        console.log('Testing simple media upload approaches...');
        
        const results = [];

        // Test 1: Try with a small image first (PNG)
        try {
            console.log('Test 1: Simple image upload...');
            
            // Download a small test image
            const imageUrl = 'https://httpbin.org/image/png';
            const imageResponse = await fetch(imageUrl);
            const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
            
            console.log('Test image downloaded:', {
                size: imageBuffer.length,
                contentType: 'image/png'
            });

            // Use twitter-api-v2 library directly
            const client = new TwitterApi(tokens.oauthToken);
            const mediaId = await client.v1.uploadMedia(imageBuffer, {
                mimeType: 'image/png',
                target: 'tweet'
            });
            
            results.push({
                test: 'Simple Image Upload (twitter-api-v2)',
                success: true,
                mediaId: mediaId,
                size: imageBuffer.length
            });
            
        } catch (error) {
            results.push({
                test: 'Simple Image Upload (twitter-api-v2)',
                success: false,
                error: error.message,
                code: error.code,
                data: error.data
            });
        }

        // Test 2: Try manual base64 upload for image
        try {
            console.log('Test 2: Manual base64 image upload...');
            
            // Create a small base64 test image (1x1 PNG)
            const smallPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
            
            const uploadResponse = await fetch('https://upload.twitter.com/1.1/media/upload.json', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${tokens.oauthToken}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    'media_data': smallPngBase64,
                    'media_category': 'tweet_image'
                })
            });

            if (uploadResponse.ok) {
                const uploadResult = await uploadResponse.json();
                results.push({
                    test: 'Manual Base64 Image Upload',
                    success: true,
                    mediaId: uploadResult.media_id_string
                });
            } else {
                const errorText = await uploadResponse.text();
                results.push({
                    test: 'Manual Base64 Image Upload',
                    success: false,
                    error: 'HTTP ' + uploadResponse.status + ': ' + errorText,
                    code: uploadResponse.status,
                    headers: Object.fromEntries(uploadResponse.headers.entries())
                });
            }
            
        } catch (error) {
            results.push({
                test: 'Manual Base64 Image Upload',
                success: false,
                error: error.message
            });
        }

        // Test 3: Try downloading and uploading the original video with twitter-api-v2
        try {
            console.log('Test 3: Video upload with twitter-api-v2...');
            
            const videoUrl = 'https://cascdr-chads-stay-winning.nyc3.cdn.digitaloceanspaces.com/AXOSgpT7LRXs-5oD.mp4';
            const videoResponse = await fetch(videoUrl);
            const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
            
            console.log('Video downloaded:', {
                size: videoBuffer.length,
                contentType: 'video/mp4'
            });

            // Use twitter-api-v2 library directly for chunked upload
            const client = new TwitterApi(tokens.oauthToken);
            const mediaId = await client.v1.uploadMedia(videoBuffer, {
                mimeType: 'video/mp4',
                target: 'tweet',
                shared: false
            });
            
            results.push({
                test: 'Video Upload (twitter-api-v2)',
                success: true,
                mediaId: mediaId,
                size: videoBuffer.length
            });
            
        } catch (error) {
            results.push({
                test: 'Video Upload (twitter-api-v2)',
                success: false,
                error: error.message,
                code: error.code,
                data: error.data,
                rateLimit: error.rateLimit
            });
        }

        res.json({
            success: true,
            message: 'Simple upload tests completed',
            results: results,
            tokenInfo: {
                hasOAuth2Token: !!tokens.oauthToken,
                tokenLength: tokens.oauthToken?.length
            }
        });

    } catch (error) {
        console.error('Simple upload test error:', error);
        res.status(500).json({
            error: 'Failed to run simple upload tests',
            details: error.message
        });
    }
});

module.exports = router; 