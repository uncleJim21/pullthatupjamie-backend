#!/usr/bin/env node
/**
 * Contract suite for the Tape `narrative` kind (synthesize marker contract).
 *
 *   node tests/tape-narrative-compliance.test.js
 *
 * No mocha/jest dependency — pure node assertions. Exercises the server-side
 * guardrails directly (validateKindCompliance / hasRequiredMarkers / the prompt
 * builders) so the marker + signed-sentiment contract is locked without needing
 * a live LLM or network.
 *
 * A non-zero exit code indicates at least one scenario failed.
 */

const {
  VALID_KINDS, validateKindCompliance, hasRequiredMarkers,
  systemPromptFor, buildUserMessage, PROMPT_VERSION,
} = require('../services/tape/tapePrompts');
const { resolveHalfLife } = require('../services/tape/recency');

let passed = 0;
let failed = 0;
const failures = [];
function check(cond, message) {
  if (cond) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; failures.push(message); console.log(`  ✗ ${message}`); }
}

// A well-formed narrative: THESIS + 3 chronological buckets w/ signed sentiment,
// a sign-flip reversal across zero, plus optional INFLECTION + FORWARD.
const VALID_NARRATIVE = `## THESIS: The market has swung from pricing aggressive 2026 rate cuts to doubting any at all.

## BUCKET | 2024-01-01 | 2024-06-30 | 4
Through H1 2024 the prevailing voices were convinced multiple cuts were coming.
{{clip:abc123}}
{{clip:def456}}

## BUCKET | 2024-07-01 | 2024-12-31 | 1
By late 2024 conviction softened to a hedged "maybe one or two."
{{clip:ghi789}}

## BUCKET | 2025-01-01 | 2025-12-31 | -3
Sticky inflation flipped the consensus: most now argue cuts are off the table.
{{clip:jkl012}}

## INFLECTION
- 2025-Q1: Hot CPI prints broke the rate-cut consensus.

## FORWARD: The debate is drifting toward "higher for longer" as the base case.`;

console.log('\nRegistry');
check(VALID_KINDS.includes('narrative'), `narrative is a valid kind (VALID_KINDS = ${VALID_KINDS.join(', ')})`);
check(PROMPT_VERSION !== 'v4', `PROMPT_VERSION bumped past v4 (got ${PROMPT_VERSION})`);

console.log('\nValid narrative');
const ok = validateKindCompliance('narrative', VALID_NARRATIVE);
check(ok.ok === true, `well-formed narrative passes compliance (reason: ${ok.reason})`);
check(hasRequiredMarkers('narrative', VALID_NARRATIVE) === true, 'well-formed narrative has required markers');

console.log('\nRequired-marker failures (→ retry → 502)');
const noThesis = VALID_NARRATIVE.replace(/## THESIS:.*\n/, '');
check(!validateKindCompliance('narrative', noThesis).ok, 'missing ## THESIS fails');

const twoBuckets = `## THESIS: x
## BUCKET | 2024-01-01 | 2024-06-30 | 3
s
{{clip:a}}
## BUCKET | 2024-07-01 | 2024-12-31 | 2
s
{{clip:b}}`;
check(!validateKindCompliance('narrative', twoBuckets).ok, 'fewer than 3 buckets fails');

console.log('\nSentiment validation (the load-bearing field)');
const missingSentiment = `## THESIS: x
## BUCKET | 2024-01-01 | 2024-06-30
s
{{clip:a}}
## BUCKET | 2024-07-01 | 2024-12-31 | 2
s
{{clip:b}}
## BUCKET | 2025-01-01 | 2025-12-31 | -1
s
{{clip:c}}`;
check(!validateKindCompliance('narrative', missingSentiment).ok, 'a bucket missing its sentiment field fails');

const outOfRange = VALID_NARRATIVE.replace('| 4\n', '| 7\n');
check(!validateKindCompliance('narrative', outOfRange).ok, 'sentiment out of -5..+5 range (7) fails');

const nonInteger = VALID_NARRATIVE.replace('| 4\n', '| 3.5\n');
check(!validateKindCompliance('narrative', nonInteger).ok, 'non-integer sentiment (3.5) fails');

const negativeAndZeroOk = `## THESIS: x
## BUCKET | 2024-01-01 | 2024-06-30 | -5
s
{{clip:a}}
## BUCKET | 2024-07-01 | 2024-12-31 | 0
s
{{clip:b}}
## BUCKET | 2025-01-01 | 2025-12-31 | +5
s
{{clip:c}}`;
check(validateKindCompliance('narrative', negativeAndZeroOk).ok, 'signed/zero/plus-prefixed integers (-5, 0, +5) all parse');

console.log('\nCross-kind bleed');
const leakVerdict = VALID_NARRATIVE.replace('## FORWARD:', '## VERDICT: rising\n## FORWARD:');
const lv = validateKindCompliance('narrative', leakVerdict);
check(!lv.ok && lv.leaked.includes('## VERDICT:'), 'arc\'s ## VERDICT: leaking into narrative fails');

const leakCall = `${VALID_NARRATIVE}\n## CALL | 2025-01-01 | x | 5 |`;
check(!validateKindCompliance('narrative', leakCall).ok, 'arc\'s ## CALL leaking into narrative fails');

const leakPublisher = VALID_NARRATIVE.replace('## INFLECTION', '## PUBLISHER: CNBC\n## INFLECTION');
check(!validateKindCompliance('narrative', leakPublisher).ok, 'brief\'s ## PUBLISHER leaking into narrative fails');

console.log('\nNarrative markers must not leak into OTHER kinds');
const arcWithBucket = `## THESIS: x
## VERDICT: y
## CALL | 2024-01-01 | a | 3 |
{{clip:a}}
## CALL | 2024-06-01 | b | 4 |
{{clip:b}}
## CALL | 2024-12-01 | c | 5 |
{{clip:c}}
## BUCKET | 2024-01-01 | 2024-12-31 | 3
leaked`;
const arcLeak = validateKindCompliance('arc', arcWithBucket);
check(!arcLeak.ok && arcLeak.leaked.includes('## BUCKET |'), 'narrative\'s ## BUCKET | leaking into arc fails');

console.log('\nPrompt construction');
const sys = systemPromptFor('narrative');
check(typeof sys === 'string' && sys.includes('## BUCKET |') && sys.includes('SENTIMENT RUBRIC'),
  'systemPromptFor(narrative) includes the bucket contract + sentiment rubric');
check(sys.includes('## TICKERS'), 'narrative system prompt still appends the ## TICKERS block');

const userMsg = buildUserMessage({
  kind: 'narrative',
  input: { topic: 'the AI bubble', group: 'bears' },
  candidates: [{ pineconeId: 'abc123', text: 'hi', creator: 'X', publishedDate: '2024-01-01' }],
});
check(userMsg.includes('GROUP: bears'), 'buildUserMessage surfaces the GROUP filter');
check(userMsg.includes('TOPIC: the AI bubble'), 'buildUserMessage surfaces the TOPIC');

console.log('\nRecency weighting bypass (spec §3.2)');
check(resolveHalfLife({ kind: 'narrative' }).disabled === true, 'narrative kind disables recency weighting by default');
check(resolveHalfLife({ kind: 'narrative', disableRecencyWeighting: true }).disabled === true, 'explicit disableRecencyWeighting also disables');

// --- Report ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('All narrative kind-contract checks passed.');
