const SchedulerLock = require('../models/SchedulerLock');

/**
 * Distributed mutex around a scheduled task.
 *
 * Tries to insert a SchedulerLock doc with a deterministic _id derived from
 * the task name and current time bucket. If the insert succeeds, this
 * container won the race and runs `work()`. If the insert fails with a
 * duplicate-key error, another container already claimed the slot and we
 * skip silently. All other errors are re-thrown.
 *
 * The bucket key is the task name plus a coarse time-bucket string
 * (year + month + day + hour by default), so the lock window matches
 * the natural cadence of an hourly task. For sub-hourly tasks, pass
 * `bucketResolutionSeconds` to make the bucket finer (e.g. 300 for a
 * 5-minute task).
 *
 * Lock TTL defaults to twice the bucket width so a crashed holder doesn't
 * block the next tick.
 *
 * Usage:
 *   await runIfLockHeld('podcast-rss-cache-refresh', async () => {
 *     await podcastRssCache.refreshAllPodcasts();
 *   });
 *
 * Same atomic-claim pattern as ClipQueueManager; just applied to time
 * buckets instead of queued work items.
 */

const HOSTNAME = process.env.HOSTNAME || process.env.HOST || 'unknown';

function bucketKey(bucketResolutionSeconds) {
  const now = new Date();
  if (bucketResolutionSeconds >= 3600) {
    // Hourly or coarser — bucket per hour.
    return now.toISOString().slice(0, 13); // "2026-05-21T14"
  }
  // Sub-hourly — round down to the nearest multiple of resolution.
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const slot = Math.floor(epochSeconds / bucketResolutionSeconds) * bucketResolutionSeconds;
  return new Date(slot * 1000).toISOString().slice(0, 19); // "2026-05-21T14:25:00"
}

/**
 * @param {string} taskName - Unique name for the scheduled task.
 * @param {Function} work - Async function to run if this container wins the lock.
 * @param {Object} [options]
 * @param {number} [options.bucketResolutionSeconds=3600] - Bucket width.
 *   Must match the task's cadence (e.g. 3600 for hourly, 300 for every 5 min).
 * @param {number} [options.lockTtlSeconds] - How long the lock doc lives.
 *   Defaults to 2× bucket width.
 * @param {boolean} [options.verbose=false] - Log skip events. Off by default
 *   to keep production logs clean.
 * @returns {Promise<{ranOnThisInstance: boolean, lockId: string}>}
 */
async function runIfLockHeld(taskName, work, options = {}) {
  const {
    bucketResolutionSeconds = 3600,
    lockTtlSeconds = bucketResolutionSeconds * 2,
    verbose = false,
  } = options;

  const bucket = bucketKey(bucketResolutionSeconds);
  const lockId = `${taskName}:${bucket}`;
  const now = new Date();

  try {
    await SchedulerLock.create({
      _id: lockId,
      taskName,
      bucket,
      instanceId: HOSTNAME,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + lockTtlSeconds * 1000),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      if (verbose) {
        console.log(`[scheduler-lock] skip ${lockId} — already held by another instance`);
      }
      return { ranOnThisInstance: false, lockId };
    }
    throw err;
  }

  if (verbose) {
    console.log(`[scheduler-lock] acquired ${lockId} on instance=${HOSTNAME}`);
  }

  await work();
  return { ranOnThisInstance: true, lockId };
}

module.exports = { runIfLockHeld };
