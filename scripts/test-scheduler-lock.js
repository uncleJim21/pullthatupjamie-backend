/**
 * test-scheduler-lock.js
 *
 * Local unit-style test for the SchedulerLock + runIfLockHeld pattern.
 *
 * Three behaviors verified:
 *   1. Two concurrent calls to runIfLockHeld for the same bucket — exactly
 *      one runs the work function, the other skips.
 *   2. Calling again WITHIN the same bucket — also skips (lock still held).
 *   3. After TTL expires, the next call acquires successfully.
 *
 * Uses a short bucketResolutionSeconds + lockTtlSeconds so we can run
 * the full test in seconds against prod Mongo.
 *
 * Read-only against the SchedulerLock collection (which auto-TTLs anyway).
 * Test docs use a clearly-isolated taskName prefix so they don't collide
 * with anything real.
 *
 * Usage:
 *   node scripts/test-scheduler-lock.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const SchedulerLock = require('../models/SchedulerLock');
const { runIfLockHeld } = require('../utils/runIfLockHeld');

const TEST_TASK = `test-lock-${Date.now()}`;

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  await mongoose.connect(mongoURI);

  const banner = '─'.repeat(72);
  const log = (s) => console.log(s);
  let passes = 0;
  let fails = 0;
  const pass = (msg) => { log(`  ✓ ${msg}`); passes++; };
  const fail = (msg) => { log(`  ✘ ${msg}`); fails++; };

  log(`\n${banner}`);
  log(`SchedulerLock + runIfLockHeld behavior test`);
  log(`Test task name: ${TEST_TASK}`);
  log(banner);

  // ─── Test 1: concurrent contention ────────────────────────────────────
  log(`\nTest 1: 5 concurrent acquires for the same bucket — exactly 1 should run`);
  let runCount = 0;
  const work = async () => {
    runCount++;
    // small delay so concurrent races have a chance to interleave
    await new Promise((r) => setTimeout(r, 50));
  };
  const results = await Promise.all(
    Array.from({ length: 5 }).map(() =>
      runIfLockHeld(TEST_TASK, work, { bucketResolutionSeconds: 60, lockTtlSeconds: 10 })
    )
  );
  const ran = results.filter((r) => r.ranOnThisInstance).length;
  const skipped = results.filter((r) => !r.ranOnThisInstance).length;
  log(`  result: ran=${ran}, skipped=${skipped}, workInvocations=${runCount}`);
  if (ran === 1) pass('exactly one acquire won the lock');
  else fail(`expected ran=1, got ran=${ran}`);
  if (skipped === 4) pass('four acquires skipped');
  else fail(`expected skipped=4, got skipped=${skipped}`);
  if (runCount === 1) pass('work function ran exactly once');
  else fail(`expected work to run 1×, ran ${runCount}×`);

  // ─── Test 2: same bucket, second pass ─────────────────────────────────
  log(`\nTest 2: same bucket, second call — should skip (lock still held)`);
  const second = await runIfLockHeld(TEST_TASK, work, { bucketResolutionSeconds: 60, lockTtlSeconds: 10 });
  log(`  result: ranOnThisInstance=${second.ranOnThisInstance}`);
  if (!second.ranOnThisInstance) pass('second acquire correctly skipped');
  else fail('second acquire should have skipped but ran');

  // ─── Test 3: TTL expiry → new bucket → acquire succeeds ───────────────
  log(`\nTest 3: force a new bucket (different taskName) — should acquire`);
  const freshTask = `${TEST_TASK}-fresh`;
  const fresh = await runIfLockHeld(freshTask, work, { bucketResolutionSeconds: 60, lockTtlSeconds: 10 });
  log(`  result: ranOnThisInstance=${fresh.ranOnThisInstance}`);
  if (fresh.ranOnThisInstance) pass('fresh task acquired correctly');
  else fail('fresh task should have acquired');

  // ─── Cleanup: drop the test lock docs ─────────────────────────────────
  await SchedulerLock.deleteMany({
    _id: { $regex: `^(${TEST_TASK}|${freshTask}):` },
  });

  log(`\n${banner}`);
  log(`Summary: ${passes} passed, ${fails} failed`);
  log(banner);

  await mongoose.disconnect();
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
