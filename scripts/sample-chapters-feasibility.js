/**
 * sample-chapters-feasibility.js
 *
 * One-shot read-only feasibility probe for chapter-level lexical search.
 *
 * Question: if we replaced the paragraph-level Atlas Search index with a
 * chapter-level one, would chapters carry enough searchable text to recover
 * the canonical query classes (proper nouns, brand compounds, spelled-out
 * forms)?
 *
 * Outputs to ./tmp/chapter-feasibility-<timestamp>.txt:
 *   1. Corpus stats: total chapter count, avg/median field sizes
 *   2. Random sample of 15 chapters with their headline/summary/keywords
 *   3. Hit check for canonical smoke-test queries — does the chapter text
 *      contain the literal term anywhere?
 *
 * Usage:
 *   node scripts/sample-chapters-feasibility.js
 *
 * Safe against prod. Read-only.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

const CANONICAL_QUERIES = [
  'lncurl',
  'Alby Hub',
  'Nostr Wallet Connect',
  'BIP-32',
  'nostr',
  'lightning',
  'bitcoin',
];

const SAMPLE_SIZE = 15;
const HIT_CHECK_LIMIT_PER_QUERY = 5;

function fmtNum(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const mongoURI = process.env.DEBUG_MODE === 'true'
    ? process.env.MONGO_DEBUG_URI
    : process.env.MONGO_URI;

  if (!mongoURI) {
    console.error('MONGO_URI not set');
    process.exit(1);
  }

  console.log('Connecting to MongoDB…');
  await mongoose.connect(mongoURI);
  console.log('Connected.');

  const outDir = path.join(__dirname, '..', 'tmp');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `chapter-feasibility-${ts}.txt`);
  const lines = [];
  const log = (s) => { console.log(s); lines.push(s); };

  log(`Chapter feasibility report — ${new Date().toISOString()}`);
  log('='.repeat(72));

  // --- 1. Corpus stats ---
  log('\n## 1. Corpus stats');
  const totalChapters = await JamieVectorMetadata.countDocuments({ type: 'chapter' });
  const totalParagraphs = await JamieVectorMetadata.countDocuments({ type: 'paragraph' });
  log(`  Total chapters:   ${fmtNum(totalChapters)}`);
  log(`  Total paragraphs: ${fmtNum(totalParagraphs)}`);
  log(`  Ratio: 1 chapter per ${(totalParagraphs / Math.max(totalChapters, 1)).toFixed(1)} paragraphs`);

  // --- 2. Field-size distribution across a larger sample ---
  log('\n## 2. Field-size distribution (1000 chapter sample)');
  const sizeSample = await JamieVectorMetadata
    .find({ type: 'chapter' })
    .select('metadataRaw')
    .limit(1000)
    .lean();

  const headlineLens = [];
  const summaryLens = [];
  const keywordCounts = [];
  const totalIndexableChars = [];
  let withHeadline = 0;
  let withSummary = 0;
  let withKeywords = 0;
  let emptyAllThree = 0;

  for (const doc of sizeSample) {
    const m = doc.metadataRaw || {};
    const headline = typeof m.headline === 'string' ? m.headline : '';
    const summary = typeof m.summary === 'string' ? m.summary : '';
    const keywords = Array.isArray(m.keywords) ? m.keywords : [];
    headlineLens.push(headline.length);
    summaryLens.push(summary.length);
    keywordCounts.push(keywords.length);
    totalIndexableChars.push(
      headline.length + summary.length + keywords.join(' ').length
    );
    if (headline) withHeadline++;
    if (summary) withSummary++;
    if (keywords.length) withKeywords++;
    if (!headline && !summary && !keywords.length) emptyAllThree++;
  }

  const stats = (arr, label) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const sum = arr.reduce((a, b) => a + b, 0);
    const mean = sum / arr.length;
    log(`  ${label.padEnd(28)} mean=${mean.toFixed(1)}  p50=${percentile(sorted, 50)}  p90=${percentile(sorted, 90)}  p99=${percentile(sorted, 99)}  max=${sorted[sorted.length - 1]}`);
  };

  stats(headlineLens, 'headline length (chars)');
  stats(summaryLens, 'summary length (chars)');
  stats(keywordCounts, 'keyword count');
  stats(totalIndexableChars, 'total searchable chars/chapter');
  log(`  Coverage in sample of ${sizeSample.length}:`);
  log(`    has headline: ${withHeadline} (${(100 * withHeadline / sizeSample.length).toFixed(1)}%)`);
  log(`    has summary:  ${withSummary} (${(100 * withSummary / sizeSample.length).toFixed(1)}%)`);
  log(`    has keywords: ${withKeywords} (${(100 * withKeywords / sizeSample.length).toFixed(1)}%)`);
  log(`    EMPTY (all three): ${emptyAllThree} (${(100 * emptyAllThree / sizeSample.length).toFixed(1)}%)`);

  // Project the indexed size at the chapter level
  const avgCharsPerChapter = totalIndexableChars.reduce((a, b) => a + b, 0) / sizeSample.length;
  const projectedIndexBytes = avgCharsPerChapter * totalChapters;
  log(`\n  Projected raw text volume at chapter level:`);
  log(`    avg searchable chars/chapter: ${avgCharsPerChapter.toFixed(0)}`);
  log(`    total searchable chars across corpus: ${fmtNum(Math.round(projectedIndexBytes))}`);
  log(`    rough indexed-bytes estimate (standard analyzer, ~4x overhead): ${fmtNum(Math.round(projectedIndexBytes * 4 / 1024 / 1024))} MB`);

  // --- 3. Random sample for human inspection ---
  log(`\n## 3. Random sample of ${SAMPLE_SIZE} chapters`);
  log('='.repeat(72));
  const randomSample = await JamieVectorMetadata.aggregate([
    { $match: { type: 'chapter' } },
    { $sample: { size: SAMPLE_SIZE } },
    { $project: { pineconeId: 1, guid: 1, feedId: 1, metadataRaw: 1 } },
  ]);

  for (const [i, doc] of randomSample.entries()) {
    const m = doc.metadataRaw || {};
    log(`\n[${i + 1}] feedId=${doc.feedId}  guid=${doc.guid}`);
    log(`    pineconeId: ${doc.pineconeId}`);
    log(`    headline:   ${m.headline || '(none)'}`);
    log(`    summary:    ${(m.summary || '(none)').slice(0, 240)}${(m.summary || '').length > 240 ? '…' : ''}`);
    log(`    keywords:   ${Array.isArray(m.keywords) ? JSON.stringify(m.keywords) : '(none)'}`);
  }

  // --- 4. Hit check for canonical queries ---
  log(`\n\n## 4. Canonical query hit check`);
  log('Does any chapter contain the literal term in headline/summary/keywords?');
  log('='.repeat(72));

  for (const query of CANONICAL_QUERIES) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    const found = await JamieVectorMetadata.find({
      type: 'chapter',
      $or: [
        { 'metadataRaw.headline': regex },
        { 'metadataRaw.summary': regex },
        { 'metadataRaw.keywords': { $elemMatch: { $regex: regex } } },
      ],
    })
      .select('guid feedId metadataRaw')
      .limit(HIT_CHECK_LIMIT_PER_QUERY)
      .lean();

    const totalHits = await JamieVectorMetadata.countDocuments({
      type: 'chapter',
      $or: [
        { 'metadataRaw.headline': regex },
        { 'metadataRaw.summary': regex },
        { 'metadataRaw.keywords': { $elemMatch: { $regex: regex } } },
      ],
    });

    log(`\nQUERY: "${query}"  total chapter hits: ${totalHits}`);
    if (totalHits === 0) {
      log(`  (no chapter contains this term — chapter-level lexical would MISS this query)`);
    } else {
      log(`  first ${Math.min(found.length, HIT_CHECK_LIMIT_PER_QUERY)} hits:`);
      for (const doc of found) {
        const m = doc.metadataRaw || {};
        const headlineMatch = m.headline && regex.test(m.headline);
        const summaryMatch = m.summary && regex.test(m.summary);
        const keywordMatch = Array.isArray(m.keywords) && m.keywords.some(k => regex.test(k));
        const sources = [
          headlineMatch && 'headline',
          summaryMatch && 'summary',
          keywordMatch && 'keywords',
        ].filter(Boolean).join('+');
        log(`    [${sources}]  headline="${(m.headline || '').slice(0, 80)}"  feedId=${doc.feedId}`);
      }
    }
  }

  log('\n' + '='.repeat(72));
  log('Report end.');

  fs.writeFileSync(outFile, lines.join('\n'));
  console.log(`\nReport written to: ${outFile}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
