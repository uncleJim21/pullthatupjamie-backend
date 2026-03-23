#!/usr/bin/env node
/**
 * One-off script: promote all unsigned Twitter posts to scheduled.
 * Twitter has no signing concept — these were created with a bad default.
 *
 * Usage: node scripts/fix-unsigned-twitter.js [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const SocialPost = require('../models/SocialPost');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    const mongoURI = process.env.DEBUG_MODE === 'true'
        ? process.env.MONGO_DEBUG_URI
        : process.env.MONGO_URI;

    await mongoose.connect(mongoURI);
    console.log('Connected to MongoDB');

    const filter = { platform: 'twitter', status: 'unsigned' };
    const count = await SocialPost.countDocuments(filter);
    console.log(`Found ${count} unsigned Twitter post(s)`);

    if (count === 0) {
        console.log('Nothing to do.');
        await mongoose.disconnect();
        process.exit(0);
    }

    if (DRY_RUN) {
        const posts = await SocialPost.find(filter).select('_id adminEmail scheduledFor content.text').lean();
        posts.forEach(p => console.log(`  [DRY RUN] ${p._id} | ${p.adminEmail || 'no-email'} | ${p.scheduledFor} | "${(p.content?.text || '').slice(0, 60)}"`));
        console.log(`\nDry run complete. ${count} post(s) would be updated. Re-run without --dry-run to apply.`);
    } else {
        const result = await SocialPost.updateMany(filter, { $set: { status: 'scheduled' } });
        console.log(`Updated ${result.modifiedCount} Twitter post(s) from "unsigned" -> "scheduled"`);
    }

    await mongoose.disconnect();
    console.log('Done.');
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
