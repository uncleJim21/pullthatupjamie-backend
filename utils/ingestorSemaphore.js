'use strict';
/**
 * Mongo-backed semaphore around triggering the external ingestor.
 *
 * Why: the ingestor re-processes (and re-embeds) every enabled feed each time
 * it is asked. Two triggers close together — overlapping backend instances
 * during a redeploy, a scheduled slot plus a manual kick, a crash-restart —
 * double the embedding bill without adding anything to the corpus. This
 * guard makes "at most one ingest trigger per window" a database fact that
 * holds across containers, using the same atomic-insert pattern as
 * utils/runIfLockHeld.js (SchedulerLock, unique _id, TTL cleanup).
 *
 * Semantics:
 *   acquire()  — insert the lock doc; wins only if no unexpired lock exists.
 *                A stale doc (expiresAt in the past, TTL sweep not yet run)
 *                is taken over.
 *   release()  — delete the lock. Called only when the trigger FAILED to
 *                reach the ingestor, so a network blip does not block the
 *                next slot. A successful trigger keeps the lock for the full
 *                window on purpose.
 *
 * Window: INGESTOR_MIN_INTERVAL_MINUTES (default 180). The scheduled slots
 * are ~7 h apart, so a 3 h window blocks duplicates without ever blocking a
 * legitimate next run.
 */
const SchedulerLock = require('../models/SchedulerLock');

const LOCK_ID = 'podcast-ingestor:trigger';
const WINDOW_MINUTES = parseInt(process.env.INGESTOR_MIN_INTERVAL_MINUTES || '180', 10);
const HOSTNAME = process.env.HOSTNAME || process.env.HOST || 'unknown';

async function acquire({ jobId, windowMinutes = WINDOW_MINUTES } = {}) {
  const now = new Date();
  const doc = {
    _id: LOCK_ID,
    taskName: 'podcast-ingestor',
    bucket: jobId || now.toISOString(),
    instanceId: HOSTNAME,
    acquiredAt: now,
    expiresAt: new Date(now.getTime() + windowMinutes * 60 * 1000),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await SchedulerLock.create(doc);
      return { acquired: true, lockId: LOCK_ID, expiresAt: doc.expiresAt };
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
      const existing = await SchedulerLock.findById(LOCK_ID).lean();
      if (existing && existing.expiresAt > now) {
        return {
          acquired: false, lockId: LOCK_ID,
          heldBy: existing.instanceId, since: existing.acquiredAt, until: existing.expiresAt, jobId: existing.bucket,
        };
      }
      // Expired but not yet swept by the TTL monitor: take it over.
      await SchedulerLock.deleteOne({ _id: LOCK_ID, expiresAt: { $lte: now } });
    }
  }
  return { acquired: false, lockId: LOCK_ID, reason: 'contended' };
}

async function release() {
  await SchedulerLock.deleteOne({ _id: LOCK_ID });
}

async function status() {
  const existing = await SchedulerLock.findById(LOCK_ID).lean();
  if (!existing || existing.expiresAt <= new Date()) return { held: false };
  return { held: true, heldBy: existing.instanceId, since: existing.acquiredAt, until: existing.expiresAt, jobId: existing.bucket };
}

module.exports = { acquire, release, status, LOCK_ID, WINDOW_MINUTES };
