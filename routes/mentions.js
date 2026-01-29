const express = require('express');
const router = express.Router();
const { User } = require('../models/shared/UserSchema');
const { SocialProfileMapping } = require('../models/SocialProfileMappings');
const { TwitterApi } = require('twitter-api-v2');
const { authenticateToken } = require('../middleware/authMiddleware');

// Utility function to send SSE formatted data
function sendSSE(res, data, eventType = 'data') {
  res.write(`event: ${eventType}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Find user from req.user - supports email, provider-based, and admin mode
 * Works with Twitter, Nostr, and email-based users
 */
async function findMentionsUser(reqUser, selectFields = '+mention_preferences') {
  // Admin mode override
  if (reqUser.isAdminMode) {
    return User.findOne({ email: 'jim.carucci+prod@protonmail.com' }).select(selectFields);
  }
  
  // Try email first
  if (reqUser.email) {
    return User.findOne({ email: reqUser.email }).select(selectFields);
  }
  
  // Try provider-based lookup (Twitter/Nostr)
  if (reqUser.provider && reqUser.providerId) {
    return User.findOne({
      'authProvider.provider': reqUser.provider,
      'authProvider.providerId': reqUser.providerId
    }).select(selectFields);
  }
  
  // Fallback to user ID
  if (reqUser.id) {
    return User.findById(reqUser.id).select(selectFields);
  }
  
  return null;
}

// Promisified search functions
async function searchPersonalPins(user, query, platforms = ['twitter', 'nostr']) {
  try {
    // Use helper that supports email, provider, and admin mode
    console.log('searchPersonalPins - Looking for user:', user.email || user.providerId || 'admin');
    const userData = await findMentionsUser(user, '+mention_preferences +mentionPreferences');
    
    let pins = [];
    if (userData.mention_preferences?.pinned_mentions) {
      pins = userData.mention_preferences.pinned_mentions;
    } else if (userData.mentionPreferences?.personalPins) {
      pins = userData.mentionPreferences.personalPins;
    }

    // Filter and validate pins
    const validPins = pins.filter(pin => {
      return (pin.twitter_profile && pin.twitter_profile.username) || 
             (pin.nostr_profile && pin.nostr_profile.npub);
    });

    const matchingPins = validPins.filter(pin => {
      // First check if pin matches requested platforms
      const hasTwitter = pin.twitter_profile && pin.twitter_profile.username;
      const hasNostr = pin.nostr_profile && pin.nostr_profile.npub;
      
      const matchesPlatform = 
        (platforms.includes('twitter') && hasTwitter) ||
        (platforms.includes('nostr') && hasNostr);
      
      if (!matchesPlatform) return false;
      
      // Then check if pin matches the search query
      let pinUsername = null;
      let pinName = null;
      
      if (hasTwitter) {
        pinUsername = pin.twitter_profile.username;
        pinName = pin.twitter_profile.name;
      } else if (hasNostr) {
        pinUsername = pin.nostr_profile.npub;
        pinName = pin.nostr_profile.displayName;
      }
      
      const matchesQuery = 
        (pinUsername && pinUsername.toLowerCase().includes(query.toLowerCase())) ||
        (pinName && pinName.toLowerCase().includes(query.toLowerCase()));
      
      return matchesQuery;
    });

    // Backfill missing nprofile for existing Nostr pins
    let needsSave = false;
    for (let i = 0; i < matchingPins.length; i++) {
      const pin = matchingPins[i];
      if (pin.nostr_profile && pin.nostr_profile.npub && !pin.nostr_profile.nprofile) {
        try {
          const NostrService = require('../utils/NostrService');
          const nostrService = new NostrService();
          
          // Generate nprofile from npub
          const nprofile = nostrService.npubToNprofile(pin.nostr_profile.npub);
          pin.nostr_profile.nprofile = nprofile;
          
          // Convert npub to pubkey if not provided
          if (!pin.nostr_profile.pubkey) {
            pin.nostr_profile.pubkey = nostrService.npubToHex(pin.nostr_profile.npub);
          }
          
          needsSave = true;
          console.log('Backfilled nprofile for existing pin:', pin.id);
        } catch (error) {
          console.warn('Failed to backfill nprofile for pin:', pin.id, error.message);
        }
      }
    }
    
    // Save if we made any updates
    if (needsSave && userData) {
      try {
        await userData.save();
        console.log('Saved backfilled nprofile data');
      } catch (error) {
        console.warn('Failed to save backfilled data:', error.message);
      }
    }

    const results = [];
    
    matchingPins.forEach(pin => {
      const hasTwitter = pin.twitter_profile && pin.twitter_profile.username;
      const hasNostr = pin.nostr_profile && pin.nostr_profile.npub;
      
      // Add Twitter profile if it exists and Twitter platform is requested
      if (hasTwitter && platforms.includes('twitter')) {
        const twitterResult = {
          platform: 'twitter',
          id: pin.twitter_profile.id || null,
          username: pin.twitter_profile.username,
          name: pin.twitter_profile.name || pin.twitter_profile.username,
          verified: pin.twitter_profile.verified || false,
          verified_type: pin.twitter_profile.verified_type || null,
          profile_image_url: pin.twitter_profile.profile_image_url || null,
          description: pin.twitter_profile.description || null,
          public_metrics: pin.twitter_profile.public_metrics || {
            followers_count: 0,
            following_count: 0,
            tweet_count: 0,
            listed_count: 0
          },
          protected: pin.twitter_profile.protected || false,
          isPinned: true,
          pinId: pin.id,
          lastUsed: null,
          crossPlatformMapping: hasNostr ? `Connected to Nostr ${pin.nostr_profile.displayName || pin.nostr_profile.npub}` : null
        };
        results.push(twitterResult);
      }
      
      // Add Nostr profile if it exists and Nostr platform is requested  
      if (hasNostr && platforms.includes('nostr')) {
        const nostrResult = {
          platform: 'nostr',
          id: null,
          username: pin.nostr_profile.npub,
          name: pin.nostr_profile.displayName || pin.nostr_profile.name || pin.nostr_profile.npub,
          verified: false,
          verified_type: null,
          profile_image_url: pin.nostr_profile.profile_image_url || pin.nostr_profile.picture || null,
          description: pin.nostr_profile.description || pin.nostr_profile.about || null,
          public_metrics: {
            followers_count: 0,
            following_count: 0,
            tweet_count: 0,
            listed_count: 0
          },
          protected: false,
          isPinned: true,
          pinId: pin.id,
          lastUsed: null,
          crossPlatformMapping: hasTwitter ? `Connected to Twitter @${pin.twitter_profile.username}` : null,
          nostr_data: {
            npub: pin.nostr_profile.npub,
            nprofile: pin.nostr_profile.nprofile || null,
            pubkey: pin.nostr_profile.pubkey || null,
            nip05: pin.nostr_profile.nip05 || null,
            lud16: pin.nostr_profile.lud16 || null,
            website: pin.nostr_profile.website || null
          }
        };
        results.push(nostrResult);
      }
    });

    return { source: 'pins', results, error: null };
  } catch (error) {
    console.error('Error searching personal pins:', error);
    return { source: 'pins', results: [], error: error.message };
  }
}

async function searchTwitterAPI(query, platforms, user = null) {
  if (!platforms.includes('twitter')) {
    return { source: 'twitter', results: [], error: null };
  }

  try {
    let client = null;
    let authMethod = 'app-only';
    
    // First try: Use user OAuth tokens if available
    if (user?.email) {
      try {
        const TwitterService = require('../utils/TwitterService');
        const twitterService = new TwitterService();
        
        // Get user's admin email (handle both user ID lookup and direct email)
        let adminEmail = user.email;
        if (user.isAdminMode) {
          adminEmail = 'jim.carucci+prod@protonmail.com';
        }
        
        // Get tokens and create client with automatic refresh capability
        const { getTwitterTokens } = require('../utils/ProPodcastUtils');
        const tokens = await getTwitterTokens(adminEmail);
        
        if (tokens?.oauthToken) {
          console.log('🔑 Using user OAuth tokens for Twitter search:', adminEmail);
          client = new TwitterApi(tokens.oauthToken);
          authMethod = 'user-oauth';
          
          // We'll wrap the actual API call in executeWithTokenRefresh later
        } else {
          throw new Error('No valid Twitter tokens found');
        }
        
      } catch (userAuthError) {
        console.log('🔄 User OAuth failed, falling back to app-only:', userAuthError.message);
        // Fall through to app-only auth
      }
    }
    
    // Fallback: Use app-only authentication
    if (!client) {
      console.log('🔑 Using app-only authentication for Twitter search');
      const appClient = new TwitterApi({
        appKey: process.env.TWITTER_CONSUMER_KEY,
        appSecret: process.env.TWITTER_CONSUMER_SECRET,
      });
      client = await appClient.appLogin();
      authMethod = 'app-only';
    }

    let response;
    
    // If using user OAuth, wrap in token refresh logic
    if (authMethod === 'user-oauth' && user?.email) {
      const TwitterService = require('../utils/TwitterService');
      const twitterService = new TwitterService();
      
      let adminEmail = user.email;
      if (user.isAdminMode) {
        adminEmail = 'jim.carucci+prod@protonmail.com';
      }
      
      response = await twitterService.executeWithTokenRefresh(adminEmail, async (newAccessToken) => {
        let apiClient = client;
        
        // If we got a refreshed token, create a new client with it
        if (newAccessToken) {
          console.log('🔄 Using refreshed token for Twitter search');
          apiClient = new TwitterApi(newAccessToken);
        }
        
        return await apiClient.v2.usersByUsernames([query.replace(/^@/, '').toLowerCase()], {
          'user.fields': [
            'id', 'name', 'username', 'verified', 'verified_type', 'profile_image_url', 'description', 'public_metrics', 'protected'
          ]
        });
      });
    } else {
      // For app-only auth, just make the call directly
      response = await client.v2.usersByUsernames([query.replace(/^@/, '').toLowerCase()], {
        'user.fields': [
          'id', 'name', 'username', 'verified', 'verified_type', 'profile_image_url', 'description', 'public_metrics', 'protected'
        ]
      });
    }

    const results = (response.data || []).map(user => ({
      platform: 'twitter',
      id: user.id,
      username: user.username,
      name: user.name,
      verified: user.verified || false,
      verified_type: user.verified_type || null,
      profile_image_url: user.profile_image_url || null,
      description: user.description || null,
      public_metrics: user.public_metrics || {
        followers_count: 0,
        following_count: 0,
        tweet_count: 0,
        listed_count: 0
      },
      protected: user.protected || false,
      isPinned: false,
      pinId: null,
      lastUsed: null,
      crossPlatformMapping: null
    }));

    console.log(`✅ Twitter search successful (${authMethod}): ${results.length} results`);
    return { source: 'twitter', results, error: null, authMethod };
  } catch (error) {
    console.error('Error searching Twitter API:', error);
    
    // Enhanced error handling for rate limits
    if (error.code === 429) {
      const isAppLimit = error.headers?.['x-app-limit-24hour-remaining'] === '0';
      const resetTime = error.headers?.['x-app-limit-24hour-reset'] || error.headers?.['x-rate-limit-reset'];
      
      return { 
        source: 'twitter', 
        results: [], 
        error: `Rate limit exceeded (${isAppLimit ? 'daily app limit' : 'rate limit'}). Reset at: ${resetTime ? new Date(resetTime * 1000).toISOString() : 'unknown'}`,
        rateLimited: true,
        isAppLimit
      };
    }
    
    return { source: 'twitter', results: [], error: error.message };
  }
}

async function searchCrossPlatformMappings(query, limit) {
  try {
    const mappings = await SocialProfileMapping.find({
      $or: [
        { 'twitter_profile.username': { $regex: query, $options: 'i' } },
        { 'nostr_profile.npub': { $regex: query, $options: 'i' } }
      ]
    }).limit(limit).lean();

    return { source: 'mappings', results: mappings, error: null };
  } catch (error) {
    console.error('Error searching cross-platform mappings:', error);
    return { source: 'mappings', results: [], error: error.message };
  }
}

// POST /api/mentions/search/stream - Streaming search endpoint
router.post('/search/stream', authenticateToken, async (req, res) => {
  const {
    query,
    platforms = ['twitter'],
    includePersonalPins = true,
    includeCrossPlatformMappings = true,
    limit = 10
  } = req.body;

  if (!query || typeof query !== 'string' || query.length < 1 || query.length > 50) {
    return res.status(400).json({
      error: 'Invalid search query',
      message: 'Query must be between 1 and 50 characters',
      code: 'INVALID_QUERY_LENGTH'
    });
  }

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Keep track of all results for deduplication
  const allResults = [];
  const completedSources = [];

  // Create search promises
  const searchPromises = [];
  
  if (includePersonalPins) {
    searchPromises.push(searchPersonalPins(req.user, query, platforms));
  }
  
  searchPromises.push(searchTwitterAPI(query, platforms, req.user));
  
  if (includeCrossPlatformMappings) {
    searchPromises.push(searchCrossPlatformMappings(query, limit));
  }

  // Process searches as they complete to enable true streaming
  let completedCount = 0;
  const totalSearches = searchPromises.length;

  const handleSearchResult = async (searchPromise, index) => {
    try {
      const { source, results, error } = await searchPromise;
      completedSources.push(source);
      completedCount++;

      if (error) {
        sendSSE(res, {
          type: 'error',
          source,
          error,
          completedSources: [...completedSources]
        }, 'error');
        return;
      }

      // For personal pins, send immediately
      if (source === 'pins') {
        allResults.push(...results);
        sendSSE(res, {
          type: 'partial',
          source,
          results,
          meta: {
            totalResults: results.length,
            searchTerm: query,
            completedSources: [...completedSources]
          }
        });
      }
      // For Twitter results, merge with pins data and send
      else if (source === 'twitter') {
        // Update pin status for Twitter results
        const pinsData = allResults.filter(r => r.isPinned);
        const updatedResults = results.map(twitterUser => {
          const matchingPin = pinsData.find(pin => 
            pin.platform === 'twitter' && 
            pin.username.toLowerCase() === twitterUser.username.toLowerCase()
          );
          
          if (matchingPin) {
            return {
              ...twitterUser,
              isPinned: true,
              pinId: matchingPin.pinId,
              lastUsed: matchingPin.lastUsed,
              crossPlatformMapping: matchingPin.crossPlatformMapping // Preserve cross-platform mapping from pins
            };
          }
          return twitterUser;
        });

        // Add to allResults (avoiding duplicates)
        updatedResults.forEach(result => {
          const existingIndex = allResults.findIndex(r => 
            r.platform === result.platform && 
            r.username.toLowerCase() === result.username.toLowerCase()
          );
          if (existingIndex >= 0) {
            allResults[existingIndex] = result; // Update with Twitter data
          } else {
            allResults.push(result);
          }
        });

        sendSSE(res, {
          type: 'partial',
          source,
          results: updatedResults,
          meta: {
            totalResults: updatedResults.length,
            searchTerm: query,
            completedSources: [...completedSources]
          }
        });
      }
      // For mappings, just send the data
      else if (source === 'mappings') {
        sendSSE(res, {
          type: 'partial',
          source,
          results,
          meta: {
            totalResults: results.length,
            searchTerm: query,
            completedSources: [...completedSources]
          }
        });
      }

      // Check if all searches are complete
      if (completedCount === totalSearches) {
        // Send completion event
        sendSSE(res, {
          type: 'complete',
          totalResults: allResults.length,
          platforms,
          searchTerm: query,
          includePersonalPins,
          includeCrossPlatformMappings,
          completedSources
        }, 'complete');

        res.end();
      }
    } catch (error) {
      completedCount++;
      sendSSE(res, {
        type: 'error',
        source: 'unknown',
        error: error?.message || 'Unknown search error',
        completedSources: [...completedSources]
      }, 'error');

      // Check if all searches are complete (even with errors)
      if (completedCount === totalSearches) {
        sendSSE(res, {
          type: 'complete',
          totalResults: allResults.length,
          platforms,
          searchTerm: query,
          includePersonalPins,
          includeCrossPlatformMappings,
          completedSources
        }, 'complete');

        res.end();
      }
    }
  };

  // Handle client disconnection
  req.on('close', () => {
    console.log('Client disconnected from streaming search');
  });

  // Set a timeout to ensure the connection closes
  const timeout = setTimeout(() => {
    if (!res.finished) {
      sendSSE(res, {
        type: 'timeout',
        message: 'Search timed out after 30 seconds',
        completedSources
      }, 'error');
      res.end();
    }
  }, 30000);

  // Clear timeout when response ends
  res.on('finish', () => {
    clearTimeout(timeout);
  });

  // Start all searches and handle them as they complete
  searchPromises.forEach((promise, index) => {
    handleSearchResult(promise, index);
  });
});

// POST /api/mentions/search
router.post('/search', authenticateToken, async (req, res) => {
  const {
    query,
    platforms = ['twitter'],
    includePersonalPins = true,
    includeCrossPlatformMappings = true,
    limit = 10
  } = req.body;

  if (!query || typeof query !== 'string' || query.length < 1 || query.length > 50) {
    return res.status(400).json({
      error: 'Invalid search query',
      message: 'Query must be between 1 and 50 characters',
      code: 'INVALID_QUERY_LENGTH'
    });
  }

  // Twitter search using the updated function with user OAuth priority
  let twitterResults = [];
  if (platforms.includes('twitter')) {
    const twitterSearchResult = await searchTwitterAPI(query, platforms, req.user);
    
    if (twitterSearchResult.error && !twitterSearchResult.rateLimited) {
      return res.status(500).json({
        error: 'TWITTER_API_ERROR',
        message: twitterSearchResult.error,
        authMethod: twitterSearchResult.authMethod
      });
    }
    
    // If rate limited, continue with empty results but log the issue
    if (twitterSearchResult.rateLimited) {
      console.warn('Twitter search rate limited:', twitterSearchResult.error);
    }
    
    twitterResults = twitterSearchResult.results || [];
  }

  // Nostr search (placeholder)
  let nostrResults = [];
  if (platforms.includes('nostr')) {
    // TODO: Implement Nostr search
    nostrResults = [];
  }

  // Cross-platform mappings
  let crossMappings = [];
  if (includeCrossPlatformMappings) {
    crossMappings = await SocialProfileMapping.find({
      $or: [
        { 'twitter_profile.username': { $regex: query, $options: 'i' } },
        { 'nostr_profile.npub': { $regex: query, $options: 'i' } }
      ]
    }).limit(limit).lean();
  }

  // Personal pins
  let personalPins = [];
  if (includePersonalPins) {
    try {
      const user = await User.findById(req.user.id).select('+mention_preferences +mentionPreferences');
      
      // Check both old and new structures
      if (user.mention_preferences?.pinned_mentions) {
        personalPins = user.mention_preferences.pinned_mentions;
      } else if (user.mentionPreferences?.personalPins) {
        // Migrate from old structure to new structure
        personalPins = user.mentionPreferences.personalPins;
        
        // Update the user document
        if (!user.mention_preferences) {
          user.mention_preferences = { pinned_mentions: [] };
        }
        user.mention_preferences.pinned_mentions = personalPins;
        user.mentionPreferences = undefined;
        
        await user.save();
      }
      
      // Debug: Log pins to see what we're working with
      console.log('Personal pins found:', personalPins.length);
      personalPins.forEach((pin, index) => {
        const platform = pin.twitter_profile ? 'twitter' : pin.nostr_profile ? 'nostr' : 'unknown';
        const username = pin.twitter_profile?.username || pin.nostr_profile?.npub || 'unknown';
        console.log(`Pin ${index}:`, { platform, username, id: pin.id });
        console.log(`Full pin ${index}:`, pin);
      });
      
      // Filter out malformed pins (missing required fields)
      const validPins = personalPins.filter(pin => {
        return (pin.twitter_profile && pin.twitter_profile.username) || 
               (pin.nostr_profile && pin.nostr_profile.npub);
      });
      const malformedPins = personalPins.filter(pin => {
        return !((pin.twitter_profile && pin.twitter_profile.username) || 
                (pin.nostr_profile && pin.nostr_profile.npub));
      });
      
      if (malformedPins.length > 0) {
        console.log(`Found ${malformedPins.length} malformed pins, cleaning up...`);
        
        // Remove malformed pins from the user document
        if (user.mention_preferences?.pinned_mentions) {
          user.mention_preferences.pinned_mentions = user.mention_preferences.pinned_mentions.filter(
            pin => (pin.twitter_profile && pin.twitter_profile.username) || 
                   (pin.nostr_profile && pin.nostr_profile.npub)
          );
          await user.save();
          console.log('Cleaned up malformed pins from new structure');
        }
      }
      
      personalPins = validPins;
    } catch (error) {
      console.error('Error fetching personal pins for search:', error);
      // Continue without personal pins if there's an error
    }
  }

  // Merge results (MVP: just Twitter + cross-mappings)
  let results = [...twitterResults];
  
  // Check pin status and attach cross-mapping info to Twitter results
  results = results.map(tw => {
    // Check if this result is pinned
    const pinnedPin = personalPins.find(pin => {
      if (tw.platform === 'twitter' && pin.twitter_profile) {
        return pin.twitter_profile.username && 
               pin.twitter_profile.username.toLowerCase() === tw.username.toLowerCase();
      }
      if (tw.platform === 'nostr' && pin.nostr_profile) {
        return pin.nostr_profile.npub && 
               pin.nostr_profile.npub.toLowerCase() === tw.username.toLowerCase();
      }
      return false;
    });
    
    // Check for cross-platform mapping
    const mapping = includeCrossPlatformMappings && crossMappings.length > 0 ? 
      crossMappings.find(m => m.twitter_profile.username.toLowerCase() === tw.username.toLowerCase()) : null;
    
    // Check if this Twitter profile is linked to a Nostr profile in personal pins
    let nostrCrossPlatformMapping = null;
    if (pinnedPin && pinnedPin.nostr_profile) {
      nostrCrossPlatformMapping = `Connected to Nostr ${pinnedPin.nostr_profile.displayName || pinnedPin.nostr_profile.name || pinnedPin.nostr_profile.npub}`;
    }
    
    return {
      ...tw,
      isPinned: !!pinnedPin,
      pinId: pinnedPin?.id || null,
      lastUsed: pinnedPin?.lastUsed || null,
      crossPlatformMapping: nostrCrossPlatformMapping || (mapping ? {
        hasNostrMapping: true,
        nostrNpub: mapping.nostr_profile.npub,
        nostrDisplayName: mapping.nostr_profile.displayName || null,
        confidence: mapping.confidence_score,
        verificationMethod: mapping.verification_method,
        isAdopted: false,
        mappingId: mapping._id.toString()
      } : null)
    };
  });
  
  // Add personal pins that don't match existing results
  if (includePersonalPins && personalPins.length > 0) {
    const existingUsernames = results.map(r => `${r.platform}:${r.username.toLowerCase()}`);
    
    personalPins.forEach(pin => {
      // Skip pins with missing required fields
      let pinUsername = null;
      let pinPlatform = null;
      
      if (pin.twitter_profile && pin.twitter_profile.username) {
        pinUsername = pin.twitter_profile.username;
        pinPlatform = 'twitter';
      } else if (pin.nostr_profile && pin.nostr_profile.npub) {
        pinUsername = pin.nostr_profile.npub;
        pinPlatform = 'nostr';
      }
      
      if (!pinUsername || !pinPlatform) {
        console.warn('Skipping pin with missing fields:', pin);
        return;
      }
      
      const pinKey = `${pinPlatform}:${pinUsername.toLowerCase()}`;
      
      // Only add pinned profiles that match the search query
      const matchesQuery = pinUsername.toLowerCase().includes(query.toLowerCase()) || 
                           (pin.twitter_profile?.name && pin.twitter_profile.name.toLowerCase().includes(query.toLowerCase()));
      
      if (!existingUsernames.includes(pinKey) && matchesQuery) {
        // Add pinned profile that wasn't found in search results but matches the query
        const profileData = pinPlatform === 'twitter' ? pin.twitter_profile : pin.nostr_profile;
        
        // Determine cross-platform mapping for pinned profiles
        let crossPlatformMapping = null;
        if (pinPlatform === 'twitter' && pin.nostr_profile) {
          crossPlatformMapping = `Connected to Nostr ${pin.nostr_profile.displayName || pin.nostr_profile.name || pin.nostr_profile.npub}`;
        } else if (pinPlatform === 'nostr' && pin.twitter_profile) {
          crossPlatformMapping = `Connected to Twitter @${pin.twitter_profile.username}`;
        }

        results.push({
          platform: pinPlatform,
          id: profileData?.id || null,
          username: pinUsername,
          name: profileData?.name || profileData?.displayName || pinUsername,
          verified: profileData?.verified || false,
          verified_type: profileData?.verified_type || null,
          profile_image_url: profileData?.profile_image_url || null,
          description: profileData?.description || null,
          public_metrics: profileData?.public_metrics || {
            followers_count: 0,
            following_count: 0,
            tweet_count: 0,
            listed_count: 0
          },
          protected: profileData?.protected || false,
          isPinned: true,
          pinId: pin.id,
          lastUsed: null, // TODO: Add lastUsed field to schema if needed
          crossPlatformMapping: crossPlatformMapping,
          // Add nostr_data for Nostr profiles to match streaming format
          ...(pinPlatform === 'nostr' && {
            nostr_data: {
              npub: pin.nostr_profile.npub,
              nprofile: pin.nostr_profile.nprofile || null,
              pubkey: pin.nostr_profile.pubkey || null,
              nip05: pin.nostr_profile.nip05 || null,
              lud16: pin.nostr_profile.lud16 || null,
              website: pin.nostr_profile.website || null
            }
          })
        });
      }
    });
  }

  return res.json({
    results: results.slice(0, limit),
    meta: {
      totalResults: results.length,
      platforms,
      searchTerm: query,
      includePersonalPins,
      includeCrossPlatformMappings
    }
  });
});

// Personal Pin Management Routes
router.get('/pins', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('+mention_preferences +mentionPreferences');
    console.log('GET /pins - User found:', !!user);
    console.log('GET /pins - mention_preferences:', user?.mention_preferences);
    console.log('GET /pins - mentionPreferences (old):', user?.mentionPreferences);
    
    // Check both old and new structures
    let pins = [];
    
    if (user.mention_preferences?.pinned_mentions) {
      pins = user.mention_preferences.pinned_mentions;
    } else if (user.mentionPreferences?.personalPins) {
      // Migrate from old structure to new structure
      console.log('Migrating pins from old structure to new structure');
      pins = user.mentionPreferences.personalPins;
      
      // Update the user document
      if (!user.mention_preferences) {
        user.mention_preferences = { pinned_mentions: [] };
      }
      user.mention_preferences.pinned_mentions = pins;
      
      // Remove old structure
      user.mentionPreferences = undefined;
      
      await user.save();
      console.log('Migration completed');
    }
    
    console.log('GET /pins - Returning pins:', pins);
    res.json({ pins });
  } catch (error) {
    console.error('Error fetching personal pins:', error);
    res.status(500).json({ error: 'Failed to fetch personal pins' });
  }
});

router.post('/pins', authenticateToken, async (req, res) => {
  try {
    const { platform, username, targetPlatform, targetUsername, notes, profileData } = req.body;
    
    if (!platform || !username) {
      return res.status(400).json({ 
        error: 'Missing required fields: platform, username' 
      });
    }

    // For Nostr profiles, ensure we have nprofile if not provided
    let enrichedProfileData = profileData || {};
    if (platform === 'nostr' && username.startsWith('npub1') && !enrichedProfileData.nprofile) {
      try {
        const NostrService = require('../utils/NostrService');
        const nostrService = new NostrService();
        
        // Generate nprofile from npub
        const nprofile = nostrService.npubToNprofile(username);
        enrichedProfileData.nprofile = nprofile;
        
        // Convert npub to pubkey if not provided
        if (!enrichedProfileData.pubkey) {
          enrichedProfileData.pubkey = nostrService.npubToHex(username);
        }
        
        console.log('Generated nprofile for pin creation:', nprofile);
      } catch (error) {
        console.warn('Failed to generate nprofile for pin:', error.message);
      }
    }

    const user = await User.findById(req.user.id).select('+mention_preferences');
    
    if (!user.mention_preferences) {
      user.mention_preferences = {
        pinned_mentions: []
      };
    }

    // Check for existing pin with same source
    const existingPinIndex = user.mention_preferences.pinned_mentions.findIndex(pin => {
      if (platform === 'twitter' && pin.twitter_profile) {
        return pin.twitter_profile.username === username;
      }
      if (platform === 'nostr' && pin.nostr_profile) {
        return pin.nostr_profile.npub === username;
      }
      return false;
    });

    // Determine if this is a cross-platform mapping
    const isCrossPlatform = targetPlatform && targetUsername && targetPlatform !== platform;
    
    const newPin = {
      id: existingPinIndex >= 0 ? user.mention_preferences.pinned_mentions[existingPinIndex].id : 
          `pin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      label: notes || '',
      twitter_profile: platform === 'twitter' ? { 
        username, 
        id: enrichedProfileData?.id || null,
        name: enrichedProfileData?.name || username,
        profile_image_url: enrichedProfileData?.profile_image_url || null,
        description: enrichedProfileData?.description || null,
        verified: enrichedProfileData?.verified || false,
        verified_type: enrichedProfileData?.verified_type || null,
        public_metrics: enrichedProfileData?.public_metrics || null,
        protected: enrichedProfileData?.protected || false
      } : null,
      nostr_profile: platform === 'nostr' ? { 
        npub: username,
        displayName: enrichedProfileData?.displayName || username,
        profile_image_url: enrichedProfileData?.profile_image_url || null,
        description: enrichedProfileData?.description || null,
        nprofile: enrichedProfileData?.nprofile || null,
        pubkey: enrichedProfileData?.pubkey || null,
        nip05: enrichedProfileData?.nip05 || null,
        lud16: enrichedProfileData?.lud16 || null,
        website: enrichedProfileData?.website || null
      } : null,
      is_cross_platform: isCrossPlatform,
      source_mapping_id: null,
      mapping_confidence: null,
      usage_count: existingPinIndex >= 0 ? user.mention_preferences.pinned_mentions[existingPinIndex].usage_count : 0,
      is_adopted: false
    };

    if (existingPinIndex >= 0) {
      user.mention_preferences.pinned_mentions[existingPinIndex] = newPin;
    } else {
      user.mention_preferences.pinned_mentions.push(newPin);
    }

    await user.save();
    res.json({ pin: newPin, message: existingPinIndex >= 0 ? 'Pin updated' : 'Pin created' });
  } catch (error) {
    console.error('Error creating/updating personal pin:', error);
    res.status(500).json({ error: 'Failed to create/update personal pin' });
  }
});

