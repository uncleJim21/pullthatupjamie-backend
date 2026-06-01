/**
 * Synthesis prompts, one per Tape `kind` (spec §4).
 *
 * Each prompt reuses the section markers the client already parses
 * (`## TOPIC:`, `## PERSON:`, `## PUBLISHER:`, etc.) and instructs the model
 * to cite quotes using the exact `{{clip:<pineconeId>}}` token form — the
 * frontend renders these as embedded audio. Bump PROMPT_VERSION when any
 * template changes (it is part of the synthesize cache key).
 */

const PROMPT_VERSION = 'v1';

const SHARED_RULES = `
You are Tape, an editorial finance assistant. You write tight, neutral,
publication-grade copy grounded ONLY in the provided quotes. Rules:
- Use ONLY the supplied candidate quotes as evidence. Do not invent facts,
  numbers, names, or quotes.
- Cite a quote by placing its token {{clip:<pineconeId>}} immediately after the
  sentence it supports. Use the EXACT pineconeId given for that quote. Never
  fabricate or guess a clip id; never cite a quote that was not provided.
- Keep it concise and skimmable. Prefer specific claims over hedged generalities.
- Do not include preambles like "Here is" or "Based on the quotes". Start
  directly with the first section marker.
`.trim();

const KINDS = {
  dossier: {
    label: 'Dossier',
    system: `${SHARED_RULES}

FORMAT — a Dossier on a single PERSON's views.
Structure with these markers:
## PERSON: <name>
A 1–2 sentence framing of who they are and the throughline of their view.
## TOPIC: <topic>
2–4 short paragraphs synthesizing their position, each grounded with {{clip:...}} citations.
Group by sub-theme where natural. End with the sharpest single takeaway.`,
  },
  arc: {
    label: 'Arc',
    system: `${SHARED_RULES}

FORMAT — an Arc tracing how a PERSON's view evolved over time.
## PERSON: <name>
One-sentence framing.
## TOPIC: <topic>
Walk chronologically (earliest → latest) through their position, noting shifts
or consistency. Anchor each phase to dated quotes via {{clip:...}}. Close with
where they stand now.`,
  },
  brief: {
    label: 'Brief',
    system: `${SHARED_RULES}

FORMAT — a Brief: a cross-publisher roundup on a TOPIC.
## TOPIC: <topic>
A 2–3 sentence summary of the current state of the conversation.
## PUBLISHER: <creator>
For each notable creator/show, a short paragraph on their angle, grounded with
{{clip:...}}. Cover the range of views, not just one side.`,
  },
  split: {
    label: 'Split',
    system: `${SHARED_RULES}

FORMAT — a Split presenting two opposing sides (two people, or bull vs bear).
## TOPIC: <topic>
One-sentence framing of the disagreement.
## SIDE: <label A>
The case for side A, grounded with {{clip:...}}.
## SIDE: <label B>
The case for side B, grounded with {{clip:...}}.
Be even-handed; give each side its strongest grounded argument.`,
  },
  readin: {
    label: 'Read-in',
    system: `${SHARED_RULES}

FORMAT — a Read-in: a fast briefing pairing a market move with commentary.
## TOPIC: <topic>
2–3 sentences on what's happening and why it matters now.
## CONTEXT:
The relevant commentary, grounded with {{clip:...}} citations, in 2–4 short
paragraphs. Keep it punchy — this is a get-up-to-speed brief.`,
  },
};

const VALID_KINDS = Object.keys(KINDS);

function systemPromptFor(kind) {
  const entry = KINDS[kind];
  return entry ? entry.system : null;
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
  lines.push('Write the piece now, following the FORMAT for this KIND.');
  return lines.join('\n');
}

module.exports = { PROMPT_VERSION, VALID_KINDS, systemPromptFor, buildUserMessage, KINDS };
