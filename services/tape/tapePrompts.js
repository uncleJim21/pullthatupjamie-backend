/**
 * Synthesis prompts, one per Tape `kind` (spec §4).
 *
 * Each kind emits a STRICT marker contract that the client parser splits on.
 * The contracts are defined per the frontend's typed shape — see the
 * "conform synthesize prompts to the client contract" ask. The client will not
 * loosen its parser, so the model must emit ONLY the listed markers, in order,
 * with exact names and literal punctuation (`|`, `:`).
 *
 * Optional sections are OMITTED entirely when candidates don't support them
 * (never an empty header). When even the REQUIRED sections can't be produced,
 * the model emits the EMPTY_SENTINEL and synthesize.js returns empty text with
 * `_meta.synthesizedEmpty`.
 *
 * Bump PROMPT_VERSION on any change (it is part of the synthesize cache key).
 */

// v4: appended the `## TICKERS` relevance block to every kind (parsed off into
// the structured `tickers` field — see synthesize.js). Invalidates v3 caches.
// v5: added the `narrative` kind (## THESIS + ## BUCKET | with signed sentiment +
// optional ## INFLECTION/## FORWARD). Invalidates v4 caches.
// v6: narrative adaptive cadence — variable-width buckets by density, floor
// relaxed from 3 to 1 bucket. Invalidates v5 caches.
// v8: stance gate — candidates may carry a {stance: bull/bear/neutral} hint;
// readin BEAR slot + split PERSON sides must be stance-correct and quotes must
// not be reused across split sides. Invalidates v7 caches.
// v9: retrieval — adjacent-paragraph context stitching on truncated clips, source-
// diversity cap, min-word fragment drop, looser literal-anchor for multi-word
// topics. Synthesis sees fuller passages, so output changes. Invalidates v8 caches.
// v10: company-card grounding — authoritative name/industry/description/products/
// execs injected as the COMPANY reference (fixes wrong-entity primers, e.g. CEG).
const PROMPT_VERSION = 'v10';

const EMPTY_SENTINEL = 'EMPTY_SYNTHESIS';

// Marker the model appends; synthesize.js parses it off and strips it from text.
const TICKERS_MARKER = 'TICKERS';

// Per-kind definition of "relevant tickers" (baked into the prompt).
const TICKER_GUIDANCE = {
  dossier: 'Tickers this person is on record about — names they are known for covering, plus anything heavily represented in the supplied candidates. Skip names merely mentioned in passing. (El-Erian → ^TNX, DX-Y.NYB, GLD; Cathie Wood → TSLA, COIN, PATH, RBLX.)',
  brief: 'Tickers most exposed to the story being briefed. For commodity/macro stories include the underlying (CL=F, GLD, ^TNX); for company/sector stories the obvious operators. (Hormuz oil → CL=F, XOM, CVX, OXY, SLB, ^TNX; AI bubble → NVDA, MSFT, GOOGL, META, AMZN, AVGO.)',
  split: 'What is at stake in the debate — reflect the TOPIC, not the side names. Include peer context. (bulls vs bears on AAPL → AAPL, MSFT, GOOGL; dollar debate → DX-Y.NYB, ^TNX, GLD, BTC-USD.)',
  arc: 'Names referenced IN THE TRACKED THESIS — bias toward the thesis, not the person\'s full beat. (Gromen debt-spiral → GLD, ^TNX, DX-Y.NYB, BTC-USD; Druckenmiller AI capex → NVDA, MSFT, META.)',
  readin: 'The queried company\'s SECTOR PEERS, not the company itself (the client already has the primary ticker). 4-6 peers a finance pro would actually triangulate with — match the company\'s real industry, do NOT default to mega-cap tech unless that IS the sector. (AAPL → MSFT, GOOGL, META, AMZN, NVDA; CRWV → NVDA, ORCL, MSFT, GOOGL; APP/AppLovin → TTD, U, RBLX, META, GOOGL [adtech/gaming]; XOM → CVX, OXY, SLB, COP [energy].) If the queried ticker is not a real listed equity, output no symbols.',
  narrative: 'Names most exposed to the TOPIC of the narrative, NOT the group filter — pick the same tickers whether the lens is bulls, bears, or a named person. (AI capex narrative → NVDA, MSFT, GOOGL, META, AMZN, AVGO regardless of bull/bear; sovereign debt endgame → GLD, ^TNX, DX-Y.NYB, BTC-USD; rate cuts in 2026 → ^TNX, TLT, GLD, DX-Y.NYB.)',
};