router.put('/pins/:pinId', authenticateToken, async (req, res) => {
  try {
    const { pinId } = req.params;
    const { targetPlatform, targetUsername, notes } = req.body;
    
    const user = await User.findById(req.user.id).select('+mention_preferences');
    
    if (!user.mention_preferences) {
      return res.status(404).json({ error: 'No mention preferences found' });
    }

    const pinIndex = user.mention_preferences.pinned_mentions.findIndex(pin => pin.id === pinId);
    
    if (pinIndex === -1) {
      return res.status(404).json({ error: 'Personal pin not found' });
    }

    const pin = user.mention_preferences.pinned_mentions[pinIndex];
    
    if (notes !== undefined) pin.label = notes;
    
    // Update cross-platform mapping if provided
    if (targetPlatform && targetUsername) {
      pin.is_cross_platform = targetPlatform !== (pin.twitter_profile ? 'twitter' : 'nostr');
      // Note: We don't store targetPlatform/targetUsername directly in the pin
      // as they're used for cross-platform mappings which are handled separately
    }
    
    pin.updatedAt = new Date();
    
    await user.save();
    res.json({ pin, message: 'Pin updated successfully' });
  } catch (error) {
    console.error('Error updating personal pin:', error);
    res.status(500).json({ error: 'Failed to update personal pin' });
  }
});

