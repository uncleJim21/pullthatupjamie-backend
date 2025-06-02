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
 * Refresh Twitter OAuth 2.0 token using stored refresh token
 */
async function refreshTwitterToken(adminEmail, currentRefreshToken) {
    try {
        console.log('Attempting to refresh Twitter OAuth 2.0 token...');
        
        const client = new TwitterApi({
            clientId: process.env.TWITTER_CLIENT_ID,
            clientSecret: process.env.TWITTER_CLIENT_SECRET,
        });

        // Use the refresh token to get a new access token
        const { accessToken, refreshToken, expiresIn } = await client.refreshOAuth2Token(currentRefreshToken);
        
        console.log('Twitter token refresh successful');
        
        // Get existing tokens to preserve OAuth 1.0a tokens
        const existingTokens = await getTwitterTokens(adminEmail);
        
        // Update database with new OAuth 2.0 tokens while preserving OAuth 1.0a tokens
        await updateTwitterTokens(adminEmail, {
            ...existingTokens, // Keep existing OAuth 1.0a tokens
            oauthToken: accessToken,
            oauthTokenSecret: refreshToken || currentRefreshToken, // Use new refresh token if provided
            expiresAt: Date.now() + (expiresIn * 1000) // Calculate new expiration
        });

        console.log('Database updated with refreshed tokens');
        return accessToken;
        
    } catch (error) {
        console.error('Token refresh failed:', {
            message: error.message,
            code: error.code,
            data: error.data
        });
        throw error;
    }
}

/**
 * Execute operation with automatic token refresh on 401 errors
 */
async function executeWithTokenRefresh(adminEmail, operation) {
    try {
        // First attempt with current token
        return await operation();
    } catch (error) {
        // Check if it's an authentication/authorization error
        const isAuthError = error.code === 401 || 
                           error.status === 401 ||
                           error.message?.includes('401') ||
                           error.message?.includes('Unauthorized') ||
                           error.message?.includes('Invalid or expired');

        if (isAuthError) {
            console.log('Authentication error detected, attempting token refresh...');
            
            try {
                // Get current tokens
                const tokens = await getTwitterTokens(adminEmail);
                if (!tokens?.oauthTokenSecret) {
                    console.log('No refresh token available for token refresh');
                    throw new Error('REFRESH_TOKEN_UNAVAILABLE');
                }

                // Attempt token refresh
                const newAccessToken = await refreshTwitterToken(adminEmail, tokens.oauthTokenSecret);
                
                // Retry the operation with refreshed token
                console.log('Token refreshed successfully, retrying operation...');
                return await operation(newAccessToken);
                
            } catch (refreshError) {
                console.error('Token refresh failed:', refreshError.message);
                
                // Throw a specific error that indicates re-authentication is needed
                const authError = new Error('Twitter authentication has expired and could not be refreshed. Please re-authenticate.');
                authError.code = 'TWITTER_AUTH_EXPIRED';
                authError.requiresReauth = true;
                authError.originalError = error.message;
                throw authError;
            }
        }
        
        // If it's not an auth error, just throw the original error
        throw error;
    }
}

/**
 * GET/POST /api/twitter/x-oauth
 * Initiate unified Twitter OAuth flow (OAuth 2.0 + OAuth 1.0a)
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

        console.log('Starting unified Twitter OAuth flow for:', decoded.email);

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
            adminEmail: decoded.email,
            flowType: 'unified' // Flag to indicate this should chain to OAuth 1.0a
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
                    message: 'Complete Twitter authorization to enable tweet posting and media uploads',
                    permissions: {
                        textTweets: 'Post tweets on your behalf',
                        mediaUploads: 'Upload images and videos to your tweets',
                        readProfile: 'Read your basic profile information'
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
 * Handle Twitter OAuth callback and chain to OAuth 1.0a if needed
 */
