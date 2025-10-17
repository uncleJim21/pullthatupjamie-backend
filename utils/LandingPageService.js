const axios = require('axios');
const { parse } = require('node-html-parser');
const {getProPodcastByFeedId} = require('./ProPodcastUtils')

// Mock database for feed metadata
const mockFeeds = {
  '7181269': {
    id: '7181269',
    headerColor: "#0A1930",
    logoUrl: "https://d3t3ozftmdmh3i.cloudfront.net/staging/podcast_uploaded_nologo/42872616/42872616-1737246678005-991fe8ccc838e.jpg",
    title: "Early Days",
    creator: "Car",
    lightningAddress: "pleblab@getalby.com",
    description: "In Early Days, we dive into the early stage—and often chaotic—world of first-time founders. Each episode unpacks the pivotal decisions, unforeseen challenges, and valuable lessons learned along the way, featuring candid conversations with entrepreneurs, investors, and industry experts who've been there.",
    feedUrl: "https://anchor.fm/s/100230220/podcast/rss",
    listenLink: "https://creators.spotify.com/pod/show/earlydayspod",
    subscribeLinks:{
      appleLink:"https://podcasts.apple.com/us/podcast/early-days/id1792360751",
      spotifyLink:"https://creators.spotify.com/pod/show/earlydayspod/episodes/Shopstr-e2ttnqi",
      youtubeLink:"https://www.youtube.com/watch?v=u2vmnmy3HgI&list=PLvxf1TpXqCAID5M_k5VkwrURU2M8YYGpZ&index=1"
    }
  },
  '5015946': {
    id: '5015946',
    headerColor: "#305d52",
    logoUrl: "https://d3t3ozftmdmh3i.cloudfront.net/staging/podcast_uploaded_nologo/21611220/21611220-1732893316589-fb33705d325d1.jpg",
    title: "Green Candle Investments Podcast with Brandon Keys",
    creator: "Green Candle Investments",
    lightningAddress: "greencandleit@strike.me",
    description: "I bring viewers easy-to-digest information about investing, both in traditional equities and in Bitcoin.\nTune in every Monday for new Macro Insights podcasts and Friday for new State of Bitcoin podcasts, offering deep dives into current developments, emerging trends, and expert analyses. Stay connected with us on Twitter and Instagram @GreenCandleit for real-time updates, and engage with host, Brandon, at @bkeys1010 on Twitter.\nDon't miss out – share, subscribe, and actively participate in the conversation! Spread the word about our podcast!",
    feedUrl: "https://anchor.fm/s/8168b150/podcast/rss",
    listenLink: "https://podcasters.spotify.com/pod/show/greencandleit",
    subscribeLinks:{
      appleLink:"https://podcasts.apple.com/us/podcast/green-candle-investments-podcast-with-brandon-keys/id1608445593",
      spotifyLink:"https://creators.spotify.com/pod/show/greencandleit",
      youtubeLink:"https://www.youtube.com/@GreenCandle"
    }
  },
  '3498055': {
    id: '3498055',
    headerColor: "#deb83e",
    logoUrl: "https://d3t3ozftmdmh3i.cloudfront.net/production/podcast_uploaded_nologo/10262374/10262374-1603995280202-46e057c35b6d3.jpg",
    title: "Convos On The Pedicab",
    creator: "Alex Strenger",
    lightningAddress: "effreyjepstein@getalby.com",
    description: "Bringing people together on a pedicab in Austin, TX in order discuss polarizing topics and come up with meaningful solutions on them.",
    feedUrl: "https://anchor.fm/s/3dc3ba58/podcast/rss",
    listenLink: "https://creators.spotify.com/pod/show/alex-strenger",
    subscribeLinks:{
      appleLink:"https://podcasts.apple.com/us/podcast/convos-on-the-pedicab/id1538283513",
      spotifyLink:"https://creators.spotify.com/pod/show/alex-strenger",
      youtubeLink:"https://www.youtube.com/watch?v=i_V5ZqEGPr0&list=PLmjXKO8Lt3ymQvaOSTDMwcD0PJ7-NBYe_"
    }
  }
};

