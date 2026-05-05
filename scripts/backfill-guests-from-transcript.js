/**
 * backfill-guests-from-transcript.js
 *
 * For episodes where metadataRaw.guests is empty, fetch the first few
 * transcript paragraphs and attempt to extract the guest name using:
 *   1. Regex patterns for common intro phrases (free, fast)
 *   2. GPT-4o-mini as fallback (only if regex finds nothing)
 *
 * On a successful find, writes the guest name back to:
 *   - The episode doc's metadataRaw.guests
 *   - All paragraph/chapter docs for the same guid (so findPeople works)
 *
 * Usage:
 *   node scripts/backfill-guests-from-transcript.js
 *   node scripts/backfill-guests-from-transcript.js --feedId 6708272   # one feed
 *   node scripts/backfill-guests-from-transcript.js --dry-run           # no writes
 *   node scripts/backfill-guests-from-transcript.js --limit 50          # max episodes
 */

require('dotenv').config();
const mongoose = require('mongoose');
const OpenAI   = require('openai');

const JamieVectorMetadata = require('../models/JamieVectorMetadata');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const INTRO_PARA_COUNT = 6;   // how many paragraphs to fetch (first N by start_time)
const BATCH_SIZE       = 10;  // parallel episode batches
const LLM_MODEL        = 'gpt-4o-mini';

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const feedIdArg = (() => { const i = args.indexOf('--feedId'); return i >= 0 ? args[i+1] : null; })();
const limitArg  = (() => { const i = args.indexOf('--limit');  return i >= 0 ? parseInt(args[i+1],10) : 500; })();

// ---------------------------------------------------------------------------
// Regex approach — free, zero latency
// ---------------------------------------------------------------------------

// Ordered by specificity. Returns first match or null.
const INTRO_PATTERNS = [
  // "my guest today is John Smith" / "today's guest is John Smith"
  /\b(?:my|today'?s?|tonight'?s?)\s+guest(?:\s+today|\s+tonight|\s+is|\s+here)?\s+(?:is\s+)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})/,
  // "welcome John Smith" / "welcome back John Smith"
  /\bwelcom(?:e|ing)\s+(?:back\s+)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})/,
  // "I'm joined by John Smith"
  /\bI(?:'m| am)\s+(?:here\s+)?(?:joined|sitting|talking)\s+(?:by|with)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})/,
  // "joining me today is John Smith"
  /\bjoining\s+(?:me|us)\s+(?:today|tonight|now|here)?\s*(?:is\s+)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})/,
  // "with me today is John Smith"
  /\bwith\s+(?:me|us)\s+(?:today|tonight|now|here)\s+(?:is\s+)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})/,
  // "I have John Smith on the show"
  /\bI(?:'ve| have)\s+got?\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})\s+(?:on|here|with|today)/,
  // "speak with / talking with / chat with John Smith"
  /\b(?:speak|talk|chat)(?:ing)?\s+with\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})/,
];

// Tokens that look like a proper name but are not guest names
const FALSE_POSITIVE_BLOCKLIST = new Set([
  'Bitcoin', 'BTC', 'AI', 'ChatGPT', 'OpenAI', 'The', 'This', 'That',
  'Thank', 'Hello', 'Hey', 'Hi', 'So', 'Now', 'Today', 'Tonight',
  'Welcome', 'Thank You', 'Thanks', 'You', 'We', 'I', 'It', 'My',
]);