router.get('/callback', async (req, res) => {
    try {
        console.log('OAuth 2.0 callback received');

        const { code, state } = req.query;
        
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
            console.error('State mismatch');
            return res.status(400).json({ 
                error: 'Invalid state parameter'
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

        console.log('OAuth 2.0 tokens obtained for user:', user.data.username);

        // Store OAuth 2.0 tokens in ProPodcastDetails using the correct schema structure
        if (oauthData.adminEmail) {
            const existingTokens = await getTwitterTokens(oauthData.adminEmail) || {};
            
            await updateTwitterTokens(oauthData.adminEmail, {
                ...existingTokens, // Preserve any existing OAuth 1.0a tokens
                oauthToken: accessToken,
                oauthTokenSecret: refreshToken,
                twitterId: user.data.id,
                twitterUsername: user.data.username,
                expiresAt: Date.now() + (expiresIn * 1000)
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

        // Clean up the OAuth 2.0 temporary store
        oauthStateStore.delete(state);

        // Check if this is a unified flow that should chain to OAuth 1.0a
        if (oauthData.flowType === 'unified') {
            console.log('Unified flow detected, chaining to OAuth 1.0a...');
            
            try {
                // Create OAuth 1.0a client
                const oauth1Client = new TwitterApi({
                    appKey: process.env.TWITTER_CONSUMER_KEY,
                    appSecret: process.env.TWITTER_CONSUMER_SECRET,
                });

                const callbackUrl = process.env.TWITTER_CALLBACK_URL?.replace('/callback', '/oauth1-callback') || 
                                   `http://localhost:${PORT}/api/twitter/oauth1-callback`;
                
                // Generate OAuth 1.0a auth link
                const authLink = await oauth1Client.generateAuthLink(callbackUrl, { linkMode: 'authorize' });
                
                // Store OAuth 1.0a state
                const oauth1Data = {
                    oauth_token: authLink.oauth_token,
                    oauth_token_secret: authLink.oauth_token_secret,
                    timestamp: Date.now(),
                    adminEmail: oauthData.adminEmail,
                    fromUnifiedFlow: true
                };
                
                oauthStateStore.set(authLink.oauth_token, oauth1Data);

                console.log('Redirecting to OAuth 1.0a authorization...');
                
                // Redirect to OAuth 1.0a flow
                return res.redirect(authLink.url);
                
            } catch (oauth1Error) {
                console.error('Failed to initiate OAuth 1.0a flow:', oauth1Error);
                // Fall back to success page with OAuth 2.0 only
                return res.redirect('/api/twitter/auth-success?partial=true');
            }
        }

        // Save session before redirecting (for non-unified flows)
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ 
                    error: 'Failed to save session',
                    details: err.message 
                });
            }

            // Redirect to success page
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
 * Enhanced success page after Twitter OAuth with clear capability information
 */
router.get('/auth-success', async (req, res) => {
    // Check if this is a partial success (OAuth 2.0 only)
    const isPartial = req.query.partial === 'true';
    
    // Get session tokens or use defaults for display
    const sessionTokens = req.session.twitterTokens;
    
    if (!sessionTokens && !isPartial) {
        return res.status(400).send('No Twitter tokens found. Please try the OAuth flow again.');
    }

    const username = sessionTokens?.twitterUsername || 'your account';
    const userId = sessionTokens?.twitterId || '';
    const expiresAt = sessionTokens?.expiresAt;

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Twitter Authorization ${isPartial ? 'Partial' : 'Complete'}</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    max-width: 800px;
                    margin: 0 auto;
                    padding: 20px;
                    line-height: 1.6;
                    background: #f5f5f5;
                }
                .container {
                    background: white;
                    border-radius: 12px;
                    padding: 40px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                }
                .header {
                    text-align: center;
                    margin-bottom: 30px;
                }
                .success-icon {
                    font-size: 48px;
                    color: #1d9bf0;
                    margin-bottom: 20px;
                }
                .partial-icon {
                    font-size: 48px;
                    color: #f7931a;
                    margin-bottom: 20px;
                }
                h1 {
                    color: #14171a;
                    margin-bottom: 10px;
                }
                .subtitle {
                    color: #657786;
                    font-size: 18px;
                    margin-bottom: 30px;
                }
                .capabilities {
                    background: #f7f9fa;
                    border-radius: 8px;
                    padding: 20px;
                    margin: 20px 0;
                }
                .capability-item {
                    display: flex;
                    align-items: center;
                    margin: 10px 0;
                    color: #14171a;
                }
                .capability-enabled::before {
                    content: "✅";
                    margin-right: 10px;
                }
                .capability-disabled::before {
                    content: "❌";
                    margin-right: 10px;
                }
                .warning-box {
                    background: #fff3cd;
                    border: 1px solid #ffeaa7;
                    border-radius: 8px;
                    padding: 20px;
                    margin: 20px 0;
                }
                .action-section {
                    background: #e3f2fd;
                    border: 1px solid #bbdefb;
                    border-radius: 8px;
                    padding: 20px;
                    margin: 20px 0;
                }
                button {
                    background-color: #1da1f2;
                    color: white;
                    border: none;
                    padding: 12px 24px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 16px;
                    margin: 5px;
                }
                button:hover {
                    background-color: #1991da;
                }
                .secondary-button {
                    background-color: #f7931a;
                }
                .secondary-button:hover {
                    background-color: #e8851f;
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
                    padding: 12px;
                    margin: 10px 0;
                    border: 1px solid #e0e0e0;
                    border-radius: 6px;
                    font-size: 16px;
                    resize: vertical;
                    min-height: 80px;
                }
                .tweet-input:focus {
                    outline: none;
                    border-color: #1da1f2;
                }
                .token-info {
                    font-size: 14px;
                    color: #657786;
                    margin-top: 20px;
                    padding-top: 20px;
                    border-top: 1px solid #e1e8ed;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div class="${isPartial ? 'partial-icon' : 'success-icon'}">${isPartial ? '⚠️' : '🎉'}</div>
                    <h1>${isPartial ? 'Partial Twitter Authorization' : 'Twitter Integration Complete!'}</h1>
                    <p class="subtitle">Connected as <strong>@${username}</strong></p>
                </div>

                <div class="capabilities">
                    <h3>Current Capabilities:</h3>
                    <div class="capability-item capability-enabled">Post text tweets</div>
                    <div class="capability-item capability-enabled">Read profile information</div>
                    <div class="capability-item capability-${isPartial ? 'disabled' : 'enabled'}">${isPartial ? 'Upload media (not authorized)' : 'Upload images and videos'}</div>
                    <div class="capability-item capability-enabled">Automatic token refresh</div>
                </div>

                ${isPartial ? `
                <div class="warning-box">
                    <h4>⚠️ Incomplete Setup</h4>
                    <p>You can post text tweets, but media uploads require additional authorization.</p>
                    <button class="secondary-button" onclick="window.location.href='/api/twitter/oauth1-auth'">
                        Complete Setup for Media Uploads
                    </button>
                </div>
                ` : ''}

                <div class="action-section">
                    <h3>Test Your Connection</h3>
                    <textarea id="tweetText" class="tweet-input" placeholder="What's happening?">${isPartial ? 'Just completed partial Twitter setup! Text tweets are working. 📝' : 'Just completed full Twitter integration! Both text and media uploads are ready! 🎉📸'}</textarea>
                    <div>
                        <button onclick="postTweet()">Post Tweet</button>
                        ${!isPartial ? '<button onclick="showMediaTest()">Test with Media</button>' : ''}
                    </div>
                    <div id="result"></div>
                </div>

                <div class="token-info">
                    <strong>User ID:</strong> ${userId}<br>
                    ${expiresAt ? `<strong>Token Expires:</strong> ${new Date(expiresAt).toLocaleString()}<br>` : ''}
                    <strong>Auto-refresh:</strong> Enabled
                </div>
            </div>

            <script>
                let useMedia = false;

                function showMediaTest() {
                    useMedia = true;
                    document.getElementById('tweetText').value = '🎬 Testing media upload! This video should attach automatically. #TwitterAPI #MediaUpload';
                    postTweet();
                }

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
                        const payload = { text: tweetText };
                        if (useMedia) {
                            payload.mediaUrl = 'https://cascdr-chads-stay-winning.nyc3.cdn.digitaloceanspaces.com/AXOSgpT7LRXs-5oD.mp4';
                        }

                        const response = await fetch('/api/twitter/tweet', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(payload)
                        });
                        
                        const data = await response.json();
                        
                        if (response.ok) {
                            resultDiv.innerHTML = \`
                                <h4>✅ Tweet Posted Successfully!</h4>
                                <p>Check your Twitter profile to see the tweet.</p>
                                <p><strong>Tweet ID:</strong> \${data.tweet.id}</p>
                                \${useMedia ? '<p><strong>Media:</strong> Video uploaded successfully!</p>' : ''}
                            \`;
                            resultDiv.className = 'success';
                        } else {
                            resultDiv.innerHTML = \`
                                <h4>❌ Error Posting Tweet</h4>
                                <p>\${data.message || data.error}</p>
                                \${data.requiresReauth ? '<p><strong>Action needed:</strong> Please re-authenticate your Twitter account.</p>' : ''}
                            \`;
                            resultDiv.className = 'error';
                        }
                    } catch (error) {
                        resultDiv.innerHTML = \`
                            <h4>❌ Error</h4>
                            <p>\${error.message}</p>
                        \`;
                        resultDiv.className = 'error';
                    } finally {
                        useMedia = false;
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
 * Handle Twitter OAuth 1.0a callback for media uploads (unified flow completion)
 */
router.get('/oauth1-callback', async (req, res) => {
    try {
        const { oauth_token, oauth_verifier } = req.query;
        
        console.log('OAuth 1.0a callback received');

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
        
        console.log('OAuth 1.0a tokens obtained for user:', user.screen_name);

        // Update database with OAuth 1.0a tokens (alongside existing OAuth 2.0 tokens)
        const existingTokens = await getTwitterTokens(oauthData.adminEmail) || {};
        await updateTwitterTokens(oauthData.adminEmail, {
            ...existingTokens, // Keep existing OAuth 2.0 tokens
            oauth1AccessToken: accessToken,      // Add OAuth 1.0a tokens
            oauth1AccessSecret: accessSecret,
            oauth1TwitterId: user.id_str,
            oauth1TwitterUsername: user.screen_name
        });

        // Clean up temporary store
        oauthStateStore.delete(oauth_token);

        // Check if this came from unified flow
        const isUnifiedFlow = oauthData.fromUnifiedFlow;
        const completionMessage = isUnifiedFlow 
            ? 'Twitter Integration Complete! You can now post tweets with text and media.'
            : 'Media Upload Authorization Successful! You can now upload media to your tweets.';

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Twitter Authorization Complete</title>
                <style>
                    body { 
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                        max-width: 600px; 
                        margin: 50px auto; 
                        padding: 20px;
                        background: #f5f5f5;
                    }
                    .container {
                        background: white;
                        border-radius: 12px;
                        padding: 40px;
                        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                        text-align: center;
                    }
                    .success { 
                        color: #1d9bf0;
                        font-size: 48px;
                        margin-bottom: 20px;
                    }
                    h1 {
                        color: #14171a;
                        margin-bottom: 10px;
                    }
                    .subtitle {
                        color: #657786;
                        font-size: 18px;
                        margin-bottom: 30px;
                    }
                    .permissions {
                        background: #f7f9fa;
                        border-radius: 8px;
                        padding: 20px;
                        margin: 20px 0;
                        text-align: left;
                    }
                    .permission-item {
                        display: flex;
                        align-items: center;
                        margin: 10px 0;
                        color: #14171a;
                    }
                    .permission-item::before {
                        content: "✅";
                        margin-right: 10px;
                    }
                    .close-instruction {
                        color: #657786;
                        font-size: 14px;
                        margin-top: 30px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="success">🎉</div>
                    <h1>${completionMessage}</h1>
                    <p class="subtitle">Your Twitter account <strong>@${user.screen_name}</strong> is now fully connected.</p>
                    
                    ${isUnifiedFlow ? `
                    <div class="permissions">
                        <div class="permission-item">Post tweets on your behalf</div>
                        <div class="permission-item">Upload images and videos to tweets</div>
                        <div class="permission-item">Read your basic profile information</div>
                    </div>
                    ` : `
                    <div class="permissions">
                        <div class="permission-item">Upload images and videos to tweets</div>
                    </div>
                    `}
                    
                    <p class="close-instruction">You can now close this window and return to your application.</p>
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
 * Post a tweet using stored tokens with automatic token refresh
 */
router.post('/tweet', validatePrivs, async (req, res) => {
    try {
        // Get tweet text and media URL from request body
        const { text, mediaUrl } = req.body;
        if (!text) {
            return res.status(400).json({
                error: 'Missing text',
                message: 'Please provide tweet text'
            });
        }

        // Use retry wrapper for the entire tweet operation
        const result = await executeWithTokenRefresh(req.user.adminEmail, async (newAccessToken) => {
            // Get tokens (potentially updated after refresh)
            const tokens = await getTwitterTokens(req.user.adminEmail);
            if (!tokens) {
                const error = new Error('No authentication tokens found');
                error.code = 'TWITTER_AUTH_EXPIRED';
                error.requiresReauth = true;
                throw error;
            }

            // Use new token if provided (from refresh), otherwise use stored token
            const accessToken = newAccessToken || tokens.oauthToken;
            const client = new TwitterApi(accessToken);

            // Test token validity
            console.log('Testing token validity...');
            const testUser = await client.v2.me();
            console.log('Token is valid for user:', testUser.data.username);

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
            return tweet;
        });

        res.json({
            success: true,
            message: 'Tweet posted successfully',
            tweet: result.data
        });

    } catch (error) {
        console.error('Error posting tweet:', error);
        
        // Check if this is a re-authentication required error
        if (error.code === 'TWITTER_AUTH_EXPIRED' || error.requiresReauth) {
            return res.status(401).json({
                error: 'TWITTER_AUTH_EXPIRED',
                message: 'Twitter authentication has expired. Please re-authenticate.',
                requiresReauth: true,
                details: error.originalError || error.message
            });
        }

        // Check if this is a media authorization required error
        if (error.message?.includes('OAuth 1.0a tokens not found')) {
            return res.status(403).json({
                error: 'TWITTER_MEDIA_AUTH_REQUIRED',
                message: 'Media upload requires additional authorization. You can post text-only tweets or authorize media uploads.',
                requiresReauth: false,
                requiresMediaAuth: true,
                mediaAuthUrl: '/api/twitter/oauth1-auth',
                fallbackOptions: {
                    textOnly: 'Post tweet without media',
                    authorizeMedia: 'Authorize media uploads'
                }
            });
        }

        // Check if this is a missing token error
        if (error.message?.includes('No authentication tokens found')) {
            return res.status(401).json({
                error: 'TWITTER_NOT_CONNECTED',
                message: 'Twitter account not connected. Please connect your Twitter account first.',
                requiresReauth: true,
                authUrl: '/api/twitter/x-oauth'
            });
        }
        
        // For all other errors
        res.status(500).json({ 
            error: 'TWEET_POST_FAILED',
            message: error.message,
            requiresReauth: false
        });
    }
});

/**
 * POST /api/twitter/tokens
 * Get comprehensive Twitter token status for the authenticated podcast
 */
router.post('/tokens', validatePrivs, async (req, res) => {
    try {
        const tokens = await getTwitterTokens(req.user.adminEmail);
        if (!tokens) {
            return res.json({ 
                authenticated: false,
                capabilities: {
                    canPostText: false,
                    canUploadMedia: false
                },
                oauth2Status: 'missing',
                oauth1Status: 'missing'
            });
        }

        // Check OAuth 2.0 status
        const hasOAuth2 = !!(tokens.oauthToken && tokens.oauthTokenSecret);
        const oauth2Expired = tokens.expiresAt && Date.now() > tokens.expiresAt;
        
        // Check OAuth 1.0a status
        const hasOAuth1 = !!(tokens.oauth1AccessToken && tokens.oauth1AccessSecret);

        res.json({ 
            authenticated: hasOAuth2 && hasOAuth1,
            twitterId: tokens.twitterId,
            twitterUsername: tokens.twitterUsername,
            capabilities: {
                canPostText: hasOAuth2,
                canUploadMedia: hasOAuth1,
                canRefreshTokens: !!(tokens.oauthTokenSecret)
            },
            oauth2Status: hasOAuth2 ? (oauth2Expired ? 'expired' : 'valid') : 'missing',
            oauth1Status: hasOAuth1 ? 'valid' : 'missing',
            expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
            lastUpdated: tokens.lastUpdated
        });
    } catch (error) {
        console.error('Error getting Twitter tokens:', error);
        res.status(500).json({ error: 'Failed to get Twitter tokens' });
    }
});

module.exports = router; 