router.delete('/pins/:pinId', authenticateToken, async (req, res) => {
  try {
    const { pinId } = req.params;
    
    console.log('Delete request for pinId:', pinId);
    console.log('User ID:', req.user.id);
    
    const user = await User.findById(req.user.id).select('+mention_preferences +mentionPreferences');
    console.log('User found:', !!user);
    console.log('User mention_preferences:', user?.mention_preferences);
    console.log('User mentionPreferences (old):', user?.mentionPreferences);
    
    let pinIndex = -1;
    let pinArray = null;
    
    // Check new structure first
    if (user.mention_preferences?.pinned_mentions) {
      pinArray = user.mention_preferences.pinned_mentions;
      pinIndex = pinArray.findIndex(pin => pin.id === pinId);
      console.log('Checking new structure - pin index:', pinIndex);
    }
    
    // If not found in new structure, check old structure
    if (pinIndex === -1 && user.mentionPreferences?.personalPins) {
      pinArray = user.mentionPreferences.personalPins;
      pinIndex = pinArray.findIndex(pin => pin.id === pinId);
      console.log('Checking old structure - pin index:', pinIndex);
      
      if (pinIndex !== -1) {
        // Migrate to new structure first
        console.log('Migrating to new structure before deletion');
        if (!user.mention_preferences) {
          user.mention_preferences = { pinned_mentions: [] };
        }
        user.mention_preferences.pinned_mentions = user.mentionPreferences.personalPins;
        user.mentionPreferences = undefined;
        pinArray = user.mention_preferences.pinned_mentions;
      }
    }
    
    if (pinIndex === -1) {
      console.log('Pin not found in either structure');
      return res.status(404).json({ error: 'Personal pin not found' });
    }

    pinArray.splice(pinIndex, 1);
    await user.save();
    
    res.json({ message: 'Personal pin deleted successfully' });
  } catch (error) {
    console.error('Error deleting personal pin:', error);
    res.status(500).json({ error: 'Failed to delete personal pin' });
  }
});

