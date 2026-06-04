#!/usr/bin/env node
/**
 * Repro + regression for the clip reranker (utils/clipReranker.js).
 *
 *   node tests/clip-reranker.test.js
 *
 * The reranker is supposed to score each clip 0-10 and DROP low scorers —
 * ad reads / sponsor spots are explicitly meant to score 0-1. This exercises it
 * against a known mix (2 obvious ad reads + 3 substantive clips) and asserts the
 * ads are dropped and the substantive clips survive.
 *
 * BASELINE (before the fix): the call uses response_format:{type:'json_object'}
 * while the prompt asks for a bare JSON array, so gpt-4o-mini returns a flattened
 * dup-key object like {"i":0,"s":10,"i":1,"s":6} → JSON.parse keeps only the last
 * pair → parser finds no `scores` → every clip defaults to 5 → NOTHING is dropped.
 * This test FAILS on baseline (ads survive) and PASSES after the schema fix.
 *
 * Requires OPENAI_API_KEY. Exits non-zero on failure.
 */

require('dotenv').config();
const { OpenAI } = require('openai');
const { rerankClips } = require('../utils/clipReranker');

const AD_1 = 'CoreWeave is the essential cloud for AI. Ready for anything, ready for AI. To learn more about how CoreWeave powers the world\'s best AI, go to coreweave.com slash ready for anything.';
const AD_2 = 'Support for the show comes from CoreWeave. Everywhere you look, AI is expanding what we thought was possible. CoreWeave powers AI pioneers around the world with purpose-built tech.';
const REAL_1 = 'CoreWeave carries a lot of debt — there\'s a revolving credit line with JPMorgan and the financing structure is aggressive given how capex-heavy the data-center buildout is.';
const REAL_2 = 'CoreWeave\'s revenue grew triple digits, but customer concentration with Microsoft is a real risk to the long-term margins if that contract renegotiates.';
const REAL_3 = 'The bull case on CoreWeave is that it locked in GPU supply early and has multi-year take-or-pay contracts; the bear case is the whole thing unwinds if AI capex slows.';

const ADS = [AD_1, AD_2];
const clips = [
  { text: AD_1, creator: 'The Vergecast', episode: 'x' },
  { text: AD_2, creator: 'Pivot', episode: 'y' },
  { text: REAL_1, creator: 'Odd Lots', episode: 'z' },
  { text: REAL_2, creator: 'The Compound and Friends', episode: 'w' },
  { text: REAL_3, creator: 'Forward Guidance', episode: 'v' },
];

(async () => {
  if (!process.env.OPENAI_API_KEY) { console.error('SKIP: OPENAI_API_KEY not set'); process.exit(2); }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log(`--- input: ${clips.length} clips (${ADS.length} ad reads, ${clips.length - ADS.length} substantive) ---`);
  const { clips: kept } = await rerankClips({ query: 'CoreWeave', clips, openai, minScore: 4 });

  const keptTexts = new Set(kept.map((c) => c.text));
  const adsKept = ADS.filter((a) => keptTexts.has(a));
  const realKept = [REAL_1, REAL_2, REAL_3].filter((r) => keptTexts.has(r));

  console.log(`kept ${kept.length}/${clips.length}`);
  kept.forEach((c) => console.log(`  • ${(c.text || '').slice(0, 60)}`));
  console.log(`\nads surviving: ${adsKept.length}/${ADS.length}  |  substantive surviving: ${realKept.length}/3`);

  const failures = [];
  if (adsKept.length > 0) failures.push(`${adsKept.length} ad read(s) were NOT dropped (reranker not filtering)`);
  if (realKept.length === 0) failures.push('all substantive clips were dropped (reranker too aggressive / broken)');

  if (failures.length) {
    console.error(`\nFAIL:\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  console.log('\nPASS: ad reads dropped, substantive clips kept.');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
