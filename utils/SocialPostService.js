const SocialPost = require('../models/SocialPost');
const { verifyEvent } = require('nostr-tools');

const DEFAULT_POST_RELAYS = [
    "wss://relay.primal.net",
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.snort.social"
];

const SIGNED_EVENT_REQUIRED_FIELDS = ['id', 'pubkey', 'created_at', 'kind', 'content', 'sig'];

function assert(condition, message, status = 400) {
    if (!condition) {
        const err = new Error(message);
        err.status = status;
        throw err;
    }
}

/**
 * Validates a signedEvent object: structural completeness + cryptographic verification.
 * Checks NIP-01 required fields, then verifies the event ID hash and Schnorr signature.
 * @param {Object} signedEvent
 * @throws {Error} with status 400 if invalid
 */
function validateSignedEvent(signedEvent) {
    assert(signedEvent, 'Missing signedEvent in platformData.');

    const missing = SIGNED_EVENT_REQUIRED_FIELDS.filter(f => signedEvent[f] === undefined || signedEvent[f] === null);
    assert(missing.length === 0, `Incomplete signedEvent: missing required fields: ${missing.join(', ')}`);

    assert(Array.isArray(signedEvent.tags), 'signedEvent.tags must be an array');

    const isValid = verifyEvent(signedEvent);
    assert(isValid, 'signedEvent failed cryptographic verification (invalid event ID hash or Schnorr signature). This event will be rejected by Nostr relays.');
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
 * @param {string} [params.status='unsigned'] - 'unsigned' (default, safe for drafts) or 'scheduled' (requires signedEvent for nostr)
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
        scheduledPostSlotId,
        status: requestedStatus = 'unsigned'
    } = params || {};

    // Require at least one identifier
    assert(adminUserId || adminEmail, 'Missing admin identifier (adminUserId or adminEmail required)');
    const hasText = !!(text && String(text).trim().length > 0);
    const hasMedia = !!(mediaUrl && String(mediaUrl).trim().length > 0);
    assert(hasText || hasMedia, 'Either text or media URL is required');
    assert(scheduledFor, 'Scheduled date/time is required');
    assert(Array.isArray(platforms) && platforms.length > 0, 'At least one platform must be specified');

    const validStatuses = ['unsigned', 'scheduled'];
    assert(validStatuses.includes(requestedStatus), `Invalid status: ${requestedStatus}. Must be one of: ${validStatuses.join(', ')}`);

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

        if (platform === 'nostr') {
            if (requestedStatus === 'scheduled') {
                validateSignedEvent(platformData.signedEvent);
            } else if (platformData.signedEvent) {
                validateSignedEvent(platformData.signedEvent);
            }

            if (!platformData.nostrRelays || platformData.nostrRelays.length === 0) {
                platformData.nostrRelays = [...DEFAULT_POST_RELAYS];
                console.log(`Defaulting to top 4 relays for Nostr post`);
            }
        }

        const socialPost = new SocialPost({
            adminUserId: adminUserId || undefined,
            adminEmail: adminEmail || undefined,
            platform,
            scheduledFor: scheduledDate,
            timezone,
            scheduledPostSlotId,
            content: {
                text: hasText ? String(text).trim() : '',
                mediaUrl: hasMedia ? String(mediaUrl) : null
            },
            platformData,
            status: requestedStatus
        });

        await socialPost.save();
        createdPosts.push(socialPost);
    }

    return createdPosts;
}

module.exports = {
    schedulePosts,
    validateSignedEvent,
    DEFAULT_POST_RELAYS,
    SIGNED_EVENT_REQUIRED_FIELDS
};