function tickersBlock(kind) {
  return `After all content sections, ALWAYS end with this block:
## ${TICKERS_MARKER}
- <SYMBOL>
- <SYMBOL>

Ticker rules:
- 4-8 real, currently-listed symbols in RELEVANCE order, highest first.
- Use the form a user types into Yahoo Finance: US listings preferred; \`^TNX\`
  for the 10-year, \`DX-Y.NYB\` for the dollar index, \`CL=F\` for crude,
  \`BTC-USD\`, \`GLD\`, \`TM\` (not 7203.T), \`BRK-B\`.
- Do NOT fabricate. If the topic is not about specific names, emit the
  \`## ${TICKERS_MARKER}\` header with NO symbols beneath it.
- This block is parsed off by the backend and NOT shown to the user.
- Relevance for this kind: ${TICKER_GUIDANCE[kind]}`;
}

// --- per-kind marker contract blocks (pasted verbatim into the prompt) ---

const CONTRACTS = {
  readin: `## WHAT_THEY_DO
<2-3 paragraph plain-English primer on the company, BUILT FROM THE SUPPLIED
QUOTES (not general knowledge). REQUIRED. Cite the specific quotes you draw on
inline with {{clip:<id>}} — at least 2 across the primer.>

## PULSE | BULL: <one-sentence bull case> | BEAR: <one-sentence bear case>
{{clip:<id>}}   # the single strongest marquee quote. OPTIONAL — but if you emit
                # this header you MUST put a {{clip:<id>}} under it.

## SMART_MONEY: BULL
{{clip:<id>}}
{{clip:<id>}}   # OPTIONAL — omit the header entirely if you have no bull quotes
                # to cite. NEVER emit this header with no {{clip:<id>}} beneath it.

## SMART_MONEY: BEAR
{{clip:<id>}}   # OPTIONAL. Only GENUINELY BEARISH quotes (the speaker argues the
                # stock is overvalued / faces downside / structural risk). A clip
                # marked {stance: bull} or {stance: neutral} is NOT a bear quote —
                # do not place it here. If NO candidate is actually bearish, OMIT
                # this header AND the "BEAR:" half of the PULSE line. Never empty.

## RISKS
- <one-line risk>
- <one-line risk>   # OPTIONAL section.`,

  brief: `# HEADLINE: <one-sentence newsroom-style takeaway>   # REQUIRED.

## PUBLISHER: <show name>
<2-3 sentence summary of what this publisher said>
{{clip:<id>}}
{{clip:<id>}}

## PUBLISHER: <next show>
...   # at least one PUBLISHER block REQUIRED; group candidates by their creator.`,

  dossier: `## TOPIC: <topic name>
<2-3 sentence stance summary>
{{clip:<id>}}

## TOPIC: <next>
...   # one or more TOPIC blocks REQUIRED.

## APPEARANCES
- <show> | <episode title> | <YYYY-MM-DD>   # OPTIONAL (client backfills from appearances).`,

  split: `## PERSON: <name A>
<2-3 sentence stance summary — state ONLY the position the cited quotes support>
{{clip:<id>}}

## PERSON: <name B>
<2-3 sentence stance summary — must be the OPPOSING side of the debate>
{{clip:<id>}}   # both PERSON blocks REQUIRED.

## CONTRAST
<1-2 sentence contrast>   # OPTIONAL but encouraged.

# CITATION RULES (strict):
# - Each PERSON's quotes must support THAT person's/camp's stance. When a clip is
#   tagged {stance: bull/bear}, put it only under the side whose view it matches.
# - NEVER cite the same {{clip:<id>}} under both PERSON blocks. A quote belongs to
#   exactly one side.
# - Do not assert a position a cited quote does not actually make. If one side has
#   no genuinely supporting quote, write only what its quotes support (the backend
#   will mark the result one-sided) — do NOT manufacture a symmetric opposing view.`,

  arc: `## THESIS: <one-line summary of the thesis being tracked>   # REQUIRED.
## VERDICT: <one-line verdict, e.g. "Conviction rising — calls landing">   # REQUIRED.
## CALL | <ISO date> | <short label> | <conviction 1-5> | <optional outcome>
{{clip:<id>}}
## CALL | <ISO date> | <short label> | <conviction 1-5> |
{{clip:<id>}}
# at least 3 CALL entries REQUIRED; each MUST be followed by a {{clip:<id>}} line.
## FORWARD: <one-line forward prediction>   # OPTIONAL.`,

  narrative: `## THESIS: <one-sentence current consensus / the group's current view>   # REQUIRED.

## BUCKET | <ISO start date> | <ISO end date> | <signed sentiment -5..+5>
<2-3 sentence stance summary for this window>
{{clip:<id>}}
{{clip:<id>}}

## BUCKET | <ISO start date> | <ISO end date> | <signed sentiment -5..+5>
<2-3 sentence stance summary for this window>
{{clip:<id>}}
# ADAPTIVE CADENCE: choose 3-8 bucket boundaries that follow the RHYTHM of the
# conversation — NARROWER windows where coverage is dense, WIDER where it is
# sparse. Do NOT force uniform widths (no fixed monthly/quarterly/yearly rule);
# variable widths are correct output. Each bucket needs >= 2 candidates. If the
# data only supports fewer, emit fewer — at least 1 bucket. Chronological,
# non-overlapping, oldest→newest. Each bucket carries 1-4 {{clip:<id>}}
# citations. Sentiment is the THIRD pipe-delimited field, REQUIRED on EVERY
# bucket: an integer -5..+5.

## INFLECTION
- <YYYY-Qn OR ISO date>: <one-sentence what changed and, briefly, why>
- <...>   # OPTIONAL — omit the whole section (header included) if the candidates don't confidently support it.

## FORWARD: <one-line where this trajectory is heading>   # OPTIONAL — omit if unsupported.

SENTIMENT RUBRIC (the third ## BUCKET field — signed conviction on the THESIS):
- SIGN = direction. Positive = the prevailing voices in the window SUPPORTED /
  advanced the thesis; negative = they CONTRADICTED / pushed back; 0 = mixed,
  ambivalent, or genuinely neutral.
- A sign-flip across zero between adjacent buckets is a REVERSAL — do NOT smooth
  it out; if the data reversed, let the numbers reverse.
- MAGNITUDE (1-5) = how forcefully the position was stated:
  5 absolute, no hedging ("definitely", "guaranteed", "the only outcome");
  4 strong ("I'm convinced", "the data is unambiguous");
  3 confident but caveated ("I think", "probably", "the best read is");
  2 soft ("could", "might", "leaning toward");
  1 highly hedged ("possibly", "one scenario is", "not impossible").
- If the GROUP is a NAMED PERSON: sentiment = THAT person's conviction strength
  on the thesis; sign reflects whether they support (usually +) or oppose it.
- If the GROUP is bulls / bears / all: sentiment = the aggregate direction ×
  confidence of that group's quotes in the window (capitulation can flip it
  negative).`,
};