// POST /api/mentions/pins/:pinId/link-nostr
router.post('/pins/:pinId/link-nostr', authenticateToken, async (req, res) => {
  try {
    const { pinId } = req.params;
    const { npub } = req.body;
    
    console.log('Link Nostr request:', { pinId, npub });
    
    if (!npub) {
      return res.status(400).json({ 
        error: 'Missing npub',
        message: 'npub field is required'
      });
    }

    // Initialize NostrService for profile lookup
    const NostrService = require('../utils/NostrService');
    const nostrService = new NostrService();

    // Validate npub format
    if (!nostrService.isValidNpub(npub)) {
      return res.status(400).json({
        error: 'Invalid npub format',
        message: 'Please provide a valid npub (e.g., npub1...)'
      });
    }

    // Lookup Nostr profile
    console.log('Looking up Nostr profile for:', npub);
    const profileResult = await nostrService.lookupProfile(npub);
    
    if (!profileResult.success) {
      return res.status(404).json({
        error: 'Nostr profile not found',
        message: profileResult.message,
        stats: profileResult.stats,
        failedRelays: profileResult.failedRelays
      });
    }

    // Get user and find the pin (supports email, provider, and admin mode)
    const user = await findMentionsUser(req.user);
    
    if (!user || !user.mention_preferences?.pinned_mentions) {
      return res.status(404).json({ 
        error: 'User or pins not found' 
      });
    }

    // Find the specific pin
    const pinIndex = user.mention_preferences.pinned_mentions.findIndex(pin => pin.id === pinId);
    
    if (pinIndex === -1) {
      return res.status(404).json({ 
        error: 'Pin not found',
        message: `Pin with id ${pinId} not found`
      });
    }

    const pin = user.mention_preferences.pinned_mentions[pinIndex];

    // Update pin with Nostr profile data while preserving existing data
    const updatedPin = {
      ...pin,
      id: pin.id, // Explicitly preserve the pin ID
      label: pin.label, // Preserve label
      twitter_profile: pin.twitter_profile, // Preserve Twitter data
      nostr_profile: profileResult.profile, // Add/update Nostr data
      is_cross_platform: true,
      source_mapping_id: pin.source_mapping_id,
      mapping_confidence: pin.mapping_confidence,
      usage_count: pin.usage_count,
      is_adopted: pin.is_adopted,
      updated_at: new Date()
    };

    // Update the pin in the array
    user.mention_preferences.pinned_mentions[pinIndex] = updatedPin;
    
    // Save the user
    await user.save();

    console.log('Successfully linked Nostr profile to pin:', {
      pinId,
      npub,
      nostrName: profileResult.profile.name || profileResult.profile.displayName
    });

    res.json({
      success: true,
      message: 'Nostr profile linked successfully',
      pin: updatedPin,
      nostrProfile: profileResult.profile
    });

  } catch (error) {
    console.error('Error linking Nostr profile to pin:', error);
    res.status(500).json({ 
      error: 'Failed to link Nostr profile',
      message: error.message 
    });
  }
});

