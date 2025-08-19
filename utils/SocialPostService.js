const SocialPost = require('../models/SocialPost');

function assert(condition, message, status = 400) {
    if (!condition) {
        const err = new Error(message);
        err.status = status;
        throw err;
    }
}

/**
 * Schedules social post(s) for one or more platforms.
 * Performs validation and creates separate SocialPost docs per platform.
 *
 * @param {Object} params
 * @param {string} params.adminEmail - Required. Owner/admin of the posts
 * @param {string} [params.text]
 * @param {string} [params.mediaUrl]
 * @param {string|Date} params.scheduledFor - ISO string or Date
 * @param {string[]} params.platforms - e.g., ['twitter','nostr']
 * @param {string} [params.timezone='America/Chicago']
 * @param {Object} [params.platformData]
 * @returns {Promise<Array>} created SocialPost documents
 */
async function schedulePosts(params) {
    const {
        adminEmail,
        text,
        mediaUrl,
        scheduledFor,
        platforms,
        timezone = 'America/Chicago',
        platformData: inputPlatformData = {}
    } = params || {};

    assert(adminEmail, 'Missing adminEmail');
    const hasText = !!(text && String(text).trim().length > 0);
    const hasMedia = !!(mediaUrl && String(mediaUrl).trim().length > 0);
    assert(hasText || hasMedia, 'Either text or media URL is required');
    assert(scheduledFor, 'Scheduled date/time is required');
    assert(Array.isArray(platforms) && platforms.length > 0, 'At least one platform must be specified');

    const validPlatforms = SocialPost.getPlatformOptions();
    const invalidPlatforms = platforms.filter(p => !validPlatforms.includes(p));
    assert(invalidPlatforms.length === 0, `Invalid platforms: ${invalidPlatforms.join(', ')}. Valid options: ${validPlatforms.join(', ')}`);

    const createdPosts = [];
    const scheduledDate = new Date(scheduledFor);

    for (const platform of platforms) {
        const platformData = platform === 'nostr' ? { ...inputPlatformData } : {};
        if (platform === 'twitter' && inputPlatformData?.twitterTokens) {
            platformData.twitterTokens = inputPlatformData.twitterTokens;
        }

        const socialPost = new SocialPost({
            adminEmail,
            platform,
            scheduledFor: scheduledDate,
            timezone,
            content: {
                text: hasText ? String(text).trim() : '',
                mediaUrl: hasMedia ? String(mediaUrl) : null
            },
            platformData
        });

        await socialPost.save();
        createdPosts.push(socialPost);
    }

    return createdPosts;
}

module.exports = {
    schedulePosts
};


