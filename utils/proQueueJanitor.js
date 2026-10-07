'use strict';
/**
 * Pro-analyzer queue hygiene, enforced from the backend.
 *
 * The clip-alert analyzer (jamie-pro-podcast-analyzer) walks every guid in
 * propodcastdetails.queuedEpisodeGuids on each invocation and only clears the
 * queue after a fully successful pass. A guid that can never succeed (no
 * transcript in the corpus) or that already produced a run keeps the whole
 * queue alive and gets re-run — and re-emailed — on every invocation
 * (observed: ~300 runs/day on one feed, Sep–Oct 2026).
 *
 * This janitor keeps the queue to guids that are (a) actually transcribed and
 * (b) have no run recorded in the last PRO_QUEUE_RUN_DEDUPE_HOURS. It runs
 * after each scheduled ingest and on its own cron, both under the scheduler
 * lock. It cannot interrupt a walk already in progress (the analyzer holds the
 * list in memory); it guarantees the NEXT walk starts from a clean queue.
 *
 * Env: PRO_QUEUE_JANITOR_ENABLED (default true), PRO_QUEUE_RUN_DEDUPE_HOURS
 * (default 24), PRO_QUEUE_REQUIRE_TRANSCRIPT (default true).
 */
const mongoose = require('mongoose');

const ENABLED = process.env.PRO_QUEUE_JANITOR_ENABLED !== 'false';
const DEDUPE_HOURS = parseInt(process.env.PRO_QUEUE_RUN_DEDUPE_HOURS || '24', 10);
const REQUIRE_TRANSCRIPT = process.env.PRO_QUEUE_REQUIRE_TRANSCRIPT !== 'false';

async function pruneProQueues({ dryRun = false, log = console.log } = {}) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('mongoose not connected');
  const since = new Date(Date.now() - DEDUPE_HOURS * 3600 * 1000);
  const feeds = await db.collection('propodcastdetails')
    .find({ queuedEpisodeGuids: { $exists: true, $not: { $size: 0 } } })
    .project({ feedId: 1, podcastName: 1, title: 1, queuedEpisodeGuids: 1 })
    .toArray();
  const report = { feeds: feeds.length, checked: 0, removedNoTranscript: 0, removedAlreadyRan: 0, kept: 0, details: [] };
  for (const f of feeds) {
    const queued = [...new Set(f.queuedEpisodeGuids.filter(Boolean))];
    report.checked += queued.length;
    const transcribed = REQUIRE_TRANSCRIPT
      ? new Set(await db.collection('jamievectormetadatas').distinct('guid', { type: 'paragraph', guid: { $in: queued } }))
      : new Set(queued);
    const ran = new Set(await db.collection('propodcastrunhistory').distinct('filter_scope.episode_guid', {
      feed_id: String(f.feedId), 'filter_scope.episode_guid': { $in: queued }, run_date: { $gte: since },
    }));
    const keep = [], noTranscript = [], alreadyRan = [];
    for (const g of queued) {
      if (!transcribed.has(g)) noTranscript.push(g);
      else if (ran.has(g)) alreadyRan.push(g);
      else keep.push(g);
    }
    report.removedNoTranscript += noTranscript.length;
    report.removedAlreadyRan += alreadyRan.length;
    report.kept += keep.length;
    const changed = keep.length !== f.queuedEpisodeGuids.length;
    report.details.push({ feedId: f.feedId, name: f.podcastName || f.title, before: f.queuedEpisodeGuids.length, keep: keep.length, noTranscript: noTranscript.length, alreadyRan: alreadyRan.length, changed });
    if (changed && !dryRun) {
      await db.collection('propodcastdetails').updateOne({ _id: f._id }, { $set: { queuedEpisodeGuids: keep, lastUpdated: new Date(), lastJanitorAt: new Date() } });
    }
    if (changed) log(`[PRO-QUEUE-JANITOR]${dryRun ? ' (dry run)' : ''} feed ${f.feedId} ${f.podcastName || f.title || ''}: ${f.queuedEpisodeGuids.length} → ${keep.length} (no transcript: ${noTranscript.length}, ran in last ${DEDUPE_HOURS}h: ${alreadyRan.length})`);
  }
  log(`[PRO-QUEUE-JANITOR]${dryRun ? ' (dry run)' : ''} ${report.feeds} feeds, ${report.checked} queued guids: kept ${report.kept}, removed ${report.removedNoTranscript} untranscribed + ${report.removedAlreadyRan} already-run`);
  return report;
}

module.exports = { pruneProQueues, ENABLED, DEDUPE_HOURS };