// POST /api/mentions/pins/:pinId/unlink-nostr
router.post('/pins/:pinId/unlink-nostr', authenticateToken, async (req, res) => {
  try {
    const { pinId } = req.params;
    
    console.log('Unlink Nostr request for pin:', pinId);

    // Get user and find the pin (supports email, provider, and admin mode)
    const user = await findMentionsUser(req.user);
    
    if (!user || !user.mention_preferences?.pinned_mentions) {
      return res.status(404).json({ 
        error: 'User or pins not found' 
      });
    }

    // Find the specific pin
    const pinIndex = user.mention_preferences.pinned_mentions.findIndex(pin => pin.id === pinId);
    
    if (pinIndex === -1) {
      return res.status(404).json({ 
        error: 'Pin not found',
        message: `Pin with id ${pinId} not found`
      });
    }

    const pin = user.mention_preferences.pinned_mentions[pinIndex];

    // Update pin to remove Nostr profile
    const updatedPin = {
      ...pin,
      nostr_profile: null,
      is_cross_platform: false,
      updated_at: new Date()
    };

    // Update the pin in the array
    user.mention_preferences.pinned_mentions[pinIndex] = updatedPin;
    
    // Save the user
    await user.save();

    console.log('Successfully unlinked Nostr profile from pin:', pinId);

    res.json({
      success: true,
      message: 'Nostr profile unlinked successfully',
      pin: updatedPin
    });

  } catch (error) {
    console.error('Error unlinking Nostr profile from pin:', error);
    res.status(500).json({ 
      error: 'Failed to unlink Nostr profile',
      message: error.message 
    });
  }
});

