/**
 * Scenario matrix for the Tape eval harness (scripts/tape-eval.js).
 *
 * Only the three shipping kinds: readin, brief, split. Each row is EXACTLY the
 * body the frontend POSTs to /api/tape/<kind>. `expect` drives the deterministic
 * Layer-1 gate; `judge` notes steer the Sonnet rubric. `stability3x` flags the
 * ~6 representative rows the harness re-runs 3x for variance.
 *
 * Confidence bands are intentionally lenient on the happy path (synthesis is
 * non-deterministic; `partial` is an acceptable outcome). The bands exist to
 * catch the WRONG end of the scale — a junk ticker must be `empty`, a niche
 * topic must not claim `strong`.
 */

const TODAY = '2026-06-04';
const OLD = '2026-03-01'; // exercises the Brief 7->30->90 window auto-expand

const HAPPY = ['strong', 'partial'];
const HAPPY_OR_THIN = ['strong', 'partial', 'thin'];
const THIN = ['thin', 'partial', 'empty'];
const ANY = ['strong', 'partial', 'thin', 'empty'];
const EMPTY = ['empty'];

const scenarios = [
  // ----------------------------- READ-IN (~20) -----------------------------
  // Named equities — rich coverage expected.
  { id: 'ri_tsla', kind: 'readin', body: { ticker: 'TSLA' }, tags: ['happy'], expect: { confidence: HAPPY } },
  { id: 'ri_nvda', kind: 'readin', body: { ticker: 'NVDA' }, tags: ['happy', 'core'], expect: { confidence: HAPPY }, stability3x: true },
  { id: 'ri_app', kind: 'readin', body: { ticker: 'APP' }, tags: ['happy'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'ri_jpm', kind: 'readin', body: { ticker: 'JPM' }, tags: ['happy'], expect: { confidence: HAPPY } },
  { id: 'ri_hood', kind: 'readin', body: { ticker: 'HOOD' }, tags: ['happy'], expect: { confidence: HAPPY } },
  { id: 'ri_mstr', kind: 'readin', body: { ticker: 'MSTR' }, tags: ['happy', 'bitcoin-proxy'], expect: { confidence: HAPPY } },
  { id: 'ri_orcl', kind: 'readin', body: { ticker: 'ORCL' }, tags: ['happy'], expect: { confidence: HAPPY } },
  { id: 'ri_crwv', kind: 'readin', body: { ticker: 'CRWV' }, tags: ['happy', 'ad-read-prone'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'ri_glw', kind: 'readin', body: { ticker: 'GLW' }, tags: ['happy'], expect: { confidence: HAPPY_OR_THIN } },
  // Nuclear basket.
  { id: 'ri_ceg', kind: 'readin', body: { ticker: 'CEG' }, tags: ['happy', 'nuclear'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'ri_oklo', kind: 'readin', body: { ticker: 'OKLO' }, tags: ['happy', 'nuclear', 'hype'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'ri_smr', kind: 'readin', body: { ticker: 'SMR' }, tags: ['nuclear'], expect: { confidence: HAPPY_OR_THIN } },
  // Commodity proxies (per the "Brief + proxy Read-Ins" decision).
  { id: 'ri_ibit', kind: 'readin', body: { ticker: 'IBIT' }, tags: ['commodity-proxy', 'bitcoin'], expect: { confidence: ANY } },
  { id: 'ri_gld', kind: 'readin', body: { ticker: 'GLD' }, tags: ['commodity-proxy', 'gold'], expect: { confidence: ANY } },
  { id: 'ri_xom', kind: 'readin', body: { ticker: 'XOM' }, tags: ['commodity-proxy', 'oil'], expect: { confidence: HAPPY_OR_THIN } },
  // Boring retailers.
  { id: 'ri_wmt', kind: 'readin', body: { ticker: 'WMT' }, tags: ['happy', 'retail'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'ri_tgt', kind: 'readin', body: { ticker: 'TGT' }, tags: ['retail'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'ri_cost', kind: 'readin', body: { ticker: 'COST' }, tags: ['retail'], expect: { confidence: HAPPY_OR_THIN } },
  // Edge cases.
  { id: 'ri_junk', kind: 'readin', body: { ticker: 'ZXQW9' }, tags: ['edge', 'empty-expected'], expect: { confidence: EMPTY }, stability3x: true },
  { id: 'ri_ambig', kind: 'readin', body: { ticker: 'GOLD' }, tags: ['edge', 'ambiguous-slug'], expect: { confidence: ANY, noServerError: true } },

  // ------------------------------ BRIEF (~20) ------------------------------
  { id: 'br_fed', kind: 'brief', body: { topic: 'Fed rate plans', asOfDate: TODAY }, tags: ['happy', 'macro'], expect: { confidence: HAPPY }, stability3x: true },
  { id: 'br_hormuz', kind: 'brief', body: { topic: 'Strait of Hormuz resolution', asOfDate: TODAY }, tags: ['happy', 'geopolitics'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'br_energy', kind: 'brief', body: { topic: 'Energy sector outlook', asOfDate: TODAY }, tags: ['happy'], expect: { confidence: HAPPY } },
  { id: 'br_robotics', kind: 'brief', body: { topic: 'Robotics and automation', asOfDate: TODAY }, tags: ['happy', 'theme'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'br_space', kind: 'brief', body: { topic: 'Space technology', asOfDate: TODAY }, tags: ['theme'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'br_sports', kind: 'brief', body: { topic: 'Sports franchise valuations', asOfDate: TODAY }, tags: ['niche'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'br_shipping', kind: 'brief', body: { topic: 'Shipping companies and freight rates', asOfDate: TODAY }, tags: ['niche'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'br_aibuild', kind: 'brief', body: { topic: 'AI buildout and data center companies', asOfDate: TODAY }, tags: ['happy', 'theme'], expect: { confidence: HAPPY } },
  { id: 'br_chinatech', kind: 'brief', body: { topic: 'Chinese technology stocks', asOfDate: TODAY }, tags: ['happy'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'br_gold', kind: 'brief', body: { topic: 'Gold prices and safe havens', asOfDate: TODAY }, tags: ['happy', 'commodity'], expect: { confidence: HAPPY } },
  { id: 'br_bitcoin', kind: 'brief', body: { topic: 'Bitcoin', asOfDate: TODAY }, tags: ['happy', 'commodity'], expect: { confidence: HAPPY } },
  { id: 'br_oil', kind: 'brief', body: { topic: 'Oil prices', asOfDate: TODAY }, tags: ['happy', 'commodity'], expect: { confidence: HAPPY } },
  { id: 'br_banking', kind: 'brief', body: { topic: 'Banking sector outlook', asOfDate: TODAY }, tags: ['happy'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'br_biotech', kind: 'brief', body: { topic: 'Biotech sector', asOfDate: TODAY }, tags: ['theme'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'br_meddev', kind: 'brief', body: { topic: 'Medical devices industry', asOfDate: TODAY }, tags: ['niche'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'br_retail', kind: 'brief', body: { topic: 'Retailers and consumer spending', asOfDate: TODAY }, tags: ['happy'], expect: { confidence: HAPPY_OR_THIN } },
  // Window auto-expand (older asOfDate): record windowDays / windowExpanded.
  { id: 'br_fed_old', kind: 'brief', body: { topic: 'Fed rate plans', asOfDate: OLD }, tags: ['window-expand'], expect: { confidence: HAPPY_OR_THIN, recordWindow: true }, stability3x: true },
  { id: 'br_btc_old', kind: 'brief', body: { topic: 'Bitcoin', asOfDate: OLD }, tags: ['window-expand'], expect: { confidence: HAPPY_OR_THIN, recordWindow: true } },
  { id: 'br_hormuz_old', kind: 'brief', body: { topic: 'Strait of Hormuz resolution', asOfDate: OLD }, tags: ['window-expand'], expect: { confidence: ANY, recordWindow: true } },
  // Deliberately niche -> should NOT claim strong.
  { id: 'br_niche', kind: 'brief', body: { topic: 'uranium enrichment centrifuge supply chain', asOfDate: TODAY }, tags: ['edge', 'thin-expected'], expect: { confidence: THIN } },

  // ------------------------------ SPLIT (~12) ------------------------------
  // Camp (bulls/bears) — the topic-quotes groupBy:'bull-bear' code path.
  { id: 'sp_btc', kind: 'split', body: { personA: 'bulls', personB: 'bears', topic: 'Bitcoin' }, tags: ['camp', 'happy'], expect: { confidence: HAPPY_OR_THIN }, stability3x: true },
  { id: 'sp_aibubble', kind: 'split', body: { personA: 'bulls', personB: 'bears', topic: 'AI bubble' }, tags: ['camp', 'happy'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'sp_chinatech', kind: 'split', body: { personA: 'bulls', personB: 'bears', topic: 'Chinese technology stocks' }, tags: ['camp'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'sp_tsla', kind: 'split', body: { personA: 'bulls', personB: 'bears', topic: 'Tesla TSLA' }, tags: ['camp'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'sp_nuclear', kind: 'split', body: { personA: 'bulls', personB: 'bears', topic: 'nuclear energy stocks' }, tags: ['camp'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'sp_oil', kind: 'split', body: { personA: 'bulls', personB: 'bears', topic: 'oil prices' }, tags: ['camp'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'sp_gold', kind: 'split', body: { personA: 'bulls', personB: 'bears', topic: 'gold' }, tags: ['camp'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'sp_nvda', kind: 'split', body: { personA: 'bulls', personB: 'bears', topic: 'Nvidia NVDA AI chips' }, tags: ['camp'], expect: { confidence: HAPPY_OR_THIN } },
  // Named-people — the person-quotes code path (well-known opposers).
  { id: 'sp_elerian', kind: 'split', body: { personA: 'Mohamed El-Erian', personB: 'Larry Summers', topic: 'recession risk and Fed policy' }, tags: ['named', 'happy'], expect: { confidence: HAPPY_OR_THIN }, stability3x: true },
  { id: 'sp_saylor', kind: 'split', body: { personA: 'Michael Saylor', personB: 'Peter Schiff', topic: 'Bitcoin' }, tags: ['named'], expect: { confidence: HAPPY_OR_THIN } },
  { id: 'sp_ai_named', kind: 'split', body: { personA: 'Cathie Wood', personB: 'Jim Chanos', topic: 'AI and tech valuations' }, tags: ['named'], expect: { confidence: HAPPY_OR_THIN } },
  // Asymmetric edge — one side likely thin.
  { id: 'sp_asym', kind: 'split', body: { personA: 'bulls', personB: 'bears', topic: 'micro-cap space launch startups' }, tags: ['edge', 'asymmetric'], expect: { confidence: THIN } },
];

module.exports = { scenarios, TODAY, OLD };
