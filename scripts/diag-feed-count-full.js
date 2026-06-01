/**
 * diag-feed-count-full.js — read-only.
 *
 * Counts feeds across every plausible source of truth and surfaces the
 * gaps:
 *   1. jamieVectorMetadata.type='feed' (what /api/get-available-feeds returns)
 *   2. distinct feedId in jamieVectorMetadata.type='episode'
 *   3. distinct feedId in jamieVectorMetadata.type='paragraph'
 *   4. distinct feedId in jamieVectorMetadata.type='chapter'
 *   5. ProPodcastDetails collection (separate canonical list)
 *   6. ScheduledPodcastFeed collection (ingestor scheduling list)
 *
 * Then shows the union and surfaces feedIds that exist in any one source
 * but not another.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

async function tryRequire(p) {
  try { return require(p); } catch (_) { return null; }
}

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  if (!mongoURI) { console.error('MONGO_URI not set'); process.exit(1); }
  await mongoose.connect(mongoURI);

  const ProPodcastDetailsMod = await tryRequire('../models/ProPodcastDetails');
  const ProPodcastDetails = ProPodcastDetailsMod?.ProPodcastDetails || ProPodcastDetailsMod;
  const ScheduledPodcastFeed = await tryRequire('../models/ScheduledPodcastFeed');

  console.log('Counting…\n');

  const [
    feedDocs,
    epIds,
    paraIds,
    chapIds,
    proCount,
    proIds,
    schedCount,
    schedIds,
  ] = await Promise.all([
    JamieVectorMetadata.distinct('feedId', { type: 'feed',      feedId: { $exists: true, $ne: null } }),
    JamieVectorMetadata.distinct('feedId', { type: 'episode',   feedId: { $exists: true, $ne: null } }),
    JamieVectorMetadata.distinct('feedId', { type: 'paragraph', feedId: { $exists: true, $ne: null } }),
    JamieVectorMetadata.distinct('feedId', { type: 'chapter',   feedId: { $exists: true, $ne: null } }),
    ProPodcastDetails ? ProPodcastDetails.countDocuments() : Promise.resolve(null),
    ProPodcastDetails ? ProPodcastDetails.distinct('feedId') : Promise.resolve([]),
    ScheduledPodcastFeed ? ScheduledPodcastFeed.countDocuments() : Promise.resolve(null),
    ScheduledPodcastFeed ? ScheduledPodcastFeed.distinct('feedId') : Promise.resolve([]),
  ]);

  const toStr = (arr) => arr.map(x => String(x)).filter(Boolean);
  const setFeed = new Set(toStr(feedDocs));
  const setEp = new Set(toStr(epIds));
  const setPara = new Set(toStr(paraIds));
  const setChap = new Set(toStr(chapIds));
  const setPro = new Set(toStr(proIds));
  const setSched = new Set(toStr(schedIds));

  const unionAll = new Set([
    ...setFeed, ...setEp, ...setPara, ...setChap, ...setPro, ...setSched,
  ]);

  console.log('Source counts:');
  console.log(`  jamieVectorMetadata type=feed              ${setFeed.size}`);
  console.log(`  jamieVectorMetadata distinct epId feeds    ${setEp.size}`);
  console.log(`  jamieVectorMetadata distinct paragraph     ${setPara.size}`);
  console.log(`  jamieVectorMetadata distinct chapter       ${setChap.size}`);
  console.log(`  ProPodcastDetails total docs               ${proCount ?? 'N/A'}`);
  console.log(`  ProPodcastDetails distinct feedId          ${setPro.size}`);
  console.log(`  ScheduledPodcastFeed total docs            ${schedCount ?? 'N/A'}`);
  console.log(`  ScheduledPodcastFeed distinct feedId       ${setSched.size}`);
  console.log(`  UNION across ALL sources                   ${unionAll.size}`);

  // Now show: who's missing from where?
  function diff(label, fromSet, toSet, n = 999) {
    const missing = Array.from(fromSet).filter(id => !toSet.has(id));
    console.log(`\n${label}: ${missing.length}`);
    if (missing.length > 0 && missing.length <= n) {
      console.log(`  ${missing.slice(0, n).join(', ')}`);
    } else if (missing.length > n) {
      console.log(`  ${missing.slice(0, n).join(', ')}  …+${missing.length - n}`);
    }
    return missing;
  }

  console.log('\n═══ Where each source is short of the union ═══');
  diff('In UNION but missing from type=feed docs', unionAll, setFeed, 50);
  diff('In UNION but missing from episodes', unionAll, setEp, 50);
  diff('In UNION but missing from ProPodcastDetails', unionAll, setPro, 50);
  diff('In UNION but missing from ScheduledPodcastFeed', unionAll, setSched, 50);

  console.log('\n═══ Cross-source asymmetries ═══');
  diff('In ProPodcastDetails but NOT in episodes (no content ingested)', setPro, setEp, 50);
  diff('In episodes but NOT in ProPodcastDetails', setEp, setPro, 50);
  diff('In ScheduledPodcastFeed but NOT in episodes', setSched, setEp, 50);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
