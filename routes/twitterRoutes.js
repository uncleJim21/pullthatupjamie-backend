const express = require('express');
const router = express.Router();
const { TwitterApi } = require('twitter-api-v2');

// Get the port from environment variables
const PORT = process.env.PORT || 4132;

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
            session: req.session
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

        // Store OAuth state in session
        req.session.twitterOAuth = {
            codeVerifier,
            state,
            timestamp: Date.now()
        };

        // Log session state after setting
        console.log('Session after setting OAuth state:', {
            sessionID: req.sessionID,
            hasTwitterOAuth: !!req.session.twitterOAuth,
            state: req.session.twitterOAuth?.state,
            timestamp: req.session.twitterOAuth?.timestamp,
            fullSession: req.session
        });

        // Save session before sending response
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

            // Send response with session info for debugging
            res.json({ 
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
            fullSession: req.session
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
        
        // Verify state from session
        if (!req.session.twitterOAuth || state !== req.session.twitterOAuth.state) {
            console.error('State mismatch:', {
                sessionState: req.session.twitterOAuth?.state,
                receivedState: state,
                sessionID: req.sessionID,
                hasSession: !!req.session,
                cookies: req.cookies,
                fullSession: req.session
            });
            return res.status(400).json({ 
                error: 'Invalid state parameter',
                debug: {
                    hasSession: !!req.session,
                    sessionID: req.sessionID,
                    receivedState: state,
                    sessionState: req.session.twitterOAuth?.state,
                    cookies: req.cookies,
                    fullSession: req.session
                }
            });
        }

        // Check if the state is too old (30 minutes)
        const stateAge = Date.now() - (req.session.twitterOAuth.timestamp || 0);
        if (stateAge > 30 * 60 * 1000) {
            console.error('State too old:', stateAge);
            return res.status(400).json({ error: 'State parameter expired' });
        }

        const client = new TwitterApi({
            clientId: process.env.TWITTER_CLIENT_ID,
            clientSecret: process.env.TWITTER_CLIENT_SECRET,
        });

        // Exchange code for tokens
        const { accessToken, refreshToken, expiresIn } = await client.loginWithOAuth2({
            code,
            codeVerifier: req.session.twitterOAuth.codeVerifier,
            redirectUri: process.env.TWITTER_CALLBACK_URL || `http://localhost:${PORT}/api/twitter/callback`
        });

        // Get user info
        const userClient = new TwitterApi(accessToken);
        const user = await userClient.v2.me();

        // Store tokens in session
        req.session.twitterTokens = {
            accessToken,
            refreshToken,
            expiresAt: Date.now() + (expiresIn * 1000),
            userId: user.data.id
        };

        // Clear OAuth state
        delete req.session.twitterOAuth;

        // Save session before redirect
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ 
                    error: 'Failed to save session',
                    details: err.message 
                });
            }

            // Set cookie explicitly
            res.cookie('connect.sid', req.sessionID, {
                httpOnly: true,
                secure: false, // Set to false for local development
                sameSite: 'lax',
                domain: 'localhost',
                path: '/',
                maxAge: 24 * 60 * 60 * 1000 // 24 hours
            });

            // Redirect to success page
            res.redirect('/twitter-auth-success');
        });
    } catch (error) {
        console.error('Twitter callback error:', error);
        res.status(500).json({ 
            error: 'Failed to complete Twitter auth',
            details: error.message 
        });
    }
});

module.exports = router; 