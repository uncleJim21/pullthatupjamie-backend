#!/usr/bin/env node
/**
 * Grant (or revoke) Tape access for a user by writing the `tape-basic-user`
 * Entitlement that the Tape route gate (services/tape/tapeAuth.hasTapeAccess)
 * checks. Idempotent; scoped to one user; not metered (maxUsage -1).
 *
 *   node scripts/grant-tape-access.js <userId|email> [--revoke] [--dry-run]
 *
 * Writes to the DB at MONGO_URI. Entitlements are durable in Mongo, so the grant
 * is read by any backend sharing that DB (unlike the in-memory cache).
 */

require('dotenv').config();
const mongoose = require('mongoose');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const revoke = has('--revoke');
const dryRun = has('--dry-run');
// Positional target: a 24-hex Mongo userId OR an email present in the DB.
const target = argv.find((a) => !a.startsWith('--'));

const ENTITLEMENT = 'tape-basic-user';

(async () => {
  if (!target) { console.error('Usage: node scripts/grant-tape-access.js <userId|email> [--revoke] [--dry-run]'); process.exit(1); }
  if (!process.env.MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }
  await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log(`[grant] connected to MONGO_URI host=${mongoose.connection.host} db=${mongoose.connection.name}`);

  const { User } = require('../models/shared/UserSchema');
  const { Entitlement } = require('../models/Entitlement');
  const { hasTapeAccess } = require('../services/tape/tapeAuth');

  // 1) Resolve target by 24-hex userId OR email
  let user = null;
  if (/^[a-f0-9]{24}$/i.test(target)) {
    user = await User.findById(target).lean();
  } else if (target.includes('@')) {
    const doc = await User.findByEmail(target);
    user = doc && (doc.toObject ? doc.toObject() : doc);
  } else {
    console.error(`[grant] ABORT: target must be a 24-hex userId or an email (got "${target}")`);
    await mongoose.disconnect(); process.exit(1);
  }
  if (!user) { console.error(`[grant] ABORT: no user found for "${target}"`); await mongoose.disconnect(); process.exit(2); }
  const userId = String(user._id);
  console.log(`[grant] target: ${userId} email=${user.email} provider=${user.authProvider?.provider}`);

  // 2) Existing grant?
  const filter = { identifier: userId, identifierType: 'mongoUserId', entitlementType: ENTITLEMENT };
  const existing = await Entitlement.findOne(filter).lean();
  console.log(`[grant] existing record: ${existing ? `status=${existing.status} maxUsage=${existing.maxUsage}` : 'none'}`);

  if (dryRun) { console.log('[grant] --dry-run, no write'); await mongoose.disconnect(); return; }

  // 3) Grant / revoke (idempotent upsert, scoped to this compound key)
  const farFuture = new Date(Date.now() + 100 * 365 * 86400 * 1000);
  const update = revoke
    ? { $set: { status: 'suspended' } }
    : {
        $set: { status: 'active', maxUsage: -1, periodLengthDays: 36500, nextResetDate: farFuture },
        $setOnInsert: { usedCount: 0, periodStart: new Date() },
      };
  const rec = await Entitlement.findOneAndUpdate(filter, update, { upsert: true, new: true, setDefaultsOnInsert: true });
  console.log(`[grant] ${revoke ? 'REVOKED' : 'GRANTED'} -> status=${rec.status} maxUsage=${rec.maxUsage} entitlementType=${rec.entitlementType}`);

  // 4) Verify via the exact gate the routes use
  const ok = await hasTapeAccess(userId);
  console.log(`[grant] hasTapeAccess(${userId}) = ${ok} (expect ${revoke ? 'false' : 'true'})`);

  await mongoose.disconnect();
  process.exit(ok === !revoke ? 0 : 4);
})().catch((e) => { console.error('[grant] error:', e.message); process.exit(1); });
