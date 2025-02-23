const axios = require('axios');
const { parse } = require('node-html-parser');


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
    listenLink: "https://creators.spotify.com/pod/show/earlydayspod/episodes/Shopstr-e2ttnqi"
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
      const feedData = mockFeeds[feedId];
      if (!feedData) {
        throw new Error('Feed not found');
      }
  
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