function extractViaRegex(paragraphs) {
  const combined = paragraphs.map(p => p.text || p.quote || '').join(' ');
  for (const pat of INTRO_PATTERNS) {
    const m = combined.match(pat);
    if (m && m[1]) {
      const candidate = m[1].trim();
      // Must be at least 2 words and not in blocklist
      const words = candidate.split(/\s+/);
      if (words.length >= 2 && !FALSE_POSITIVE_BLOCKLIST.has(words[0])) {
        return candidate;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM fallback
// ---------------------------------------------------------------------------

async function extractViaLLM(openai, episodeTitle, paragraphs) {
  const snippets = paragraphs.map(p => (p.text || p.quote || '').substring(0, 300)).join('\n\n');
  const resp = await openai.chat.completions.create({
    model: LLM_MODEL,
    max_tokens: 30,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'You extract the guest name from podcast transcript introductions. Reply with ONLY the full name (e.g. "John Smith") or "none" if the host is speaking alone or you cannot determine it with confidence.',
      },
      {
        role: 'user',
        content: `Episode title: "${episodeTitle}"\n\nOpening transcript:\n${snippets}`,
      },
    ],
  });
  const answer = (resp.choices?.[0]?.message?.content || '').trim();
  if (!answer || answer.toLowerCase() === 'none' || answer.length < 4) return null;
  // Sanity: must look like a name (at least two capitalised words)
  const words = answer.split(/\s+/);
  if (words.length < 2 || !/^[A-Z]/.test(words[0])) return null;
  return answer;
}

// ---------------------------------------------------------------------------
// Write back
// ---------------------------------------------------------------------------

async function applyGuest(guid, guestName, dryRun) {
  if (dryRun) return { episode: 0, paragraphs: 0 };

  const guestArr = [guestName];

  // Update the episode doc
  const epResult = await JamieVectorMetadata.updateMany(
    { type: 'episode', guid },
    { $set: { 'metadataRaw.guests': guestArr } }
  );

  // Update all paragraphs + chapters for same episode so findPeople picks them up
  const paraResult = await JamieVectorMetadata.updateMany(
    { type: { $in: ['paragraph', 'chapter'] }, guid },
    { $set: { 'metadataRaw.guests': guestArr } }
  );

  return { episode: epResult.modifiedCount, paragraphs: paraResult.modifiedCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function processEpisode(openai, ep, dryRun) {
  const guid  = ep.guid;
  const title = ep.metadataRaw?.title || ep.episode || guid;

  // Fetch the first INTRO_PARA_COUNT paragraphs by start_time
  const paras = await JamieVectorMetadata
    .find({ type: 'paragraph', guid })
    .sort({ start_time: 1 })
    .limit(INTRO_PARA_COUNT)
    .lean();

  if (!paras.length) {
    return { guid, title, result: 'skip:no-paragraphs', guest: null };
  }

  // 1. Regex
  let guest = extractViaRegex(paras);
  const method = guest ? 'regex' : 'llm';

  // 2. LLM fallback
  if (!guest) {
    try {
      guest = await extractViaLLM(openai, title, paras);
    } catch (e) {
      return { guid, title, result: `error:llm:${e.message}`, guest: null };
    }
  }

  if (!guest) {
    return { guid, title, result: 'not-found', guest: null };
  }

  const writeResult = await applyGuest(guid, guest, dryRun);
  return { guid, title, result: `found:${method}`, guest, writeResult };
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not set.');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set (needed for LLM fallback).');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Build query for episodes with no guests
  const query = {
    type: 'episode',
    $or: [
      { 'metadataRaw.guests': { $exists: false } },
      { 'metadataRaw.guests': { $size: 0 } },
      { 'metadataRaw.guests': null },
    ],
  };
  if (feedIdArg) query.feedId = feedIdArg;

  const total = await JamieVectorMetadata.countDocuments(query);
  const limit = Math.min(limitArg, total);
  console.log(`\nEpisodes with no guests: ${total} — processing up to ${limit}${feedIdArg ? ` (feedId=${feedIdArg})` : ''}${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  const cursor = JamieVectorMetadata.find(query).sort({ publishedTimestamp: -1 }).limit(limit).lean().cursor();

  let processed = 0, found = 0, notFound = 0, skipped = 0, errors = 0;
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    const results = await Promise.all(batch.map(ep => processEpisode(openai, ep, DRY_RUN)));
    for (const r of results) {
      processed++;
      if (r.result.startsWith('found'))      { found++;    console.log(`  ✓ [${r.result.split(':')[1]}] "${r.title?.substring(0,60)}" → ${r.guest}`); }
      else if (r.result === 'not-found')     { notFound++; }
      else if (r.result.startsWith('skip'))  { skipped++;  }
      else if (r.result.startsWith('error')) { errors++;   console.warn(`  ✗ ${r.guid}: ${r.result}`); }
    }
    batch = [];
    process.stdout.write(`\r  Progress: ${processed}/${limit} (found: ${found}, not-found: ${notFound}, skipped: ${skipped})`);
  };

  for await (const ep of cursor) {
    batch.push(ep);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  console.log(`\n\n=== Summary ===`);
  console.log(`  Total processed : ${processed}`);
  console.log(`  Guests found    : ${found}`);
  console.log(`  Not found       : ${notFound}`);
  console.log(`  Skipped (no tx) : ${skipped}`);
  console.log(`  Errors          : ${errors}`);
  if (DRY_RUN) console.log(`  [DRY RUN — no writes performed]`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