const LABELS = {
  readin: 'Read-in', brief: 'Brief', dossier: 'Dossier', split: 'Split', arc: 'Arc',
  narrative: 'Narrative',
};

function systemPromptFor(kind) {
  const contract = CONTRACTS[kind];
  if (!contract) return null;
  return `You are Tape, an editorial finance assistant producing a structured \`${kind}\`
(${LABELS[kind]}) result for the Tape UI. Your output is parsed by a STRICT
client-side parser that splits the response on exact marker lines.

Follow the marker contract below VERBATIM:
- Use ONLY these markers, in this order, with these EXACT names and literal
  punctuation (\`|\`, \`:\`). The marker name is case-insensitive but the
  structure is literal.
- Do NOT use markers from other Tape result types (e.g. ## TOPIC, ## CONTEXT,
  ## PUBLISHER) unless they appear in the contract below.
- Ground every claim ONLY in the supplied candidate quotes. Do not invent facts,
  numbers, names, or quotes.
- Every {{clip:<id>}} token MUST reference a pineconeId from the candidate pool
  in the user message. Never invent ids; never cite an id not in the pool. Put a
  citation on its own line where the contract shows one.
- OPTIONAL sections: if the candidate pool does not confidently support a section
  marked OPTIONAL, OMIT that section entirely (header AND body). Returning less is
  better than empty scaffolding.
- Output no preamble, explanation, or text outside the markers. Start directly
  with the first marker.

If the candidates are too sparse or off-topic to produce even the REQUIRED
sections, output EXACTLY this line and nothing else:
${EMPTY_SENTINEL}

MARKER CONTRACT for \`${kind}\`:
${contract}

${tickersBlock(kind)}`;
}

