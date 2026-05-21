const mongoose = require('mongoose');

/**
 * Distributed lock for scheduled tasks.
 *
 * When the API runs across multiple containers (App Platform autoscale 1-4),
 * in-process `node-cron` tasks fire on every container — RSS refreshes,
 * database backups, and blog ingestion would all duplicate-execute under
 * load. This collection acts as a mutex: a task tries to insert a doc with
 * a deterministic _id (taskName + time-bucket); Mongo's unique-index
 * guarantee ensures only the first container to write wins. The others
 * see a duplicate-key error and skip the run.
 *
 * Documents are auto-expired by a TTL index on `expiresAt`, so the
 * collection self-cleans without any explicit purge.
 *
 * Mirrors the atomic-claim pattern already in use for ClipQueueManager —
 * just applied to time-bucketed task slots rather than queued work items.
 */

const SchedulerLockSchema = new mongoose.Schema(
  {
    // Deterministic key: e.g. "podcast-rss-cache-refresh:2026-05-21T14"
    _id: { type: String, required: true },
    taskName: { type: String, required: true },
    bucket: { type: String, required: true },
    instanceId: { type: String, required: false },
    acquiredAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { _id: false, timestamps: false }
);

// TTL index: Mongo deletes the doc shortly after expiresAt passes.
SchedulerLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SchedulerLock =
  mongoose.models.SchedulerLock ||
  mongoose.model('SchedulerLock', SchedulerLockSchema);

module.exports = SchedulerLock;
