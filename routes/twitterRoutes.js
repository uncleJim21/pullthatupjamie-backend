const express = require('express');
const router = express.Router();
const { TwitterApi } = require('twitter-api-v2');

// Get the port from environment variables
const PORT = process.env.PORT || 4132;

// Temporary in-memory store for OAuth state
const oauthStateStore = new Map();

/**
 * GET /api/twitter/x-oauth
 * Initiate Twitter OAuth flow
 */
router.get('/x-oauth', async (req, res) => {
    try {
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
                scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
                codeChallengeMethod: 'S256'
            }
        );

        // Store OAuth state in both session and temporary store
        const oauthData = {
            codeVerifier,
            state,
            timestamp: Date.now()
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

            // If the request is from curl, return JSON response
            if (req.headers['user-agent']?.includes('curl')) {
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

        // Store tokens in session
        req.session.twitterTokens = {
            accessToken,
            refreshToken,
            expiresAt: Date.now() + (expiresIn * 1000),
            userId: user.data.id
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
            error: 'Failed to complete Twitter auth',
            details: error.message,
            debug: {
                error: error,
                headers: error.headers,
                data: error.data
            }
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
                <p><strong>User ID:</strong> ${req.session.twitterTokens.userId}</p>
                <p><strong>Expires At:</strong> ${new Date(req.session.twitterTokens.expiresAt).toLocaleString()}</p>
            </div>
            <div class="action-section">
                <h3>Test Your Connection</h3>
                <button onclick="postTweet()">Post "Hello World" Tweet</button>
                <div id="result"></div>
            </div>

            <script>
                async function postTweet() {
                    const resultDiv = document.getElementById('result');
                    resultDiv.innerHTML = 'Posting tweet...';
                    resultDiv.className = '';
                    
                    try {
                        const response = await fetch('/api/twitter/tweet', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            }
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
 * POST /api/twitter/tweet
 * Post a tweet using stored tokens
 */
router.post('/tweet', async (req, res) => {
    try {
        // Check if we have valid tokens
        if (!req.session.twitterTokens) {
            return res.status(401).json({ 
                error: 'Not authenticated',
                message: 'Please complete Twitter OAuth first'
            });
        }

        // Check if token is expired
        if (Date.now() >= req.session.twitterTokens.expiresAt) {
            return res.status(401).json({ 
                error: 'Token expired',
                message: 'Please re-authenticate with Twitter'
            });
        }

        // Create Twitter client with stored access token
        const client = new TwitterApi(req.session.twitterTokens.accessToken);

        // Post the tweet
        const tweet = await client.v2.tweet('Hello World!');

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

module.exports = router; 