function sanitizeDescription(htmlDescription) {
    if (!htmlDescription) return '';
  
    try {
      // Parse the HTML
      const root = parse(htmlDescription);
  
      // Function to process text content recursively
      function processNode(node) {
        // If it's a text node, return its content
        if (node.nodeType === 3) {
          return node.text.trim();
        }
  
        // Get tag name if it exists
        const tagName = node.tagName ? node.tagName.toLowerCase() : '';
  
        // Handle different types of elements
        let result = '';
  
        // Handle lists
        if (tagName === 'li') {
          result += '\n• ';
        }
  
        // Process all child nodes
        if (node.childNodes) {
          result += node.childNodes.map(child => processNode(child)).join('');
        }
  
        // Add appropriate spacing
        if (['p', 'div', 'ul', 'ol', 'br'].includes(tagName)) {
          result += '\n';
        }
  
        return result;
      }
  
      // Process the entire document
      let text = processNode(root);
  
      // Clean up the resulting text
      return text
        .replace(/\n\s*\n\s*\n/g, '\n\n')  // Replace multiple newlines with double newlines
        .replace(/^\s+|\s+$/g, '')          // Trim start and end
        .replace(/ +/g, ' ')                // Replace multiple spaces with single space
        .replace(/•\s+/g, '• ')             // Clean up bullet points
        .replace(/\n+/g, '\n')              // Clean up excessive newlines
        .trim();
    } catch (error) {
      console.error('Error sanitizing description:', error);
      // Return a cleaned version of the string by removing all HTML tags as fallback
      return htmlDescription
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  

// Helper function to format duration
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  const padZero = (num) => num.toString().padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${padZero(minutes)}:${padZero(remainingSeconds)}`;
  }
  return `${minutes}:${padZero(remainingSeconds)}`;
}

// Function to fetch episodes from RSS feed
async function fetchPodcastEpisodes(feedUrl, feedId, limit = 35) {
  const { printLog } = require('../constants');
  const rssRequestStartTime = Date.now();
  
  printLog(`📡 [TIMING] Starting RSS request to external service...`);
  printLog(`🔗 [TIMING] RSS URL: ${feedUrl}`);
  printLog(`⏱️ [TIMING] Timeout set to: 10000ms`);
  
  try {
    const response = await axios.post('https://rss-extractor-app-yufbq.ondigitalocean.app/getFeed', {
      feedUrl,
      feedId: feedId, // Use the actual feedId parameter instead of hardcoded value
      limit
    }, {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'authorization': 'Bearer: no-token'
      },
      timeout: 10000 // Add timeout to prevent hanging requests
    });

    const rssRequestEndTime = Date.now();
    const rssRequestTime = rssRequestEndTime - rssRequestStartTime;
    
    printLog(`✅ [TIMING] RSS service responded in ${rssRequestTime}ms`);
    printLog(`📊 [TIMING] RSS response status: ${response.status}`);
    printLog(`📦 [TIMING] RSS response size: ${JSON.stringify(response.data).length} characters`);
    
    if (response.data?.episodes?.episodes) {
      printLog(`🎧 [TIMING] RSS returned ${response.data.episodes.episodes.length} episodes`);
    }

    return response.data;
  } catch (error) {
    const rssErrorTime = Date.now() - rssRequestStartTime;
    printLog(`❌ [TIMING] RSS service failed after ${rssErrorTime}ms`);
    
    console.error('Error fetching podcast feed:', error);
    
    // Handle specific error from RSS extractor service
    if (error.response?.status === 500 && error.response?.data?.message === 'invalid code lengths set') {
      printLog(`❌ [TIMING] RSS parsing error: invalid code lengths set`);
      throw new Error('RSS feed parsing failed - feed may be corrupted or unsupported');
    }
    
    // Handle other HTTP errors
    if (error.response) {
      printLog(`❌ [TIMING] RSS HTTP error: ${error.response.status} - ${error.response.data?.message || 'Unknown error'}`);
      throw new Error(`RSS service error: ${error.response.status} - ${error.response.data?.message || 'Unknown error'}`);
    }
    
    // Handle network/timeout errors
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      printLog(`❌ [TIMING] RSS timeout error: ${error.code}`);
      throw new Error('RSS service timeout - please try again later');
    }
    
    printLog(`❌ [TIMING] RSS unknown error: ${error.message}`);
    throw new Error(`Failed to fetch podcast episodes: ${error.message}`);
  }
}

// Main service function to get feed data
async function getPodcastFeed(feedId) {
    const { printLog } = require('../constants');
    const serviceStartTime = Date.now();
    
    printLog(`🔍 [TIMING] getPodcastFeed started for feedId: ${feedId}`);
    
    try {
      // Try to get cached data first
      const cachedData = await global.podcastRssCache?.getPodcastData(feedId);
      
      if (cachedData) {
        const cacheTime = Date.now() - serviceStartTime;
        printLog(`⚡ [TIMING] Cache hit! Returning cached data in ${cacheTime}ms`);
        return cachedData;
      }

      // Fallback to original logic if no cache or cache miss
      printLog(`🔄 [TIMING] Cache miss, falling back to direct RSS fetch`);
      
      const dbStartTime = Date.now();
      printLog(`🗄️ [TIMING] Querying database for feed data...`);
      
      const feedData = await getProPodcastByFeedId(feedId);
      
      const dbEndTime = Date.now();
      printLog(`✅ [TIMING] Database query completed in ${dbEndTime - dbStartTime}ms`);
      
      if (!feedData) {
        printLog(`❌ [TIMING] Feed not found in database`);
        throw new Error('Feed not found');
      }

      printLog(`📋 [TIMING] Found feed: ${feedData.title} by ${feedData.creator}`);
  
      try {
        const rssStartTime = Date.now();
        printLog(`📡 [TIMING] Fetching episodes from RSS service...`);
        
        const feedResponse = await fetchPodcastEpisodes(feedData.feedUrl, feedId);
        
        const rssEndTime = Date.now();
        printLog(`✅ [TIMING] RSS service completed in ${rssEndTime - rssStartTime}ms`);
        
        if (!feedResponse?.episodes?.episodes || !Array.isArray(feedResponse.episodes.episodes)) {
          printLog(`❌ [TIMING] Invalid RSS response structure`);
          throw new Error('Invalid feed data structure');
        }

        const mappingStartTime = Date.now();
        printLog(`🔄 [TIMING] Mapping ${feedResponse.episodes.episodes.length} episodes...`);

        const result = {
          ...feedData,
          episodes: feedResponse.episodes.episodes.map(episode => ({
            id: episode.itemUUID || `episode-${Date.now()}`,
            title: episode.itemTitle || 'Untitled Episode',
            date: episode.publishedDate ? new Date(episode.publishedDate * 1000).toLocaleDateString() : 'No date',
            duration: episode.length ? formatDuration(episode.length) : '00:00',
            audioUrl: episode.itemUrl || '',
            description: episode.description ? sanitizeDescription(episode.description) : '',
            episodeNumber: episode.episodeNumber || '',
            episodeImage: episode.episodeImage || feedData.logoUrl,
            listenLink: feedData.listenLink
          }))
        };
        
        const mappingEndTime = Date.now();
        printLog(`✅ [TIMING] Episode mapping completed in ${mappingEndTime - mappingStartTime}ms`);
        
        const totalServiceTime = Date.now() - serviceStartTime;
        printLog(`🎯 [TIMING] getPodcastFeed total time: ${totalServiceTime}ms`);
        
        return result;
      } catch (rssError) {
        const rssErrorTime = Date.now() - serviceStartTime;
        printLog(`⚠️ [TIMING] RSS service failed after ${rssErrorTime}ms: ${rssError.message}`);
        console.error('RSS service failed, returning basic feed data:', rssError.message);
        
        // Return basic feed data without episodes as fallback
        const fallbackResult = {
          ...feedData,
          episodes: [],
          error: 'Episode data temporarily unavailable',
          errorDetails: rssError.message
        };
        
        const totalFallbackTime = Date.now() - serviceStartTime;
        printLog(`🔄 [TIMING] Fallback response prepared in ${totalFallbackTime}ms`);
        
        return fallbackResult;
      }
    } catch (error) {
      const errorTime = Date.now() - serviceStartTime;
      printLog(`❌ [TIMING] getPodcastFeed failed after ${errorTime}ms: ${error.message}`);
      console.error('Error in getPodcastFeed:', error);
      throw error;
    }
  }

module.exports = {
  getPodcastFeed
};