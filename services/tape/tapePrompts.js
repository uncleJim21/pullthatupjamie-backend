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

// v3: rewrote every per-kind contract to the strict client marker shapes
// (readin WHAT_THEY_DO/PULSE/SMART_MONEY/RISKS, brief HEADLINE/PUBLISHER, arc
// THESIS/VERDICT/CALL, etc.) + empty-sentinel handling. Invalidates v2 caches.
const PROMPT_VERSION = 'v3';

const EMPTY_SENTINEL = 'EMPTY_SYNTHESIS';

// --- per-kind marker contract blocks (pasted verbatim into the prompt) ---

const CONTRACTS = {
  readin: `## WHAT_THEY_DO
<2-3 paragraph plain-English primer on the company. REQUIRED.>

## PULSE | BULL: <one-sentence bull case> | BEAR: <one-sentence bear case>
{{clip:<id>}}   # the single strongest marquee quote. OPTIONAL section.

## SMART_MONEY: BULL
{{clip:<id>}}
{{clip:<id>}}   # OPTIONAL section.

## SMART_MONEY: BEAR
{{clip:<id>}}   # OPTIONAL section.

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
<2-3 sentence stance summary>
{{clip:<id>}}

## PERSON: <name B>
<2-3 sentence stance summary>
{{clip:<id>}}   # both PERSON blocks REQUIRED.

## CONTRAST
<1-2 sentence contrast>   # OPTIONAL but encouraged.`,

  arc: `## THESIS: <one-line summary of the thesis being tracked>   # REQUIRED.
## VERDICT: <one-line verdict, e.g. "Conviction rising — calls landing">   # REQUIRED.
## CALL | <ISO date> | <short label> | <conviction 1-5> | <optional outcome>
{{clip:<id>}}
## CALL | <ISO date> | <short label> | <conviction 1-5> |
{{clip:<id>}}
# at least 3 CALL entries REQUIRED; each MUST be followed by a {{clip:<id>}} line.
## FORWARD: <one-line forward prediction>   # OPTIONAL.`,
};

const LABELS = {
  readin: 'Read-in', brief: 'Brief', dossier: 'Dossier', split: 'Split', arc: 'Arc',
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
${contract}`;
}

const VALID_KINDS = Object.keys(CONTRACTS);

// Required-marker validators (case-insensitive on the marker name). Used as a
// server-side guardrail: if the model failed to emit the required shape, we
// return synthesizedEmpty rather than letting malformed markers reach the UI.
function countMatches(text, re) { return (text.match(re) || []).length; }

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
    default:
      return false;
  }
}

/** Build the user message: the input framing + the candidate evidence list. */
function buildUserMessage({ kind, input = {}, candidates = [] }) {
  const lines = [];
  lines.push(`KIND: ${kind}`);
  if (input.person) lines.push(`PERSON: ${input.person}`);
  if (input.personB) lines.push(`PERSON B: ${input.personB}`);
  if (input.topic) lines.push(`TOPIC: ${input.topic}`);
  if (input.ticker) lines.push(`TICKER: ${input.ticker}`);
  lines.push('');
  lines.push('CANDIDATE QUOTES (cite by pineconeId):');
  candidates.forEach((c, i) => {
    const who = c.creator ? ` — ${c.creator}` : '';
    const ep = c.episodeTitle ? ` (${c.episodeTitle})` : '';
    const date = c.publishedDate ? ` [${String(c.publishedDate).slice(0, 10)}]` : '';
    lines.push(`${i + 1}. pineconeId=${c.pineconeId}${who}${ep}${date}`);
    lines.push(`   "${(c.text || '').replace(/\s+/g, ' ').trim()}"`);
  });
  lines.push('');
  lines.push('Produce the result now, following the MARKER CONTRACT for this KIND exactly.');
  return lines.join('\n');
}

module.exports = {
  PROMPT_VERSION, EMPTY_SENTINEL, VALID_KINDS,
  systemPromptFor, buildUserMessage, hasRequiredMarkers, CONTRACTS,
};
