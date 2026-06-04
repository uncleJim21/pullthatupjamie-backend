/**
 * Server-side marker parsing + citation hydration for the kind-level endpoints.
 *
 * Turns the raw `synthesize` marker text (## TOPIC / ## PUBLISHER / ## BUCKET /
 * etc. with {{clip:id}} tokens) into the typed Result sub-shapes the client
 * renders directly — so the per-kind marker parsers move OFF the client.
 *
 * A "citation" is the already-hydrated candidate object (pineconeId, text,
 * episodeTitle, creator, episodeImage, audioUrl, startTime, endTime,
 * publishedDate) — resolved by looking the clip id up in the candidate pool, so
 * no get-hierarchy round trip is needed.
 */

const CLIP_RE = /\{\{clip:([^}]+)\}\}/g;

/** Ordered list of marker blocks: { marker, payload, body }. */
function splitBlocks(text) {
  const headRe = /^(#{1,3})[ \t]*([A-Za-z_]+)([^\n]*)$/gm;
  const heads = [];
  let m;
  while ((m = headRe.exec(text || ''))) {
    heads.push({ idx: m.index, end: m.index + m[0].length, marker: m[2].toUpperCase(), payload: m[3].trim() });
  }
  return heads.map((h, i) => ({
    marker: h.marker,
    payload: h.payload.replace(/^[:|]\s*/, ''), // drop a leading ":" / "|"
    rawPayload: h.payload,
    body: (text.slice(h.end, i + 1 < heads.length ? heads[i + 1].idx : text.length)).trim(),
  }));
}

function clipIdsIn(text) {
  return [...String(text || '').matchAll(CLIP_RE)].map((mm) => mm[1].trim()).filter(Boolean);
}

/** clip ids → ordered, deduped citation objects present in the pool. */
function hydrate(text, poolMap) {
  const seen = new Set();
  const out = [];
  for (const id of clipIdsIn(text)) {
    if (seen.has(id)) continue;
    const cand = poolMap.get(id);
    if (cand) { seen.add(id); out.push(cand); }
  }
  return out;
}

/** Strip clip tokens + tidy whitespace — for prose fields that don't render pills. */
function stripClips(text) {
  return String(text || '')
    .replace(CLIP_RE, '')
    .replace(/ {2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function poolMapOf(candidates) {
  return new Map((candidates || []).filter((c) => c && c.pineconeId).map((c) => [c.pineconeId, c]));
}

// Body text with any trailing clip-token lines removed → the prose summary.
function summaryOf(body) { return stripClips(body); }

// "- a\n- b" → ['a','b']
function bulletLines(body) {
  return String(body || '')
    .split('\n')
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, '').trim())
    .filter(Boolean);
}

// ---- per-kind shapers ----

function parseDossier(text, candidates) {
  const pool = poolMapOf(candidates);
  const blocks = splitBlocks(text);
  const topics = blocks
    .filter((b) => b.marker === 'TOPIC')
    .map((b) => ({ topic: b.payload, positionSummary: summaryOf(b.body), citations: hydrate(b.body, pool) }));
  const appBlock = blocks.find((b) => b.marker === 'APPEARANCES');
  const appearances = appBlock
    ? bulletLines(appBlock.body).map((line) => {
      const [show, episodeTitle, publishedDate] = line.split('|').map((s) => s.trim());
      return { show: show || null, episodeTitle: episodeTitle || null, publishedDate: publishedDate || null, citationCount: 0 };
    })
    : [];
  return { topics, appearances };
}

function parseBrief(text, candidates) {
  const pool = poolMapOf(candidates);
  const blocks = splitBlocks(text);
  const headline = (blocks.find((b) => b.marker === 'HEADLINE')?.payload) || '';
  const sections = blocks
    .filter((b) => b.marker === 'PUBLISHER')
    .map((b) => ({ publisher: b.payload, summary: summaryOf(b.body), citations: hydrate(b.body, pool) }));
  return { headline, sections };
}

function parseSplit(text, candidates) {
  const pool = poolMapOf(candidates);
  const blocks = splitBlocks(text);
  const persons = blocks.filter((b) => b.marker === 'PERSON');
  const side = (b) => (b ? { person: b.payload, positionSummary: summaryOf(b.body), citations: hydrate(b.body, pool) } : { person: '', positionSummary: '', citations: [] });
  const contrast = blocks.find((b) => b.marker === 'CONTRAST');
  return { sideA: side(persons[0]), sideB: side(persons[1]), contrastSummary: contrast ? summaryOf(contrast.body) : undefined };
}

function parseNarrative(text, candidates) {
  const pool = poolMapOf(candidates);
  const blocks = splitBlocks(text);
  const thesis = (blocks.find((b) => b.marker === 'THESIS')?.payload) || '';
  const buckets = blocks.filter((b) => b.marker === 'BUCKET').map((b) => {
    // rawPayload looks like "| <start> | <end> | <sentiment>"
    const parts = b.rawPayload.split('|').map((s) => s.trim());
    const p = parts[0] === '' ? parts.slice(1) : parts; // drop leading empty from the leading "|"
    const sentiment = parseInt(p[2], 10);
    return {
      start: p[0] || null,
      end: p[1] || null,
      sentiment: Number.isFinite(sentiment) ? sentiment : 0,
      stance: summaryOf(b.body),
      citations: hydrate(b.body, pool),
    };
  });
  const inflBlock = blocks.find((b) => b.marker === 'INFLECTION');
  const inflections = inflBlock
    ? bulletLines(inflBlock.body).map((line) => {
      const i = line.indexOf(':');
      return i > 0
        ? { date: line.slice(0, i).trim(), description: line.slice(i + 1).trim() }
        : { date: null, description: line };
    })
    : [];
  const forwardCall = blocks.find((b) => b.marker === 'FORWARD')?.payload || undefined;
  return { thesis, buckets, inflections, forwardCall };
}

function parseReadin(text, candidates) {
  const pool = poolMapOf(candidates);
  const blocks = splitBlocks(text);
  const find = (marker, predicate) => blocks.find((b) => b.marker === marker && (!predicate || predicate(b)));

  const wtd = find('WHAT_THEY_DO');
  const pulse = find('PULSE');
  const smBull = find('SMART_MONEY', (b) => /bull/i.test(b.rawPayload));
  const smBear = find('SMART_MONEY', (b) => /bear/i.test(b.rawPayload));
  const risks = find('RISKS');

  let bullLine = '';
  let bearLine = '';
  if (pulse) {
    const mBull = pulse.rawPayload.match(/BULL:\s*([^|]*)/i);
    const mBear = pulse.rawPayload.match(/BEAR:\s*([^|]*)/i);
    bullLine = mBull ? mBull[1].trim() : '';
    bearLine = mBear ? mBear[1].trim() : '';
  }
  const pulseCites = pulse ? hydrate(pulse.body, pool) : [];

  return {
    // whatTheyDo KEEPS clip tokens (client renders inline pills); others strip.
    whatTheyDo: wtd ? wtd.body : '',
    whatTheyDoCitations: wtd ? hydrate(wtd.body, pool) : [],
    pulse: {
      bullLine,
      bearLine,
      priceAction: '',
      marqueeCitation: pulseCites[0] || null,
    },
    smartMoney: {
      bulls: smBull ? hydrate(smBull.body, pool) : [],
      bears: smBear ? hydrate(smBear.body, pool) : [],
    },
    risks: risks ? bulletLines(risks.body) : [],
  };
}

module.exports = {
  splitBlocks, clipIdsIn, hydrate, stripClips, poolMapOf,
  parseDossier, parseBrief, parseSplit, parseNarrative, parseReadin,
};
