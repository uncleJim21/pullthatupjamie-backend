const express = require('express');
const router = express.Router();
const { User } = require('../models/User');
const { SocialProfileMapping } = require('../models/SocialProfileMappings');
const { TwitterApi } = require('twitter-api-v2');

// POST /api/mentions/search
router.post('/search', async (req, res) => {
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

  // Twitter search (exact username match for MVP)
  let twitterResults = [];
  if (platforms.includes('twitter')) {
    try {
      const client = new TwitterApi({
        appKey: process.env.TWITTER_CONSUMER_KEY,
        appSecret: process.env.TWITTER_CONSUMER_SECRET,
      });
      const appOnlyClient = await client.appLogin();
      const response = await appOnlyClient.v2.usersByUsernames([query.replace(/^@/, '').toLowerCase()], {
        'user.fields': [
          'id', 'name', 'username', 'verified', 'verified_type', 'profile_image_url', 'description', 'public_metrics', 'protected'
        ]
      });
      twitterResults = (response.data || []).map(user => ({
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
    } catch (err) {
      return res.status(500).json({
        error: 'TWITTER_API_ERROR',
        message: err.message
      });
    }
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

  // Personal pins (placeholder, no auth)
  let personalPins = [];
  if (includePersonalPins) {
    // TODO: Add user context/auth, for now just empty
    personalPins = [];
  }

  // Merge results (MVP: just Twitter + cross-mappings)
  let results = [...twitterResults];
  // Attach cross-mapping info to Twitter results if available
  if (includeCrossPlatformMappings && crossMappings.length > 0) {
    results = results.map(tw => {
      const mapping = crossMappings.find(m => m.twitter_profile.username.toLowerCase() === tw.username.toLowerCase());
      if (mapping) {
        return {
          ...tw,
          crossPlatformMapping: {
            hasNostrMapping: true,
            nostrNpub: mapping.nostr_profile.npub,
            nostrDisplayName: mapping.nostr_profile.displayName || null,
            confidence: mapping.confidence_score,
            verificationMethod: mapping.verification_method,
            isAdopted: false,
            mappingId: mapping._id.toString()
          }
        };
      }
      return tw;
    });
  }

  // TODO: Add Nostr and pins to results as needed

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

module.exports = router; 