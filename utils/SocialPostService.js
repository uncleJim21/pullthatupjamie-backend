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
 * @param {string} [params.adminUserId] - MongoDB User _id (preferred for new users)
 * @param {string} [params.adminEmail] - Owner/admin email (legacy, optional for non-email users)
 * @param {string} [params.text]
 * @param {string} [params.mediaUrl]
 * @param {string|Date} params.scheduledFor - ISO string or Date
 * @param {string[]} params.platforms - e.g., ['twitter','nostr']
 * @param {string} [params.timezone='America/Chicago']
 * @param {Object} [params.platformData]
 * @param {string} [params.scheduledPostSlotId]
 * @returns {Promise<Array>} created SocialPost documents
 */
async function schedulePosts(params) {
    const {
        adminUserId,
        adminEmail,
        text,
        mediaUrl,
        scheduledFor,
        platforms,
        timezone = 'America/Chicago',
        platformData: inputPlatformData = {},
        scheduledPostSlotId
    } = params || {};

    // Require at least one identifier
    assert(adminUserId || adminEmail, 'Missing admin identifier (adminUserId or adminEmail required)');
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
            adminUserId: adminUserId || undefined,  // NEW: Store userId if available
            adminEmail: adminEmail || undefined,    // Keep for backward compat
            platform,
            scheduledFor: scheduledDate,
            timezone,
            scheduledPostSlotId,
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


