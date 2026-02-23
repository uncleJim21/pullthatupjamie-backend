const TwitterService = require('./TwitterService');

/**
 * Core Twitter posting logic (shared by all routes)
 * @param {Object} identity - { userId, email }
 * @param {Object} content - { text, mediaUrl }
 * @returns {Promise<Object>} Post result
 */
async function postTweetCore(identity, content) {
  const { text, mediaUrl } = content;
  
  // Validate: text OR media (not both required)
  const hasText = !!(text && String(text).trim().length > 0);
  const hasMedia = !!(mediaUrl && String(mediaUrl).trim().length > 0);
  
  if (!hasText && !hasMedia) {
    throw new Error('Either text or media URL is required');
  }
  
  // Use existing TwitterService
  const twitterService = new TwitterService();
  const result = await twitterService.postTweet(identity, { text, mediaUrl });
  
  return result;
}

module.exports = { postTweetCore };
