/**
 * test-chapter-augmented-recall.js
 *
 * Validates whether augmented chapter-level lexical search can preserve
 * proper-noun recall vs the existing paragraph-level Atlas Search.
 *
 * Strategy:
 *   1. Sample 100 random episodes from prod jamieVectorMetadata
 *   2. For each chapter in those episodes, regenerate the chapter with an
 *      AUGMENTED prompt that extracts named entities, technical terms,
 *      URLs, and verbatim phrases in addition to the existing headline /
 *      summary / keywords.
 *   3. Write augmented docs to a SIDE COLLECTION
 *      `jamieVectorMetadataChapterTest`. Prod `jamieVectorMetadata` and the
 *      `paragraph_text_search` Atlas index are NEVER touched.
 *   4. Run the canonical smoke-test query corpus against BOTH:
 *        (a) prod paragraph_text_search via atlasTextSearch (scoped to the
 *            same 100 episodes via guid filter)
 *        (b) the new chapter side collection via Mongo regex on the
 *            augmented fields
 *   5. Compare recall: for each query, how many ground-truth chapters does
 *      each path find?
 *
 * Output: tmp/chapter-recall-<ts>.md with side-by-side per-query results
 * and aggregate precision/recall.
 *
 * Cost: ~100 episodes × ~15 chapters each × ~$0.001/chapter for
 *       gpt-4o-mini augmentation = ~$1.50 total.
 * Time: ~10-20 min depending on Mongo throughput + LLM latency.
 *
 * Safety:
 *   - All writes go to a SIDE COLLECTION (`jamieVectorMetadataChapterTest`)
 *   - No modification to existing chapter docs in jamieVectorMetadata
 *   - No modification to `paragraph_text_search` Atlas index
 *   - Side collection can be dropped freely after the test:
 *       db.jamieVectorMetadataChapterTest.drop()
 *
 * Usage:
 *   node scripts/test-chapter-augmented-recall.js                    # dry-run plan
 *   node scripts/test-chapter-augmented-recall.js --regenerate       # phase 1: build augmented side coll
 *   node scripts/test-chapter-augmented-recall.js --evaluate         # phase 2: run smoke-test corpus on side coll
 *   node scripts/test-chapter-augmented-recall.js --regenerate --evaluate   # both phases end-to-end
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const OpenAI = require('openai');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { atlasTextSearch } = require('../services/atlasTextSearch');

// ─── Config ───────────────────────────────────────────────────────────────

// Number of RANDOM episodes to sample on top of the seed set. The seed set
// comes from live paragraph_text_search hits for each canonical query so
// we're guaranteed to have ground-truth content for every query. Random
// guids add realistic noise so chapter precision is measured against a
// believable haystack, not just a curated mini-corpus.
// --smoke runs against a separate side collection with a 10-episode cap so
// new strategies can be proven before scaling up to the full 2000-sample run.
const SMOKE = process.argv.includes('--smoke');
const RANDOM_SAMPLE_SIZE = parseInt(process.env.RANDOM_SAMPLE_SIZE || (SMOKE ? '5' : '2000'), 10);
const MAX_TARGET_EPISODES = parseInt(process.env.MAX_TARGET_EPISODES || (SMOKE ? '10' : '0'), 10);
const AUG_MODEL = process.env.CHAPTER_AUG_MODEL || 'gpt-4o-mini';
const SIDE_COLL_NAME = process.env.SIDE_COLL_NAME
  || (SMOKE ? 'jamieVectorMetadataChapterSmoke' : 'jamieVectorMetadataChapterTest');
const TARGET_GUIDS_FILE = path.join(
  __dirname, '..', 'tmp',
  process.env.TARGET_GUIDS_FILE_NAME
    || (SMOKE ? 'chapter-recall-target-guids-smoke.json' : 'chapter-recall-target-guids.json')
);
// gpt-4o-mini rate limits are generous (Tier 1: 500 RPM / 200k TPM).
// 10 concurrent workers = ~120-200 RPM at typical latency. Safe.
// Bump higher if your OpenAI tier supports it.
const CONCURRENCY = parseInt(process.env.CHAPTER_AUG_CONCURRENCY || '10', 10);
const FLAGS = {
  regenerate: process.argv.includes('--regenerate'),
  evaluate: process.argv.includes('--evaluate'),
  atlasEvaluate: process.argv.includes('--atlas-evaluate'),
  reset: process.argv.includes('--reset'),
};
// Atlas Search index name on the side collection — must match what was
// created in Atlas UI from tmp/chapter-test-atlas-index.json
const ATLAS_INDEX_NAME = process.env.CHAPTER_TEST_INDEX_NAME || 'chapter_text_search_test';

// Canonical queries plus the literal transcript forms a podcast might use
// for each. The `variants` field is what we use to SEED the side
// collection — we want every paragraph whose text literally contains any
// of those forms, because that's the actual ground-truth source material
// the augmented chapter approach has to surface.
//
// For example: a user might search "albyhub" (no space) but in the
// transcript the host says "Alby Hub" (with space). The seeder uses
// "Alby Hub" to find ground-truth paragraphs; the eval phase still
// queries with the user-form "albyhub" to test recall on the augmented
// chapter index.
const CANONICAL_QUERIES = [
  { q: 'lncurl',               kind: 'spelled-out-letter', variants: ['lncurl', 'l n curl', 'l n c u r l'] },
  { q: 'lncurl.lol',           kind: 'spelled-out-letter', variants: ['lncurl.lol', 'lncurl', 'l n c u r l'] },
  { q: 'Alby Hub',             kind: 'brand-compound',     variants: ['Alby Hub'] },
  { q: 'albyhub',              kind: 'brand-compound',     variants: ['Alby Hub'] },
  { q: 'Nostr Wallet Connect', kind: 'multi-word-spec',    variants: ['Nostr Wallet Connect'] },
  { q: 'NWC',                  kind: 'acronym',            variants: ['NWC', 'Nostr Wallet Connect'] },
  { q: 'BIP-32',               kind: 'technical-spec',     variants: ['BIP-32', 'BIP 32'] },
  { q: 'OpenAI',               kind: 'brand-proper-noun',  variants: ['OpenAI', 'Open AI'] },
  { q: 'lightning network',    kind: 'topic',              variants: ['lightning network'] },
  { q: 'bitcoin mining',       kind: 'topic',              variants: ['bitcoin mining'] },
];

// ─── Augmented chapter prompt ─────────────────────────────────────────────

const AUG_SYSTEM_PROMPT = `You are extracting search-relevant metadata from a podcast chapter transcript.
Goal: capture EVERY surface form a user might type to find this chapter.
A user searching "albyhub" should find chapters where the host said "Alby Hub" —
which requires the index to contain BOTH forms. So generate variants exhaustively.

Return a single JSON object on one line, no markdown fences:
  {
    "entities": ["..."],
    "phrases": ["..."],
    "urls_and_domains": ["..."]
  }

ENTITIES — every person, company, product, brand, podcast/show name, place, project.
For EACH entity mentioned, include MULTIPLE FORMS in the array as separate entries:
  - Canonical form: "Alby Hub"
  - Run-together: "albyhub", "AlbyHub"
  - Spaced lowercase: "alby hub"
  - Common alternate spellings if visible in transcript: "Albi Hub"
  - Acronym AND full form as SEPARATE entries: "NWC" AND "Nostr Wallet Connect"
  - Person formal AND casual: "Vitalik Buterin" AND "Vitalik"
  - Project codenames and aliases: "ChatGPT" AND "GPT" AND "OpenAI's chatbot"
Be exhaustive — 30+ entries is fine if the chapter is dense with proper nouns.
Don't fabricate names; only include forms that are plausible variants of names
ACTUALLY mentioned in the transcript.

PHRASES — 20-30 distinctive multi-word phrases lifted DIRECTLY from the transcript
that would be unusual enough to identify this chapter. Prefer phrases with proper
nouns, technical terms, specific numbers, dollar amounts, dates, or unusual word
combinations. Copy verbatim from the transcript including casing.

URLS_AND_DOMAINS — every URL, domain, or web identifier. For EACH, include all
forms a user might type or that might appear in transcript:
  - Run-together: "lncurl.lol"
  - Just the host: "lncurl"
  - Letter-spelled-out (if transcript spells letters out): "l n c u r l", "l n c u r l dot lol"
Include also bare technical-spec identifiers as if URL-like: "BIP-32", "BIP 32", "BIP32"
should all appear as entries if any of those forms is mentioned.

Rules:
  - Don't fabricate. Empty arrays are fine.
  - Output is JSON only, single line, no markdown.`;

async function augmentChapter({ openai, chapterText, headline }) {
  if (!chapterText || chapterText.trim().length < 50) {
    return { entities: [], phrases: [], urls_and_domains: [] };
  }
  const userMsg = [
    `CHAPTER HEADLINE: ${headline || '(no headline)'}`,
    ``,
    `CHAPTER TRANSCRIPT:`,
    chapterText.slice(0, 12000), // cap to keep token cost predictable
  ].join('\n');

  // Retry on 429 / 5xx. At high concurrency (40 workers) transient rate
  // limits are inevitable — handle here so the worker doesn't lose chapters
  // to transient errors. Exponential backoff capped at 30s, max 4 attempts.
  let resp;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      resp = await openai.chat.completions.create({
        model: AUG_MODEL,
        messages: [
          { role: 'system', content: AUG_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        temperature: 0,
        max_tokens: 4000, // generous — exhaustive prompt can produce long output
        response_format: { type: 'json_object' }, // force valid JSON
      });
      break; // success
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === 3) throw err;
      const backoffMs = Math.min(30000, 1000 * Math.pow(2, attempt));
      console.warn(`  retry ${attempt + 1}/3 after ${backoffMs}ms (status ${status}): ${err.message}`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  if (!resp) throw lastErr;
  const raw = (resp.choices?.[0]?.message?.content || '').trim();
  const finishReason = resp.choices?.[0]?.finish_reason;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      phrases: Array.isArray(parsed.phrases) ? parsed.phrases : [],
      urls_and_domains: Array.isArray(parsed.urls_and_domains) ? parsed.urls_and_domains : [],
      _usage: resp.usage,
      _finishReason: finishReason,
    };
  } catch (err) {
    return {
      _error: `JSON parse failed: ${err.message} (finish=${finishReason})`,
      _raw: raw.slice(0, 200),
      _finishReason: finishReason,
    };
  }
}

// Deterministic post-process: for each extracted term, scan the chapter's
// paragraphs and record which paragraphs literally contain it (substring
// match, case-insensitive). Output is an array of { term, paragraphIds }
// suitable for Atlas Search nested-object indexing.
//
// Why deterministic instead of asking the LLM? LLM can hallucinate paragraph
// pointers; substring match cannot. The LLM is great at *recognizing what's
// noteworthy*; the regex is great at *finding where it literally appears*.
function mapTermsToParagraphs(terms, paragraphs) {
  const out = [];
  if (!Array.isArray(terms) || !terms.length) return out;
  for (const rawTerm of terms) {
    if (typeof rawTerm !== 'string') continue;
    const term = rawTerm.trim();
    if (term.length < 2) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re;
    try { re = new RegExp(escaped, 'i'); } catch { continue; }
    const paragraphIds = [];
    for (const p of paragraphs) {
      const text = p?.metadataRaw?.text || p?.text || '';
      if (text && re.test(text)) paragraphIds.push(p.pineconeId);
    }
    out.push({ term, paragraphIds });
  }
  return out;
}

// ─── Phase 1: regenerate augmented chapter docs in side collection ────────

// Seed guids = every guid whose paragraph text LITERALLY contains the
// query (or one of its transcript variants). This is the source of truth
// — the actual content that an ideal lexical search would surface.
//
// Implementation uses Atlas Search PHRASE clause on `paragraph_text_search`
// (which is just `metadataRaw.text` with the standard analyzer). A phrase
// clause matches the literal token sequence in order — no fuzzy, no
// synonyms, no shingles, no expansion. So a phrase("Alby Hub") match
// returns paragraphs whose text literally contains "alby hub" as adjacent
// tokens. This is fast (Atlas Search is indexed) and precise.
//
// Why not use atlasTextSearch() from the service? That helper adds fuzzy
// + synonym + LLM-expansion clauses, which inflate hit count with
// matches that don't literally contain the term. That's the imperfect
// behavior we're trying to test AGAINST — so for seeding we go around it.
async function gatherSeedGuidsFromGroundTruth(mongoConn) {
  console.log(`Gathering seed guids from paragraph text (Atlas phrase match, literal content only)…`);
  const seedSet = new Set();
  const coll = mongoConn.connection.db.collection('jamieVectorMetadata');

  for (const { q, variants } of CANONICAL_QUERIES) {
    const forms = (variants && variants.length) ? variants : [q];
    const before = seedSet.size;
    for (const form of forms) {
      try {
        const cursor = coll.aggregate(
          [
            {
              $search: {
                index: 'paragraph_text_search',
                compound: {
                  must: [{ phrase: { query: form, path: 'metadataRaw.text' } }],
                  filter: [{ equals: { path: 'type', value: 'paragraph' } }],
                },
              },
            },
            { $limit: 500 }, // generous cap per variant — most queries will return far fewer
            { $project: { _id: 0, guid: 1 } },
          ],
          { maxTimeMS: 10000 }
        );
        for await (const doc of cursor) {
          if (doc.guid) seedSet.add(String(doc.guid));
        }
      } catch (err) {
        console.log(`  ⚠ phrase "${form}" failed: ${err.message}`);
      }
    }
    const added = seedSet.size - before;
    console.log(`  ${q.padEnd(22)} (${forms.length} variant${forms.length > 1 ? 's' : ''}): +${added} new guids → total ${seedSet.size}`);
  }
  return Array.from(seedSet);
}

async function resolveTargetGuids({ mongoConn, sideColl }) {
  // Reuse the saved target if it exists — that's the locked guid set
  // from a prior invocation. Lets us interrupt + resume without drifting
  // to a different random sample.
  if (fs.existsSync(TARGET_GUIDS_FILE)) {
    const data = JSON.parse(fs.readFileSync(TARGET_GUIDS_FILE, 'utf8'));
    console.log(`Loading locked target guid set from ${TARGET_GUIDS_FILE}`);
    console.log(`  total=${data.total}  seed=${data.seedCount}  fromPriorWork=${data.fromExistingSideColl ?? 0}  newRandom=${data.newRandomCount ?? 0}`);
    console.log(`  captured at ${data.capturedAt}`);
    console.log(`  To reset and pick a different random sample: rm ${TARGET_GUIDS_FILE}`);
    return data.guids;
  }

  // No saved target — build one. "Existing" guids = everything already in
  // the side collection (work from any prior runs, including the one that
  // may have just been interrupted). Those get LOCKED IN automatically.
  const existingGuids = await sideColl.distinct('guid');
  console.log(`Building new target guid set…`);
  console.log(`  ${existingGuids.length} guid(s) already represented in side coll — locking in.`);

  const seedGuids = await gatherSeedGuidsFromGroundTruth(mongoConn);
  console.log(`\nSeed set: ${seedGuids.length} unique guids (paragraphs with literal content match).`);

  const seenSet = new Set([...existingGuids, ...seedGuids]);
  // Top up to RANDOM_SAMPLE_SIZE additional random guids (above the
  // existing+seed baseline). If existing already covers the budget, no
  // new randoms get added.
  const wantedNewRandom = Math.max(0, RANDOM_SAMPLE_SIZE - existingGuids.length);
  let newRandomGuids = [];
  if (wantedNewRandom > 0) {
    console.log(`\nSampling up to ${wantedNewRandom} additional random episodes (excluding existing + seed)…`);
    const randomEpisodes = await JamieVectorMetadata.aggregate([
      { $match: { type: 'episode', guid: { $exists: true, $ne: null } } },
      { $sample: { size: wantedNewRandom + existingGuids.length + seedGuids.length } },
      { $project: { guid: 1, _id: 0 } },
    ]);
    for (const e of randomEpisodes) {
      if (e.guid && !seenSet.has(e.guid)) {
        newRandomGuids.push(e.guid);
        seenSet.add(e.guid);
        if (newRandomGuids.length >= wantedNewRandom) break;
      }
    }
    console.log(`Got ${newRandomGuids.length} new random guids.`);
  } else {
    console.log(`\nSide coll already covers ${existingGuids.length} guids ≥ RANDOM_SAMPLE_SIZE (${RANDOM_SAMPLE_SIZE}); skipping new random sample.`);
  }

  let guids = [...new Set([...existingGuids, ...seedGuids, ...newRandomGuids])];
  if (MAX_TARGET_EPISODES > 0 && guids.length > MAX_TARGET_EPISODES) {
    // Preserve seed in the cap (canonical-query content must stay) — fill
    // remaining slots with whatever's left.
    const cap = MAX_TARGET_EPISODES;
    const seedKept = seedGuids.slice(0, cap);
    const remainingBudget = cap - seedKept.length;
    const restPool = [...existingGuids, ...newRandomGuids].filter(g => !new Set(seedKept).has(g));
    guids = [...seedKept, ...restPool.slice(0, remainingBudget)];
    console.log(`\nApplying MAX_TARGET_EPISODES=${MAX_TARGET_EPISODES} cap → ${guids.length} guids (kept ${seedKept.length} seed).`);
  }

  // Persist for future resume
  if (!fs.existsSync(path.dirname(TARGET_GUIDS_FILE))) {
    fs.mkdirSync(path.dirname(TARGET_GUIDS_FILE), { recursive: true });
  }
  fs.writeFileSync(TARGET_GUIDS_FILE, JSON.stringify({
    capturedAt: new Date().toISOString(),
    fromExistingSideColl: existingGuids.length,
    seedCount: seedGuids.length,
    newRandomCount: newRandomGuids.length,
    total: guids.length,
    guids,
  }, null, 2));
  console.log(`\nSaved target guid set to ${TARGET_GUIDS_FILE}`);
  console.log(`  total=${guids.length}  existing=${existingGuids.length}  seed=${seedGuids.length}  newRandom=${newRandomGuids.length}`);
  return guids;
}

async function phaseRegenerate({ openai, mongoConn }) {
  console.log('\n═══ Phase 1: seed + expand augmented chapters into side collection ═══\n');

  const sideColl = mongoConn.connection.db.collection(SIDE_COLL_NAME);
  const guids = await resolveTargetGuids({ mongoConn, sideColl });
  console.log(`\nTotal target: ${guids.length} episode guids.`);

  // Pull chapters for all target guids, then filter to ones not already
  // augmented in the side collection (preserve prior work).
  const allChapters = await JamieVectorMetadata
    .find({ type: 'chapter', guid: { $in: guids } })
    .select('pineconeId guid feedId start_time end_time metadataRaw')
    .lean();
  console.log(`${allChapters.length} chapter docs across target guids.`);

  const alreadyDone = new Set(
    await sideColl.distinct('pineconeId', { pineconeId: { $in: allChapters.map(c => c.pineconeId) } })
  );
  const chapters = allChapters.filter(c => !alreadyDone.has(c.pineconeId));
  const totalChapters = allChapters.length;
  const donePct = totalChapters > 0 ? Math.round((alreadyDone.size / totalChapters) * 100) : 0;

  console.log('');
  console.log('─'.repeat(60));
  if (alreadyDone.size > 0) {
    console.log(`▶ RESUMING from prior run`);
    console.log(`  ${alreadyDone.size}/${totalChapters} chapters already augmented (${donePct}%)`);
    console.log(`  ${chapters.length} remaining to augment`);
  } else {
    console.log(`▶ FRESH RUN`);
    console.log(`  0/${totalChapters} chapters done`);
    console.log(`  ${chapters.length} to augment`);
  }
  console.log('─'.repeat(60));
  const estCost = (chapters.length * 0.00055).toFixed(2); // v2 prompt: ~25% more expensive than v1
  // Per-worker throughput observed in smoke test: ~0.13 chap/sec
  // (each LLM call ~8s). Be slightly conservative at 0.1 to account
  // for occasional 429 retries at high concurrency.
  const PER_WORKER_CHAP_PER_SEC = 0.1;
  const estMins = (workers) => Math.ceil(chapters.length / (workers * PER_WORKER_CHAP_PER_SEC * 60));
  console.log(`Estimated cost: ~$${estCost} in gpt-4o-mini tokens.`);
  console.log(`Estimated time at concurrency=${CONCURRENCY}: ~${estMins(CONCURRENCY)} min`);
  console.log(`  (~${estMins(10)} min at concurrency=10, ~${estMins(40)} min at concurrency=40)`);
  console.log('');

  // ─── Worker pool ────────────────────────────────────────────────────
  // Shared state across workers
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let nextIdx = 0; // shared work cursor — each worker grabs and increments

  const startedAt = Date.now();

  async function processOne(chapter) {
    // Defensive: a parallel run / interrupted resume may have written this
    // doc since the initial alreadyDone scan. Skip if so. Cheap lookup on
    // a unique-indexed _id (or pineconeId).
    const exists = await sideColl.findOne(
      { pineconeId: chapter.pineconeId },
      { projection: { _id: 1 } }
    );
    if (exists) { skipped++; return; }

    // Pull the underlying paragraphs in this chapter's time window
    const paragraphs = await JamieVectorMetadata.find({
      type: 'paragraph',
      guid: chapter.guid,
      start_time: { $gte: chapter.start_time },
      end_time:   { $lte: chapter.end_time },
    })
      .select('pineconeId metadataRaw.text start_time')
      .sort({ start_time: 1 })
      .lean();

    const meta = chapter.metadataRaw || {};

    const paragraphTextJoined = paragraphs
      .map(p => p?.metadataRaw?.text || '')
      .filter(Boolean)
      .join('\n');

    // Fallback path: some chapters have null/missing start_time/end_time
    // bounds, so the paragraph fetch above returns nothing → empty text →
    // augmentChapter early-returns with empty arrays at $0 cost (silent
    // junk). When that happens, use the chapter's OWN headline/summary/
    // keywords text as the augmentation source. Less rich than full
    // transcript paragraphs, but better than skipping.
    let chapterText = paragraphTextJoined;
    let usedFallback = false;
    if (!chapterText || chapterText.trim().length < 50) {
      const fallbackParts = [
        meta.headline,
        meta.summary,
        Array.isArray(meta.keywords) ? meta.keywords.join(' ') : null,
      ].filter(Boolean);
      const fallbackText = fallbackParts.join('\n').trim();
      if (fallbackText.length >= 50) {
        chapterText = fallbackText;
        usedFallback = true;
        console.warn(`  fallback ${chapter.pineconeId}: paragraphs empty (start=${chapter.start_time}, end=${chapter.end_time}, count=${paragraphs.length}); using headline+summary+keywords`);
      } else {
        failed++;
        console.error(`  no-text ${chapter.pineconeId}: paragraphs=${paragraphs.length}, start=${chapter.start_time}, end=${chapter.end_time}, fallback too short — counting as failure`);
        return;
      }
    }

    const aug = await augmentChapter({ openai, chapterText, headline: meta.headline });

    if (aug._error) {
      failed++;
      // Surface aug-side failures (JSON parse, truncation) so they don't
      // disappear into the `failed` counter. Worker-side throws already log
      // via the catch below; this covers the silent _error return path.
      console.error(`  aug-fail ${chapter.pineconeId}: ${aug._error}` +
        (aug._raw ? `\n               raw="${aug._raw.replace(/\n/g, ' ').slice(0, 160)}…"` : ''));
      return;
    }
    if (aug._usage) {
      totalInputTokens += aug._usage.prompt_tokens || 0;
      totalOutputTokens += aug._usage.completion_tokens || 0;
    }

    // Deterministic term → paragraphIds mapping. Drives the sub-indexing
    // story: search hits a chapter via Atlas, then the agent gets exact
    // paragraph pointers without scanning.
    const entity_mentions = mapTermsToParagraphs(aug.entities, paragraphs);
    const phrase_mentions = mapTermsToParagraphs(aug.phrases, paragraphs);
    const url_mentions = mapTermsToParagraphs(aug.urls_and_domains, paragraphs);

    await sideColl.replaceOne(
      { pineconeId: chapter.pineconeId },
      {
        pineconeId: chapter.pineconeId,
        type: 'chapter',
        guid: chapter.guid,
        feedId: chapter.feedId,
        start_time: chapter.start_time,
        end_time: chapter.end_time,
        metadataRaw: {
          ...meta,
          entity_mentions,
          phrase_mentions,
          url_mentions,
          // Keep the flat arrays too for backward-compat with the old index
          // (lets us run side-by-side comparisons across versions).
          entities_flat: aug.entities,
          phrases_flat: aug.phrases,
          urls_flat: aug.urls_and_domains,
          augmented_at: new Date().toISOString(),
          augmented_by: AUG_MODEL,
          augmentation_version: 'v2-exhaustive-subindex',
          text_source: usedFallback ? 'fallback-headline-summary' : 'paragraphs',
        },
      },
      { upsert: true }
    );
  }

  async function worker(workerId) {
    while (true) {
      const i = nextIdx++;
      if (i >= chapters.length) return;
      const chapter = chapters[i];
      try {
        await processOne(chapter);
        processed++;
      } catch (err) {
        failed++;
        console.error(`  [w${workerId}] failed chapter ${chapter.pineconeId}: ${err.message}`);
      }

      // Throttled progress logging — every 50 completions, no matter
      // which worker hit the boundary. The `processed` counter is shared.
      if (processed > 0 && processed % 50 === 0) {
        const cost = (totalInputTokens / 1e6 * 0.150) + (totalOutputTokens / 1e6 * 0.600);
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = processed / elapsed;
        const eta = chapters.length > processed ? Math.round((chapters.length - processed) / rate) : 0;
        console.log(
          `  ${processed}/${chapters.length}  ` +
          `(skip=${skipped}, fail=${failed}, ` +
          `rate=${rate.toFixed(1)}/s, ` +
          `cost~$${cost.toFixed(2)}, ` +
          `eta=${Math.floor(eta / 60)}m${eta % 60}s)`
        );
      }
    }
  }

  console.log(`Starting ${CONCURRENCY} concurrent workers…\n`);
  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1))
  );

  const cost = (totalInputTokens / 1e6 * 0.150) + (totalOutputTokens / 1e6 * 0.600);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\nPhase 1 done.  processed=${processed}  skipped=${skipped}  failed=${failed}  elapsed=${elapsed}s  spent≈$${cost.toFixed(2)}`);
  return { guids, processed, failed, cost };
}

// ─── Phase 2b: evaluate recall via REAL Atlas Search on side collection ──

async function phaseAtlasEvaluate({ mongoConn, guids }) {
  console.log(`\n═══ Phase 2 (Atlas): real Atlas Search recall on "${SIDE_COLL_NAME}" via index "${ATLAS_INDEX_NAME}" ═══\n`);

  const sideColl = mongoConn.connection.db.collection(SIDE_COLL_NAME);
  const results = [];

  for (const { q, kind } of CANONICAL_QUERIES) {
    // (a) Paragraph baseline via existing prod Atlas Search, scoped to our 100 guids
    const paragraphHits = await atlasTextSearch({
      query: q,
      guids,
      limit: 20,
      requestId: `CHAPRECALL-ATLAS-${q}`.replace(/\s+/g, '-'),
    });

    // (b) Chapter side coll via Atlas Search compound query across all
    //     augmented + original fields. Standard analyzer everywhere; we're
    //     testing whether the AUGMENTATION captures enough signal — not
    //     re-introducing shingle complexity at the chapter level.
    // v2 paths: nested-object arrays (sub-indexed term → paragraphIds).
    // Atlas Search treats `metadataRaw.entity_mentions.term` as a queryable
    // string-array field across the .term values.
    const fieldPaths = [
      'metadataRaw.headline',
      'metadataRaw.summary',
      'metadataRaw.keywords',
      'metadataRaw.entity_mentions.term',
      'metadataRaw.phrase_mentions.term',
      'metadataRaw.url_mentions.term',
    ];
    const shouldClauses = [];
    for (const path of fieldPaths) {
      shouldClauses.push({
        phrase: { query: q, path, score: { boost: { value: 3 } } },
      });
      shouldClauses.push({
        text: { query: q, path, fuzzy: { maxEdits: 1, prefixLength: 1 }, score: { boost: { value: 1 } } },
      });
    }

    let chapterHits = [];
    let chapterErr = null;
    try {
      const pipeline = [
        {
          $search: {
            index: ATLAS_INDEX_NAME,
            compound: {
              should: shouldClauses,
              filter: [{ equals: { path: 'type', value: 'chapter' } }],
              minimumShouldMatch: 1,
            },
          },
        },
        { $limit: 20 },
        {
          $project: {
            _id: 0,
            pineconeId: 1,
            guid: 1,
            'metadataRaw.headline': 1,
            // Surface the matched-paragraph pointers so we can demonstrate the
            // sub-indexing payoff: each chapter hit comes with the exact
            // paragraphs that contain matching terms.
            'metadataRaw.entity_mentions': 1,
            'metadataRaw.phrase_mentions': 1,
            'metadataRaw.url_mentions': 1,
            score: { $meta: 'searchScore' },
          },
        },
      ];
      chapterHits = await sideColl.aggregate(pipeline, { maxTimeMS: 8000 }).toArray();
    } catch (err) {
      chapterErr = err.message;
    }

    // Ground truth: which guids actually contain the term in any paragraph?
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'i');
    const groundTruthGuids = new Set(
      await JamieVectorMetadata.distinct('guid', {
        type: 'paragraph',
        guid: { $in: guids },
        'metadataRaw.text': re,
      })
    );

    const paragraphGuids = new Set(paragraphHits.map(h => h.id.replace(/_p\d+$/, '')));
    const chapterGuids = new Set(chapterHits.map(c => c.guid));

    const truth = groundTruthGuids.size;
    const paragraphRecall = truth ? [...paragraphGuids].filter(g => groundTruthGuids.has(g)).length / truth : null;
    const chapterRecall = truth ? [...chapterGuids].filter(g => groundTruthGuids.has(g)).length / truth : null;
    const chapterPrecision = chapterHits.length ? [...chapterGuids].filter(g => groundTruthGuids.has(g)).length / chapterGuids.size : null;

    results.push({
      q, kind, truth,
      paragraphHits: paragraphHits.length,
      chapterHits: chapterHits.length,
      paragraphRecall, chapterRecall, chapterPrecision,
      chapterErr,
      sampleChapter: chapterHits[0]?.metadataRaw?.headline || null,
      topScore: chapterHits[0]?.score || null,
    });
  }

  return results;
}

// ─── Phase 2: evaluate recall ─────────────────────────────────────────────

async function phaseEvaluate({ mongoConn, guids }) {
  console.log('\n═══ Phase 2: side-by-side recall comparison ═══\n');

  const sideColl = mongoConn.connection.db.collection(SIDE_COLL_NAME);

  // Build the comparison: for each query, hit paragraph_text_search scoped to
  // our 100 guids, and the side collection via regex on augmented fields.
  const results = [];

  for (const { q, kind } of CANONICAL_QUERIES) {
    // (a) Paragraph baseline via Atlas Search, scoped to our 100 guids
    const paragraphHits = await atlasTextSearch({
      query: q,
      guids,
      limit: 20,
      requestId: `CHAPRECALL-${q}`.replace(/\s+/g, '-'),
    });

    // (b) Chapter side coll via regex on augmented fields
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'i');
    const chapterHits = await sideColl.find({
      $or: [
        { 'metadataRaw.headline': re },
        { 'metadataRaw.summary': re },
        { 'metadataRaw.keywords': { $elemMatch: { $regex: re } } },
        { 'metadataRaw.named_entities':   { $elemMatch: { $regex: re } } },
        { 'metadataRaw.technical_terms':  { $elemMatch: { $regex: re } } },
        { 'metadataRaw.urls_and_domains': { $elemMatch: { $regex: re } } },
        { 'metadataRaw.verbatim_phrases': { $elemMatch: { $regex: re } } },
      ],
    })
      .project({ pineconeId: 1, guid: 1, 'metadataRaw.headline': 1 })
      .limit(20)
      .toArray();

    // Ground truth: which guids actually contain the term in any paragraph?
    const groundTruthGuids = new Set(
      (await JamieVectorMetadata.distinct('guid', {
        type: 'paragraph',
        guid: { $in: guids },
        'metadataRaw.text': re,
      }))
    );

    const paragraphGuids = new Set(paragraphHits.map(h => h.id.replace(/_p\d+$/, '')));
    const chapterGuids = new Set(chapterHits.map(c => c.guid));

    const truth = groundTruthGuids.size;
    const paragraphRecall = truth ? [...paragraphGuids].filter(g => groundTruthGuids.has(g)).length / truth : null;
    const chapterRecall = truth ? [...chapterGuids].filter(g => groundTruthGuids.has(g)).length / truth : null;

    results.push({
      q, kind,
      truth,
      paragraphHits: paragraphHits.length,
      chapterHits: chapterHits.length,
      paragraphRecall,
      chapterRecall,
      sampleChapter: chapterHits[0]?.metadataRaw?.headline || null,
    });
  }

  return results;
}

// ─── Report ───────────────────────────────────────────────────────────────

function writeReport({ regenInfo, evalResults, atlasEvalResults }) {
  const lines = [];
  const r = s => lines.push(s);
  r(`# Chapter-augmented recall validation — ${new Date().toISOString()}`);
  r('');
  if (regenInfo) {
    r(`## Regeneration phase`);
    r(`- Episodes sampled: ${regenInfo.guids?.length ?? '?'} (seed + ${RANDOM_SAMPLE_SIZE} random)`);
    r(`- Chapters processed: ${regenInfo.processed}`);
    r(`- Failed: ${regenInfo.failed}`);
    r(`- LLM cost: ~$${regenInfo.cost?.toFixed(2)}`);
    r('');
  }
  if (evalResults) {
    r(`## Recall comparison — Mongo regex (per query, scoped to 100 episode sample)`);
    r('');
    r(`| Query | Kind | Ground truth (guids w/ term) | Paragraph hits | Chapter hits | Paragraph recall | Chapter recall |`);
    r(`|---|---|---|---|---|---|---|`);
    for (const e of evalResults) {
      const pr = e.paragraphRecall == null ? '—' : `${(e.paragraphRecall * 100).toFixed(0)}%`;
      const cr = e.chapterRecall == null ? '—' : `${(e.chapterRecall * 100).toFixed(0)}%`;
      r(`| \`${e.q}\` | ${e.kind} | ${e.truth} | ${e.paragraphHits} | ${e.chapterHits} | ${pr} | ${cr} |`);
    }
    r('');
  }
  if (atlasEvalResults) {
    r(`## Recall comparison — REAL Atlas Search on side-collection index "${ATLAS_INDEX_NAME}"`);
    r('');
    r(`| Query | Kind | Ground truth | Paragraph hits | Chapter hits | Para recall | Chapter recall | Chapter precision | Top chapter |`);
    r(`|---|---|---|---|---|---|---|---|---|`);
    for (const e of atlasEvalResults) {
      const pr = e.paragraphRecall == null ? '—' : `${(e.paragraphRecall * 100).toFixed(0)}%`;
      const cr = e.chapterRecall == null ? '—' : `${(e.chapterRecall * 100).toFixed(0)}%`;
      const cp = e.chapterPrecision == null ? '—' : `${(e.chapterPrecision * 100).toFixed(0)}%`;
      const note = e.chapterErr ? `⚠ ${e.chapterErr.slice(0, 50)}` : (e.sampleChapter || '').slice(0, 50);
      r(`| \`${e.q}\` | ${e.kind} | ${e.truth} | ${e.paragraphHits} | ${e.chapterHits} | ${pr} | ${cr} | ${cp} | ${note.replace(/\|/g, '\\|')} |`);
    }
    r('');
  }
  if (evalResults || atlasEvalResults) {
    r(`## Interpretation`);
    r(`- "Ground truth" = number of episode-guids that contain the term in any paragraph text (within the 100-episode sample).`);
    r(`- "Paragraph hits" = what existing prod \`paragraph_text_search\` returns when scoped to these 100 episodes.`);
    r(`- "Chapter hits" = what the augmented chapter index returns (regex for the first table, real Atlas Search for the second).`);
    r(`- "Chapter precision" = fraction of returned chapters whose underlying paragraphs actually contain the term.`);
    r(`- If chapter recall ≥ ~90% of paragraph recall on the Atlas table, the augmented chapter approach is viable.`);
    r(`- If chapter recall < 70%, augmentation isn't capturing enough — likely needs prompt iteration.`);
  }
  const outDir = path.join(__dirname, '..', 'tmp');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `chapter-recall-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`\nReport written to: ${out}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  if (!mongoURI) { console.error('MONGO_URI not set'); process.exit(1); }
  if (!process.env.OPENAI_API_KEY && FLAGS.regenerate) {
    console.error('OPENAI_API_KEY not set (required for --regenerate)'); process.exit(1);
  }

  if (!FLAGS.regenerate && !FLAGS.evaluate && !FLAGS.atlasEvaluate && !FLAGS.reset) {
    console.log(`Dry plan only. Pass --regenerate, --evaluate, --atlas-evaluate, --reset, or any combo.`);
    console.log(`\nWhat each phase does:`);
    console.log(`  --regenerate       Seed-and-expand. Loads (or creates) a LOCKED guid target list at`);
    console.log(`                     ${path.relative(process.cwd(), TARGET_GUIDS_FILE)}`);
    console.log(`                     so resumed runs target the same episodes. Augments any chapter not`);
    console.log(`                     already in "${SIDE_COLL_NAME}" via ${AUG_MODEL}.`);
    console.log(`                     - First run: seed from canonical-query content match + sample`);
    console.log(`                       ${RANDOM_SAMPLE_SIZE} random episodes, save target file, augment all.`);
    console.log(`                     - Resume: load target file, augment any remaining chapters.`);
    console.log(`                     - After an interrupted run: target rebuilt to include all already-`);
    console.log(`                       processed guids + seed + top-up randoms, so prior work is preserved.`);
    if (SMOKE) {
      console.log(`                     [SMOKE MODE] cap=${MAX_TARGET_EPISODES} episodes, ~$0.10, time: ~30s at`);
      console.log(`                     concurrency=${CONCURRENCY}. prod jamieVectorMetadata is NOT modified.`);
    } else {
      console.log(`                     cost: ~$8-12 for full ${RANDOM_SAMPLE_SIZE}-sample run with v2 prompt,`);
      console.log(`                     time: ~30-45 min at concurrency=${CONCURRENCY}.`);
      console.log(`                     prod jamieVectorMetadata is NOT modified.`);
    }
    console.log(`  --evaluate         run canonical queries against (a) prod paragraph_text_search scoped`);
    console.log(`                     to the sampled episodes, (b) side coll via Mongo regex.`);
    console.log(`                     cost: ~free. time: ~1 min. Approximation; doesn't use Atlas Search.`);
    console.log(`  --atlas-evaluate   same as --evaluate but hits a REAL Atlas Search index on the side coll`);
    console.log(`                     (named "${ATLAS_INDEX_NAME}"). Requires the index to be built in Atlas`);
    console.log(`                     UI first using tmp/chapter-test-atlas-index.json.`);
    console.log(`                     cost: ~free. time: ~1 min.`);
    console.log(`  --reset            DESTRUCTIVE. Drops side collection "${SIDE_COLL_NAME}" and removes`);
    console.log(`                     the target-guids file. Use to start over with a clean slate (e.g.`);
    console.log(`                     after a prompt change). Can be combined with --regenerate to`);
    console.log(`                     wipe + rebuild in one command. Prod jamieVectorMetadata untouched.`);
    console.log(`\nEnv overrides:`);
    console.log(`  RANDOM_SAMPLE_SIZE=N           change random count (default 2000)`);
    console.log(`  CHAPTER_AUG_CONCURRENCY=N      parallel workers for --regenerate (default ${CONCURRENCY})`);
    console.log(`  CHAPTER_TEST_INDEX_NAME=name   override Atlas index name (default "${ATLAS_INDEX_NAME}")`);
    console.log(`\nCleanup when done testing:`);
    console.log(`  - rm ${path.relative(process.cwd(), TARGET_GUIDS_FILE)}`);
    console.log(`  - Atlas UI: drop the "${ATLAS_INDEX_NAME}" Atlas Search index`);
    console.log(`  - mongosh:  db.${SIDE_COLL_NAME}.drop()`);
    return;
  }

  console.log(`Connecting to MongoDB…`);
  const conn = await mongoose.connect(mongoURI);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // --reset wipes the side collection + the locked target file so the next
  // regenerate starts completely fresh. Affects only SIDE_COLL_NAME (which
  // defaults to a smoke-specific name under --smoke). Prod
  // jamieVectorMetadata is never touched.
  if (FLAGS.reset) {
    console.log(`\n[--reset] Dropping side collection "${SIDE_COLL_NAME}" and target file…`);
    try {
      await conn.connection.db.dropCollection(SIDE_COLL_NAME);
      console.log(`  ✓ dropped collection "${SIDE_COLL_NAME}"`);
    } catch (err) {
      // ns-not-found is fine — already absent
      if (err.codeName === 'NamespaceNotFound' || /ns not found/i.test(err.message || '')) {
        console.log(`  • collection "${SIDE_COLL_NAME}" did not exist (skipped)`);
      } else {
        console.error(`  ✘ drop failed: ${err.message}`);
        process.exit(1);
      }
    }
    if (fs.existsSync(TARGET_GUIDS_FILE)) {
      fs.unlinkSync(TARGET_GUIDS_FILE);
      console.log(`  ✓ removed ${TARGET_GUIDS_FILE}`);
    } else {
      console.log(`  • target file did not exist (skipped)`);
    }
    if (!FLAGS.regenerate && !FLAGS.evaluate && !FLAGS.atlasEvaluate) {
      console.log(`\nReset complete. Re-run with --regenerate to repopulate.`);
      await mongoose.disconnect();
      return;
    }
    console.log('');
  }

  let regenInfo = null;
  let guidsFromRegen = null;

  if (FLAGS.regenerate) {
    regenInfo = await phaseRegenerate({ openai, mongoConn: conn });
    guidsFromRegen = regenInfo.guids;
  }

  let evalResults = null;
  let atlasEvalResults = null;
  if (FLAGS.evaluate || FLAGS.atlasEvaluate) {
    // If we didn't just regenerate, derive guids from what's in the side coll
    let guids = guidsFromRegen;
    if (!guids) {
      const sideColl = conn.connection.db.collection(SIDE_COLL_NAME);
      const distinctGuids = await sideColl.distinct('guid');
      guids = distinctGuids;
      console.log(`Re-using ${guids.length} guids from existing side collection.`);
    }
    if (!guids || guids.length === 0) {
      console.error('No guids available. Run --regenerate first.'); process.exit(1);
    }
    if (FLAGS.evaluate) {
      evalResults = await phaseEvaluate({ mongoConn: conn, guids });
    }
    if (FLAGS.atlasEvaluate) {
      atlasEvalResults = await phaseAtlasEvaluate({ mongoConn: conn, guids });
    }
  }

  writeReport({ regenInfo, evalResults, atlasEvalResults });
  await mongoose.disconnect();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
