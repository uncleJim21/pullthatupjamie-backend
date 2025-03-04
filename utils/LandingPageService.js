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
async function fetchPodcastEpisodes(feedUrl, limit = 35) {
  try {
    const response = await axios.post('https://rss-extractor-app-yufbq.ondigitalocean.app/getFeed', {
      feedUrl,
      feedId: 7181269,
      limit
    }, {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'authorization': 'Bearer: no-token'
      }
    });

    return response.data;
  } catch (error) {
    console.error('Error fetching podcast feed:', error);
    throw error;
  }
}

// Main service function to get feed data
async function getPodcastFeed(feedId) {
    try {
      const feedData = await getProPodcastByFeedId(feedId);
      if (!feedData) {
        throw new Error('Feed not found');
      }

      // console.log(`feedData:${JSON.stringify(feedData,null,2)}`)
      // return {}
  
      const feedResponse = await fetchPodcastEpisodes(feedData.feedUrl);
      
      if (!feedResponse?.episodes?.episodes || !Array.isArray(feedResponse.episodes.episodes)) {
        throw new Error('Invalid feed data structure');
      }

  
      return {
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
    } catch (error) {
      console.error('Error in getPodcastFeed:', error);
      throw error;
    }
  }

module.exports = {
  getPodcastFeed
};