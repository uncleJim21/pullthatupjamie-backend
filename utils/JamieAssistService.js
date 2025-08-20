const { OpenAI } = require('openai');
const { WorkProductV2 } = require('../models/WorkProductV2');
const { findSimilarDiscussions, getFeedById, getEpisodeByGuid } = require('../agent-tools/pineconeTools');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function truncateText(text, wordLimit = 150) {
    if (!text) return '';
    const words = String(text).split(/\s+/);
    if (words.length <= wordLimit) return text;
    return words.slice(0, wordLimit).join(' ') + '...';
}

async function getFirstParagraph(feedId, guid) {
    try {
        const dummyVector = Array(1536).fill(0);
        const results = await findSimilarDiscussions({
            embedding: dummyVector,
            feedIds: [feedId],
            guid,
            limit: 1,
            query: ''
        });
        return results?.[0] || null;
    } catch (_) {
        return null;
    }
}

/**
 * Streams Jamie Assist promotional content to the response using SSE.
 * Res is expected to be an Express response configured for SSE before calling.
 */
async function streamJamieAssist(res, lookupHash, additionalPrefs = '') {
    const clip = await WorkProductV2.findOne({ lookupHash });
    if (!clip) {
        res.status(404).json({ error: 'Clip not found' });
        return;
    }

    const result = clip.result || {};
    const { feedId, guid, clipText } = result;
    if (!clipText) {
        res.status(400).json({ error: 'Clip has no text content' });
        return;
    }

    let feedData = null;
    let episodeData = null;
    let firstParagraph = null;
    if (feedId && guid) {
        [feedData, episodeData, firstParagraph] = await Promise.all([
            getFeedById(feedId),
            getEpisodeByGuid(guid),
            getFirstParagraph(feedId, guid)
        ]);
    }

    const context = {
        clipText: clipText || 'No clip text available',
        episodeTitle: episodeData?.title || result.episodeTitle || 'Unknown episode',
        feedTitle: feedData?.title || result.feedTitle || 'Unknown podcast',
        episodeDescription: truncateText(episodeData?.description || result.episodeDescription || ''),
        feedDescription: truncateText(feedData?.description || result.feedDescription || ''),
        listenLink: firstParagraph?.listenLink || episodeData?.listenLink || '',
        additionalPrefs
    };

    const prompt = `
You are a social media expert who creates engaging promotional posts for podcast clips.

⚠️ IMPORTANT: ABSOLUTELY NO HASHTAGS! Do not include any hashtags (words preceded by #) in your response. ⚠️

Here's information about the clip:
- Podcast: ${context.feedTitle}
- Episode: ${context.episodeTitle}
- Episode Description: ${context.episodeDescription}
- Feed Description: ${context.feedDescription}
- Listen Link: ${context.listenLink}
- Clip Text: "${context.clipText}"
${typeof additionalPrefs === 'string' && additionalPrefs ? `User instructions: ${additionalPrefs}` : 'Use an engaging, conversational tone. Keep the tweet under 280 characters.'}

Create a compelling promotional tweet that:
1. no hash tags. no hash tags. no hash tags no hash tags. do not give me a hash tag.
2. Primarily focuses on the clip text component itself
3. Captures the essence of what makes this clip interesting
4. Is shareable and attention-grabbing
5. Includes relevant context about the podcast/episode when helpful
6. Stays under 150 characters to make sure there's room for the share link
7. If there is a guest make an effort to mention them and the host by name if it fits
8. REMINDER: ABSOLUTELY NO HASHTAGS - this is critical as hashtags severely reduce engagement
9. If the user asks for it reference the Listen Link when pushing for a call to action

REMEMBER: DO NOT USE ANY HASHTAGS (#) AT ALL. NOT EVEN ONE.

Write only the social media post text, without any explanations or quotation marks.
`;

    const stream = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        temperature: 0.7,
        max_tokens: 300
    });

    for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
}

module.exports = {
    streamJamieAssist
};


