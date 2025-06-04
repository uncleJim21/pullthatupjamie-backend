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
        console.log('🔄 REFRESH ATTEMPT:', {
            adminEmail,
            currentRefreshTokenLength: currentRefreshToken?.length,
            timestamp: new Date().toISOString()
        });
        
        const client = new TwitterApi({
            clientId: process.env.TWITTER_CLIENT_ID,
            clientSecret: process.env.TWITTER_CLIENT_SECRET,
        });

        // Use the refresh token to get a new access token
        const { accessToken, refreshToken, expiresIn } = await client.refreshOAuth2Token(currentRefreshToken);
        
        console.log('✅ REFRESH SUCCESS:', {
            adminEmail,
            newAccessTokenLength: accessToken?.length,
            newRefreshTokenLength: refreshToken?.length,
            expiresIn
        });
        
        // Get existing tokens to preserve OAuth 1.0a tokens
        const existingTokens = await getTwitterTokens(adminEmail);
        
        // Update database with new OAuth 2.0 tokens while preserving OAuth 1.0a tokens
        await updateTwitterTokens(adminEmail, {
            ...existingTokens, // Keep existing OAuth 1.0a tokens
            oauthToken: accessToken,
            oauthTokenSecret: refreshToken || currentRefreshToken, // Use new refresh token if provided
            expiresAt: Date.now() + (expiresIn * 1000) // Calculate new expiration
        });

        // Ensure database update is complete by reading it back
        const updatedTokens = await getTwitterTokens(adminEmail);
        console.log('💾 DATABASE UPDATE VERIFIED:', {
            adminEmail,
            updatedAccessTokenMatches: updatedTokens?.oauthToken === accessToken,
            timestamp: new Date().toISOString()
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
                    <div class="capability-${isPartial ? 'disabled' : 'enabled'}">${isPartial ? 'Upload media (not authorized)' : 'Upload images and videos'}</div>
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
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                    }
                    
                    body { 
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                        background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 50%, #0a0a0a 100%);
                        color: #ffffff;
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 20px;
                        position: relative;
                        overflow-x: hidden;
                    }
                    
                    body::before {
                        content: '';
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: radial-gradient(circle at 25% 25%, #1a1a1a 0%, transparent 50%),
                                    radial-gradient(circle at 75% 75%, #2a2a2a 0%, transparent 50%);
                        pointer-events: none;
                        z-index: -1;
                    }
                    
                    .container {
                        background: rgba(20, 20, 20, 0.9);
                        backdrop-filter: blur(10px);
                        border: 1px solid rgba(255, 255, 255, 0.1);
                        border-radius: 20px;
                        padding: 50px;
                        max-width: 600px;
                        width: 100%;
                        text-align: center;
                        box-shadow: 
                            0 20px 40px rgba(0, 0, 0, 0.5),
                            0 0 60px rgba(255, 255, 255, 0.02),
                            inset 0 1px 0 rgba(255, 255, 255, 0.1);
                        position: relative;
                    }
                    
                    .container::before {
                        content: '';
                        position: absolute;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: linear-gradient(45deg, transparent 30%, rgba(255, 255, 255, 0.02) 50%, transparent 70%);
                        border-radius: 20px;
                        pointer-events: none;
                    }
                    
                    .success-icon {
                        font-size: 64px;
                        margin-bottom: 30px;
                        background: linear-gradient(45deg, #00ff88, #00ccff);
                        background-clip: text;
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                        text-shadow: 0 0 30px rgba(0, 255, 136, 0.3);
                        animation: glow 2s ease-in-out infinite alternate;
                    }
                    
                    @keyframes glow {
                        from { filter: brightness(1) drop-shadow(0 0 20px rgba(0, 255, 136, 0.3)); }
                        to { filter: brightness(1.2) drop-shadow(0 0 30px rgba(0, 255, 136, 0.5)); }
                    }
                    
                    h1 {
                        color: #ffffff;
                        font-size: 32px;
                        font-weight: 700;
                        margin-bottom: 15px;
                        text-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
                        background: linear-gradient(45deg, #ffffff, #e0e0e0);
                        background-clip: text;
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                    }
                    
                    .subtitle {
                        color: #b0b0b0;
                        font-size: 18px;
                        margin-bottom: 40px;
                        font-weight: 300;
                    }
                    
                    .username {
                        color: #00ff88;
                        font-weight: 600;
                        text-shadow: 0 0 10px rgba(0, 255, 136, 0.3);
                    }
                    
                    .permissions {
                        background: linear-gradient(135deg, rgba(255, 255, 255, 0.03) 0%, rgba(255, 255, 255, 0.01) 100%);
                        border: 1px solid rgba(255, 255, 255, 0.1);
                        border-radius: 15px;
                        padding: 30px;
                        margin: 30px 0;
                        text-align: left;
                        backdrop-filter: blur(5px);
                    }
                    
                    .permissions h3 {
                        color: #ffffff;
                        font-size: 20px;
                        font-weight: 600;
                        margin-bottom: 20px;
                        text-align: center;
                    }
                    
                    .permission-item {
                        display: flex;
                        align-items: center;
                        margin: 15px 0;
                        color: #e0e0e0;
                        font-size: 16px;
                        padding: 10px 0;
                        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                    }
                    
                    .permission-item:last-child {
                        border-bottom: none;
                    }
                    
                    .permission-item::before {
                        content: "✓";
                        margin-right: 15px;
                        color: #00ff88;
                        font-weight: bold;
                        font-size: 18px;
                        text-shadow: 0 0 10px rgba(0, 255, 136, 0.5);
                    }
                    
                    .close-instruction {
                        color: #808080;
                        font-size: 14px;
                        margin-top: 40px;
                        padding-top: 30px;
                        border-top: 1px solid rgba(255, 255, 255, 0.1);
                        font-weight: 300;
                        line-height: 1.6;
                    }
                    
                    .pulse {
                        animation: pulse 1.5s ease-in-out infinite;
                    }
                    
                    @keyframes pulse {
                        0%, 100% { opacity: 1; }
                        50% { opacity: 0.7; }
                    }
                    
                    .gradient-text {
                        background: linear-gradient(45deg, #00ff88, #00ccff, #ff0080);
                        background-size: 200% 200%;
                        background-clip: text;
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                        animation: gradient-flow 3s ease infinite;
                    }
                    
                    @keyframes gradient-flow {
                        0%, 100% { background-position: 0% 50%; }
                        50% { background-position: 100% 50%; }
                    }
                    
                    @media (max-width: 768px) {
                        body {
                            padding: 15px;
                        }
                        
                        .container {
                            padding: 30px 25px;
                        }
                        
                        .success-icon {
                            font-size: 48px;
                        }
                        
                        h1 {
                            font-size: 24px;
                        }
                        
                        .subtitle {
                            font-size: 16px;
                        }
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="success-icon">🎉</div>
                    <h1>${completionMessage}</h1>
                    <p class="subtitle">Connected as <span class="username">@${user.screen_name}</span></p>
                    
                    ${isUnifiedFlow ? `
                    <div class="permissions">
                        <h3 class="gradient-text">Full Access Granted</h3>
                        <div class="permission-item">Post tweets on your behalf</div>
                        <div class="permission-item">Upload images and videos to tweets</div>
                        <div class="permission-item">Read your basic profile information</div>
                    </div>
                    ` : `
                    <div class="permissions">
                        <h3 class="gradient-text">Media Upload Enabled</h3>
                        <div class="permission-item">Upload images and videos to tweets</div>
                    </div>
                    `}
                    
                    <p class="close-instruction pulse">
                        You can now close this window and return to your application.<br>
                        Your Twitter integration is <span class="gradient-text">fully active</span>.
                    </p>
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
            console.log('🎯 TOKEN SELECTION:', {
                hasNewAccessToken: !!newAccessToken,
                usingNewToken: !!newAccessToken
            });

            // Prioritize the refreshed token from volatile memory to avoid race conditions
            let accessToken = newAccessToken;
            let tokens = null;

            if (!accessToken) {
                // Only query database if we don't have a fresh token from refresh
                tokens = await getTwitterTokens(req.user.adminEmail);
                if (!tokens?.oauthToken) {
                    const error = new Error('No authentication tokens found. Please connect your Twitter account first.');
                    error.code = 'TWITTER_NOT_CONNECTED';
                    error.requiresReauth = true;
                    throw error;
                }
                accessToken = tokens.oauthToken;
            } else {
                // We have a fresh token, but still need other token data for media uploads
                tokens = await getTwitterTokens(req.user.adminEmail);
            }

            console.log('Using token source:', newAccessToken ? 'refreshed' : 'stored');

            if (!accessToken) {
                const error = new Error('No valid access token available. Please re-authenticate.');
                error.code = 'TWITTER_AUTH_EXPIRED';
                error.requiresReauth = true;
                throw error;
            }

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

/**
 * POST /api/twitter/revoke
 * Revoke and delete all Twitter tokens for the authenticated user
 */
router.post('/revoke', validatePrivs, async (req, res) => {
    try {
        const { confirmRevoke } = req.body;
        
        // Safety check - require explicit confirmation
        if (!confirmRevoke) {
            return res.status(400).json({
                error: 'Confirmation required',
                message: 'Please confirm that you want to revoke Twitter access by sending confirmRevoke: true',
                warning: 'This will disconnect your Twitter account and require re-authentication for future use.'
            });
        }

        const adminEmail = req.user.adminEmail;
        
        // Get current tokens before deletion (for logging purposes)
        const existingTokens = await getTwitterTokens(adminEmail);
        const hadTokens = existingTokens && (existingTokens.oauthToken || existingTokens.oauth1AccessToken);
        
        console.log('Revoking Twitter tokens for:', adminEmail, {
            hadOAuth2: !!(existingTokens?.oauthToken),
            hadOAuth1: !!(existingTokens?.oauth1AccessToken),
            username: existingTokens?.twitterUsername
        });

        // Clear all Twitter tokens from database
        await updateTwitterTokens(adminEmail, {
            oauthToken: null,
            oauthTokenSecret: null,
            twitterId: null,
            twitterUsername: null,
            oauth1AccessToken: null,
            oauth1AccessSecret: null,
            oauth1TwitterId: null,
            oauth1TwitterUsername: null,
            expiresAt: null
        });

        // Clear any Twitter-related session data
        if (req.session.twitterTokens) {
            delete req.session.twitterTokens;
        }
        if (req.session.twitterOAuth) {
            delete req.session.twitterOAuth;
        }

        // Save session after clearing Twitter data
        req.session.save((err) => {
            if (err) {
                console.error('Session save error during revoke:', err);
                // Continue anyway since database tokens are cleared
            }
        });

        console.log('Twitter tokens successfully revoked for:', adminEmail);

        res.json({
            success: true,
            message: hadTokens 
                ? 'Twitter account disconnected successfully. All tokens have been revoked and deleted.'
                : 'No Twitter tokens were found to revoke.',
            status: {
                tokensCleared: hadTokens,
                sessionCleared: true,
                requiresReauth: true
            },
            nextSteps: {
                reconnect: 'Use /api/twitter/x-oauth to reconnect your Twitter account',
                checkStatus: 'Use /api/twitter/tokens to verify disconnection'
            }
        });

    } catch (error) {
        console.error('Error revoking Twitter tokens:', {
            adminEmail: req.user.adminEmail,
            error: error.message,
            stack: error.stack
        });
        
        res.status(500).json({
            error: 'Failed to revoke Twitter tokens',
            message: 'An error occurred while disconnecting your Twitter account. Please try again.',
            details: error.message
        });
    }
});

module.exports = router; 