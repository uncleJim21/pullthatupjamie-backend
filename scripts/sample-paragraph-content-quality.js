/**
 * sample-paragraph-content-quality.js
 *
 * Question: if we drop paragraphs below N words, what fraction of them
 * actually carry searchable content vs. pure filler? Tests multiple word
 * thresholds and content-signal heuristics so we can pick a filter that
 * trims storage without dropping content with proper nouns / URLs /
 * technical terms.
 *
 * Method:
 *   1. Sample 100 random episode guids
 *   2. Pull every paragraph for those episodes
 *   3. For each paragraph, compute:
 *        - word count
 *        - has_proper_noun (capitalized non-sentence-start word)
 *        - has_url (http, www, .com, etc.)
 *        - has_number (digits, BIP-32 style)
 *        - has_acronym (3+ uppercase letters in a row)
 *        - is_filler (all-lowercase, only common words)
 *   4. Bucket by word count, report % with each signal
 *   5. Show sample short paragraphs that DO carry signal so we can eyeball
 *      what the filter would drop
 *
 * Read-only. Safe against prod.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

const NUM_EPISODES = 100;
const BUCKETS = [
  { label: '1-3',   min: 1,   max: 3 },
  { label: '4-7',   min: 4,   max: 7 },
  { label: '8-12',  min: 8,   max: 12 },
  { label: '13-20', min: 13,  max: 20 },
  { label: '21-30', min: 21,  max: 30 },
  { label: '31-50', min: 31,  max: 50 },
  { label: '51+',   min: 51,  max: Infinity },
];

// Common filler-only words. If a paragraph contains ONLY these (post lowercase),
// it's almost certainly conversational glue with no searchable content.
const FILLER_WORDS = new Set([
  'yeah','yes','no','nope','yep','ok','okay','alright','right','sure','exactly',
  'totally','definitely','absolutely','agreed','same','word','facts','true',
  'um','uh','uhh','umm','hmm','huh','oh','ah','ahh','eh','mm','mmhmm','wow',
  'i','me','you','we','they','he','she','it','that','this','those','these',
  'a','an','the','and','or','but','so','then','if','when','what','why','how',
  'is','are','was','were','be','been','am','do','does','did','done','have',
  'has','had','will','would','could','should','can','may','might','must',
  'just','too','very','really','quite','also','well','like','know','think',
  'mean','say','said','tell','get','got','go','goes','went','come','came',
  'good','great','nice','cool','interesting','funny','crazy','wild','wow',
  'thing','things','stuff','something','anything','everything','nothing',
  'one','two','three','some','any','all','many','much','more','less','lot',
  "i'm","you're","we're","they're","it's","that's","there's","what's",
  "don't","doesn't","didn't","won't","can't","couldn't","wouldn't","isn't",
  "to","of","in","on","at","by","for","with","about","from","as","into",
  "out","up","down","over","under","through","because","though","while",
  "now","here","there","everyone","everybody","somebody","anybody",
  'man','guy','dude','bro','sir','please','thanks','thank','welcome','sorry',
]);

const URL_RE = /https?:\/\/|www\.|\.com|\.org|\.io|\.net|\.lol|\.xyz/i;
const NUMBER_RE = /\b\d+\b|\b[a-z]+-\d+\b|\b[A-Z]{2,}\d+\b/;
const ACRONYM_RE = /\b[A-Z]{3,}\b/;

function classify(text) {
  if (!text || typeof text !== 'string') {
    return { wordCount: 0, signals: {}, isFiller: true };
  }
  const cleaned = text.trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Proper noun: capitalized word that is NOT the first word of a sentence
  // and not all-caps (which we count as acronym).
  let hasProperNoun = false;
  const sentenceStarters = new Set([0]);
  let sentenceBreak = false;
  for (let i = 0; i < words.length; i++) {
    if (sentenceBreak) sentenceStarters.add(i);
    sentenceBreak = /[.!?]$/.test(words[i]);
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[^a-zA-Z]/g, '');
    if (w.length < 2) continue;
    if (sentenceStarters.has(i)) continue;
    // Lower-case the rest then check if it was capitalized
    if (/^[A-Z][a-z]/.test(w)) { hasProperNoun = true; break; }
  }

  const hasUrl = URL_RE.test(cleaned);
  const hasNumber = NUMBER_RE.test(cleaned);
  const hasAcronym = ACRONYM_RE.test(cleaned);

  // Filler check: every word, lowercased and stripped of punctuation, is in
  // the FILLER_WORDS set
  const isFiller = words.every(w => {
    const stripped = w.toLowerCase().replace(/[^a-z']/g, '');
    return FILLER_WORDS.has(stripped) || stripped.length === 0;
  });

  const hasAnySignal = hasProperNoun || hasUrl || hasNumber || hasAcronym;

  return {
    wordCount,
    signals: { hasProperNoun, hasUrl, hasNumber, hasAcronym, hasAnySignal },
    isFiller,
  };
}

function fmtPct(n, total) {
  if (!total) return '   0.0%';
  return `${(100 * n / total).toFixed(1).padStart(5)}%`;
}

function bucketFor(wc) {
  for (const b of BUCKETS) {
    if (wc >= b.min && wc <= b.max) return b;
  }
  return BUCKETS[BUCKETS.length - 1];
}

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  if (!mongoURI) { console.error('MONGO_URI not set'); process.exit(1); }

  console.log('Connecting to MongoDB…');
  await mongoose.connect(mongoURI);
  console.log('Connected.');

  const outDir = path.join(__dirname, '..', 'tmp');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `paragraph-quality-${ts}.txt`);
  const lines = [];
  const log = (s) => { console.log(s); lines.push(s); };

  log(`Paragraph content-quality report — ${new Date().toISOString()}`);
  log('='.repeat(78));

  // --- 1. Sample episode guids ---
  log(`\n## Sampling ${NUM_EPISODES} random episode guids`);
  const episodes = await JamieVectorMetadata.aggregate([
    { $match: { type: 'episode' } },
    { $sample: { size: NUM_EPISODES } },
    { $project: { guid: 1, feedId: 1 } },
  ]);
  log(`  Got ${episodes.length} episodes`);
  const episodeGuids = episodes.map(e => e.guid).filter(Boolean);

  // --- 2. Pull paragraphs ---
  log(`\n## Pulling paragraphs for those episodes`);
  const paragraphs = await JamieVectorMetadata
    .find({ type: 'paragraph', guid: { $in: episodeGuids } })
    .select('metadataRaw guid feedId')
    .lean();
  log(`  ${paragraphs.length.toLocaleString()} paragraphs across ${episodeGuids.length} episodes`);
  log(`  (avg ${(paragraphs.length / Math.max(episodeGuids.length, 1)).toFixed(1)} paragraphs/episode)`);

  // --- 3. Classify each ---
  const buckets = {};
  for (const b of BUCKETS) {
    buckets[b.label] = {
      count: 0, totalChars: 0,
      properNoun: 0, url: 0, number: 0, acronym: 0, anySignal: 0, filler: 0,
      samples: { withSignal: [], filler: [], plain: [] }
    };
  }

  let totalChars = 0;
  for (const p of paragraphs) {
    const text = p?.metadataRaw?.text || '';
    totalChars += text.length;
    const c = classify(text);
    const b = bucketFor(c.wordCount);
    const bucket = buckets[b.label];
    bucket.count++;
    bucket.totalChars += text.length;
    if (c.signals.hasProperNoun) bucket.properNoun++;
    if (c.signals.hasUrl) bucket.url++;
    if (c.signals.hasNumber) bucket.number++;
    if (c.signals.hasAcronym) bucket.acronym++;
    if (c.signals.hasAnySignal) bucket.anySignal++;
    if (c.isFiller) bucket.filler++;
    // Collect samples for inspection
    if (c.signals.hasAnySignal && bucket.samples.withSignal.length < 5) {
      bucket.samples.withSignal.push({ text, signals: c.signals });
    } else if (c.isFiller && bucket.samples.filler.length < 5) {
      bucket.samples.filler.push({ text });
    } else if (!c.signals.hasAnySignal && !c.isFiller && bucket.samples.plain.length < 5) {
      bucket.samples.plain.push({ text });
    }
  }

  const totalParas = paragraphs.length;

  // --- 4. Distribution table ---
  log(`\n## Word-count distribution + content signals`);
  log('='.repeat(78));
  log(`${'bucket'.padEnd(8)}${'count'.padStart(8)}${'%total'.padStart(8)}  ${'propN'.padStart(7)}${'URL'.padStart(7)}${'#'.padStart(7)}${'ACRO'.padStart(7)}${'anySig'.padStart(8)}${'filler'.padStart(8)}`);
  for (const b of BUCKETS) {
    const x = buckets[b.label];
    log(
      `${b.label.padEnd(8)}` +
      `${x.count.toLocaleString().padStart(8)}` +
      `${fmtPct(x.count, totalParas).padStart(8)}  ` +
      `${fmtPct(x.properNoun, x.count).padStart(7)}` +
      `${fmtPct(x.url, x.count).padStart(7)}` +
      `${fmtPct(x.number, x.count).padStart(7)}` +
      `${fmtPct(x.acronym, x.count).padStart(7)}` +
      `${fmtPct(x.anySignal, x.count).padStart(8)}` +
      `${fmtPct(x.filler, x.count).padStart(8)}`
    );
  }

  // --- 5. Filter simulations ---
  log(`\n## Filter-strategy simulations`);
  log('='.repeat(78));
  const strategies = [
    { name: '>= 5 words', keep: (wc, sig) => wc >= 5 },
    { name: '>= 10 words', keep: (wc, sig) => wc >= 10 },
    { name: '>= 15 words', keep: (wc, sig) => wc >= 15 },
    { name: '>= 30 words', keep: (wc, sig) => wc >= 30 },
    { name: 'NOT filler-only', keep: (wc, sig, isFiller) => !isFiller },
    { name: '>= 5 OR has signal', keep: (wc, sig) => wc >= 5 || sig.hasAnySignal },
    { name: '>= 10 OR has signal', keep: (wc, sig) => wc >= 10 || sig.hasAnySignal },
    { name: '>= 15 OR has signal', keep: (wc, sig) => wc >= 15 || sig.hasAnySignal },
    { name: 'NOT filler AND (>= 5 OR has signal)', keep: (wc, sig, isFiller) => !isFiller && (wc >= 5 || sig.hasAnySignal) },
  ];

  // Re-walk for filter simulation (cheaper than caching the classify output)
  const strategyResults = strategies.map(s => ({
    name: s.name, kept: 0, keptChars: 0,
    droppedWithSignal: 0, droppedNonFiller: 0,
  }));

  for (const p of paragraphs) {
    const text = p?.metadataRaw?.text || '';
    const c = classify(text);
    for (let i = 0; i < strategies.length; i++) {
      const keep = strategies[i].keep(c.wordCount, c.signals, c.isFiller);
      if (keep) {
        strategyResults[i].kept++;
        strategyResults[i].keptChars += text.length;
      } else {
        if (c.signals.hasAnySignal) strategyResults[i].droppedWithSignal++;
        if (!c.isFiller) strategyResults[i].droppedNonFiller++;
      }
    }
  }

  log(`${'strategy'.padEnd(42)}${'kept'.padStart(10)}${'%kept'.padStart(8)}${'%chars'.padStart(9)}${'sig-drops'.padStart(11)}${'non-filler-drops'.padStart(18)}`);
  for (const r of strategyResults) {
    log(
      `${r.name.padEnd(42)}` +
      `${r.kept.toLocaleString().padStart(10)}` +
      `${fmtPct(r.kept, totalParas).padStart(8)}` +
      `${fmtPct(r.keptChars, totalChars).padStart(9)}` +
      `${r.droppedWithSignal.toLocaleString().padStart(11)}` +
      `${r.droppedNonFiller.toLocaleString().padStart(18)}`
    );
  }
  log(`  notes:`);
  log(`    sig-drops = paragraphs the filter would DROP that have proper-noun/URL/number/acronym`);
  log(`    non-filler-drops = paragraphs the filter would DROP that are NOT 100% filler words`);

  // --- 6. Sample paragraphs from each short bucket ---
  log(`\n## Sample short paragraphs (for eyeball check)`);
  log('='.repeat(78));
  for (const b of BUCKETS) {
    if (b.min > 12) continue; // only show short buckets
    const x = buckets[b.label];
    log(`\n### Bucket ${b.label} words (n=${x.count})`);

    log(`\n  -- Has signal (these would be MISSED by a pure word-count filter) --`);
    if (x.samples.withSignal.length === 0) log(`    (none)`);
    for (const s of x.samples.withSignal) {
      const sigs = Object.entries(s.signals).filter(([k, v]) => v && k !== 'hasAnySignal').map(([k]) => k.replace('has', '').toLowerCase()).join(',');
      log(`    [${sigs}] "${s.text}"`);
    }

    log(`\n  -- All-filler examples --`);
    if (x.samples.filler.length === 0) log(`    (none)`);
    for (const s of x.samples.filler) {
      log(`    "${s.text}"`);
    }

    log(`\n  -- Plain content (no proper noun, not pure filler) --`);
    if (x.samples.plain.length === 0) log(`    (none)`);
    for (const s of x.samples.plain) {
      log(`    "${s.text}"`);
    }
  }

  log('\n' + '='.repeat(78));
  log('Report end.');

  fs.writeFileSync(outFile, lines.join('\n'));
  console.log(`\nReport written to: ${outFile}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