// GET /api/mentions/pins/:pinId/suggest-nostr
router.get('/pins/:pinId/suggest-nostr', authenticateToken, async (req, res) => {
  try {
    const { pinId } = req.params;
    
    console.log('Suggest Nostr profiles for pin:', pinId);

    // Get user and find the pin (supports email, provider, and admin mode)
    const user = await findMentionsUser(req.user);
    
    if (!user || !user.mention_preferences?.pinned_mentions) {
      return res.status(404).json({ 
        error: 'User or pins not found' 
      });
    }

    // Find the specific pin
    const pin = user.mention_preferences.pinned_mentions.find(pin => pin.id === pinId);
    
    if (!pin) {
      return res.status(404).json({ 
        error: 'Pin not found',
        message: `Pin with id ${pinId} not found`
      });
    }

    if (!pin.twitter_profile) {
      return res.status(400).json({
        error: 'Pin must have Twitter profile for suggestions',
        message: 'Cannot suggest Nostr profiles for non-Twitter pins'
      });
    }

    // Search for existing cross-platform mappings
    const twitterUsername = pin.twitter_profile.username;
    const mappings = await SocialProfileMapping.find({
      'twitter_profile.username': { $regex: new RegExp(`^${twitterUsername}$`, 'i') }
    }).limit(5).lean();

    const suggestions = mappings.map(mapping => ({
      npub: mapping.nostr_profile.npub,
      nostrProfile: mapping.nostr_profile,
      confidence: mapping.confidence_score,
      usageCount: mapping.usage_count,
      verificationMethod: mapping.verification_method,
      mappingId: mapping._id
    }));

    res.json({
      success: true,
      pin: pin,
      suggestions: suggestions,
      message: suggestions.length > 0 
        ? `Found ${suggestions.length} potential Nostr mapping(s)` 
        : 'No existing mappings found for this Twitter profile'
    });

  } catch (error) {
    console.error('Error getting Nostr suggestions for pin:', error);
    res.status(500).json({ 
      error: 'Failed to get suggestions',
      message: error.message 
    });
  }
});

module.exports = router; 