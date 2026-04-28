/**
 * smoke-test-atlas-search.js
 *
 * One-shot manual verification for the proper-noun lexical-fallback path.
 * Connects to prod Mongo (read-only), runs a handful of representative
 * queries through atlasTextSearch directly, and prints what surfaced for
 * each. Use this BEFORE flipping PROPER_NOUN_SEARCH_ENABLED=true to
 * confirm the index returns the expected hits.
 *
 * Usage:
 *   node scripts/smoke-test-atlas-search.js
 *   node scripts/smoke-test-atlas-search.js "your custom query"
 *
 * Expected canonical hit (Roland's email, Apr 23 2026):
 *   "lncurl.lol" should surface a Bitcoin Audible / Roundtable_018 paragraph
 *   that says "...l n curl. It's l n curl dot loll. So l n c u r l dot l o l."
 *
 * This script is read-only. No writes. Safe against prod.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const { atlasTextSearch } = require('../services/atlasTextSearch');
const { isProperNounShaped } = require('../utils/properNounDetector');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');

const DEFAULT_QUERIES = [
  'lncurl.lol',
  'lncurl',
  'l n c u r l',
  'Alby Hub',
  'Nostr Wallet Connect',
  'BIP-32',
  '#nostr',
];

const SNIPPET_RADIUS_CHARS = 80;

function makeSnippet(text, query) {
  if (!text) return '(no text)';
  const lower = text.toLowerCase();
  const needle = query.toLowerCase().split(/\s+/)[0];
  const idx = lower.indexOf(needle);
  if (idx < 0) return text.slice(0, 200) + (text.length > 200 ? '…' : '');
  const start = Math.max(0, idx - SNIPPET_RADIUS_CHARS);
  const end = Math.min(text.length, idx + needle.length + SNIPPET_RADIUS_CHARS);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

async function probe(query) {
  const banner = '─'.repeat(72);
  console.log(`\n${banner}`);
  console.log(`QUERY: "${query}"`);
  console.log(`isProperNounShaped: ${isProperNounShaped(query)}`);
  console.log(banner);

  const started = Date.now();
  const hits = await atlasTextSearch({ query, limit: 8, requestId: 'SMOKE' });
  const elapsed = Date.now() - started;

  console.log(`Atlas Search returned ${hits.length} hits in ${elapsed}ms.`);
  if (hits.length === 0) {
    console.log('(no hits)');
    return;
  }

  const ids = hits.map(h => h.id);
  const docs = await JamieVectorMetadata
    .find({ pineconeId: { $in: ids }, type: 'paragraph' })
    .select('pineconeId metadataRaw')
    .lean();

  const docById = new Map();
  for (const d of docs) docById.set(d.pineconeId, d);

  hits.forEach((h, i) => {
    const doc = docById.get(h.id);
    const meta = doc?.metadataRaw || {};
    const snippet = makeSnippet(meta.text || '', query);
    console.log(`  [${i + 1}] score=${h.score?.toFixed?.(3) ?? h.score}  pineconeId=${h.id}`);
    console.log(`      episode: ${meta.episode || meta.title || '(unknown)'}`);
    console.log(`      creator: ${meta.creator || '(unknown)'}`);
    console.log(`      date:    ${meta.publishedDate || '(unknown)'}`);
    console.log(`      time:    ${meta.start_time ?? '?'}s - ${meta.end_time ?? '?'}s`);
    console.log(`      snippet: ${snippet}`);
  });
}

async function main() {
  const customQuery = process.argv[2];
  const queries = customQuery ? [customQuery] : DEFAULT_QUERIES;

  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not set. Provide via .env or environment.');
    process.exit(1);
  }

  console.log('Connecting to MongoDB…');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.');

  try {
    for (const q of queries) {
      try {
        await probe(q);
      } catch (err) {
        console.error(`  ERROR on "${q}": ${err.message}`);
      }
    }
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected.');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Smoke test failed:', err);
    process.exit(1);
  });
}