const VALID_KINDS = Object.keys(CONTRACTS);

// Required-marker validators (case-insensitive on the marker name). Used as a
// server-side guardrail: if the model failed to emit the required shape, we
// return synthesizedEmpty rather than letting malformed markers reach the UI.
function countMatches(text, re) { return (text.match(re) || []).length; }

// Narrative buckets: every `## BUCKET | start | end | sentiment` line MUST carry
// a parseable signed integer in the THIRD pipe slot, range -5..+5. A missing or
// malformed sentiment is a compliance failure (→ one auto-retry → 502), since
// the trajectory chart on the client is driven entirely off these values.
function narrativeBucketsValid(text) {
  const lines = text.match(/^##\s*BUCKET\s*\|.*$/gim) || [];
  // Adaptive cadence: bucket count follows data density, so the floor is >= 1
  // (was 3). Every bucket present must still carry a valid signed-sentiment field.
  if (lines.length < 1) return false;
  return lines.every((line) => {
    const parts = line.split('|'); // [ "## BUCKET ", start, end, sentiment ]
    if (parts.length < 4) return false;
    const raw = parts[3].trim();
    if (!/^[+-]?\d+$/.test(raw)) return false;
    const n = parseInt(raw, 10);
    return n >= -5 && n <= 5;
  });
}

function hasRequiredMarkers(kind, text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  switch (kind) {
    case 'readin':
      return /^##\s*WHAT_THEY_DO\b/im.test(text);
    case 'brief':
      return /^#\s*HEADLINE\s*:/im.test(text) && /^##\s*PUBLISHER\s*:/im.test(text);
    case 'dossier':
      return /^##\s*TOPIC\s*:/im.test(text);
    case 'split':
      return countMatches(text, /^##\s*PERSON\s*:/gim) >= 2;
    case 'arc':
      return /^##\s*THESIS\s*:/im.test(text)
        && /^##\s*VERDICT\s*:/im.test(text)
        && countMatches(text, /^##\s*CALL\b/gim) >= 3;
    case 'narrative':
      return /^##\s*THESIS\s*:/im.test(text)
        && narrativeBucketsValid(text);
    default:
      return false;
  }
}

// Markers that must NOT appear in a given kind (cross-kind bleed). Matched as
// case-insensitive substrings. Each kind's own legitimate markers are excluded.
// Note: brief's headline is a single-# `# HEADLINE`, so the forbidden token uses
// one # to actually catch it leaking into other kinds.
const FORBIDDEN_CROSS_KIND = {
  readin: ['## PUBLISHER', '## TOPIC:', '## THESIS', '## PERSON:', '# HEADLINE', '## BUCKET |'],
  brief: ['## WHAT_THEY_DO', '## PULSE |', '## SMART_MONEY', '## THESIS', '## PERSON:', '## BUCKET |'],
  dossier: ['## WHAT_THEY_DO', '## PULSE |', '# HEADLINE', '## PUBLISHER', '## THESIS', '## PERSON:', '## BUCKET |'],
  split: ['## WHAT_THEY_DO', '## PULSE |', '# HEADLINE', '## TOPIC:', '## BUCKET |'],
  arc: ['## WHAT_THEY_DO', '## PULSE |', '# HEADLINE', '## PUBLISHER', '## PERSON:', '## BUCKET |'],
  // narrative shares `## THESIS:` (and optional `## FORWARD:`) with arc, so those
  // are NOT forbidden; everything else from other kinds — including arc's own
  // `## VERDICT:`/`## CALL` — is, to keep the two time-series kinds distinct.
  narrative: ['## WHAT_THEY_DO', '## PULSE |', '# HEADLINE', '## PUBLISHER', '## TOPIC:', '## PERSON:', '## VERDICT:', '## CALL'],
};

/**
 * Validate a synthesis response against the requested kind's marker contract:
 * all REQUIRED markers present AND no FORBIDDEN cross-kind markers leaked.
 *
 * @returns {{ ok:boolean, reason:string|null, missing:boolean, leaked:string[] }}
 */
function validateKindCompliance(kind, text) {
  const t = typeof text === 'string' ? text : '';
  if (!hasRequiredMarkers(kind, t)) {
    return { ok: false, reason: `missing required ${kind} markers`, missing: true, leaked: [] };
  }
  const lower = t.toLowerCase();
  const leaked = (FORBIDDEN_CROSS_KIND[kind] || []).filter((m) => lower.includes(m.toLowerCase()));
  if (leaked.length) {
    return { ok: false, reason: `cross-kind markers leaked into ${kind}: ${leaked.join(', ')}`, missing: false, leaked };
  }
  return { ok: true, reason: null, missing: false, leaked: [] };
}

/** Build the user message: the input framing + the candidate evidence list. */
function buildUserMessage({ kind, input = {}, candidates = [], companyHint = null }) {
  const lines = [];
  lines.push(`KIND: ${kind}`);
  if (input.person) lines.push(`PERSON: ${input.person}`);
  if (input.personB) lines.push(`PERSON B: ${input.personB}`);
  if (input.topic) lines.push(`TOPIC: ${input.topic}`);
  if (input.group) lines.push(`GROUP / LENS: ${input.group} (apply the sentiment rubric to this group's view)`);
  if (input.ticker) lines.push(`TICKER: ${input.ticker}`);
  // Narrative group filter ('bulls' | 'bears' | 'all' | a named person) — drives
  // which sentiment lens the model applies (see the narrative SENTIMENT RUBRIC).
  if (input.group) lines.push(`GROUP: ${input.group}`);
  // Resolved company identity for a ticker the user typed (e.g. "APP" =
  // AppLovin) — lets the model pick sector-correct peer tickers.
  if (companyHint) lines.push(`COMPANY (authoritative reference — ground the company's identity/primer on THIS, not on inference from the clips; also use it to pick sector-appropriate peers): ${companyHint}`);
  lines.push('');
  lines.push('CANDIDATE QUOTES (cite by pineconeId):');
  candidates.forEach((c, i) => {
    const who = c.creator ? ` — ${c.creator}` : '';
    const ep = c.episodeTitle ? ` (${c.episodeTitle})` : '';
    const date = c.publishedDate ? ` [${String(c.publishedDate).slice(0, 10)}]` : '';
    // Optional pre-computed stance (bull/bear/neutral) from the stance gate —
    // helps the model sort quotes into the correct bull/bear slot or camp side.
    const stance = c._stance ? ` {stance: ${c._stance}}` : '';
    lines.push(`${i + 1}. pineconeId=${c.pineconeId}${who}${ep}${date}${stance}`);
    lines.push(`   "${(c.text || '').replace(/\s+/g, ' ').trim()}"`);
  });
  lines.push('');
  lines.push('Produce the result now, following the MARKER CONTRACT for this KIND exactly.');
  return lines.join('\n');
}

module.exports = {
  PROMPT_VERSION, EMPTY_SENTINEL, TICKERS_MARKER, VALID_KINDS,
  systemPromptFor, buildUserMessage, hasRequiredMarkers, validateKindCompliance,
  FORBIDDEN_CROSS_KIND, CONTRACTS,
};
