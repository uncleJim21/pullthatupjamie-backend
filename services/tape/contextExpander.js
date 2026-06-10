/**
 * Adjacent-paragraph context stitching for Tape synthesis (eval items: truncated
 * quotes, thin grounding). Same Mongo adjacency pattern /pull uses
 * (agent-tools/pineconeTools.js getAdjacentParagraphs — episode-scoped, ordered by
 * start_time), but: (a) it returns the neighbor TEXT (that function strips it),
 * and (b) it's BATCHED — the whole candidate set costs ~2 queries, not one
 * full-episode scan per clip.
 *
 * Only truncated/short candidates are expanded (a clip cut mid-sentence — the
 * "limited prof…" failures — or under ~25 words). The expanded passage replaces
 * the clip's `text` ONLY in the copy handed to the synthesizer, so it grounds on
 * the fuller context; the citation pill still resolves against the ORIGINAL
 * candidate (original text + timestamps), so nothing wider leaks to the client.
 */

const JamieVectorMetadata = require('../../models/JamieVectorMetadata');
const { printLog } = require('../../constants');

const DEFAULT_WINDOW = parseInt(process.env.TAPE_CONTEXT_WINDOW || '1', 10);
const MAX_EXPANDED_CHARS = parseInt(process.env.TAPE_CONTEXT_MAX_CHARS || '700', 10);
const SHORT_WORDS = parseInt(process.env.TAPE_CONTEXT_SHORT_WORDS || '12', 10);

/** A clip worth expanding: ends mid-sentence (no terminal punctuation) or short. */
function looksTruncated(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.split(/\s+/).length < SHORT_WORDS) return true;
  return !/[.!?"'’”)\]]$/.test(t);
}

/**
 * @param {Array} candidates  Tape candidates (need .pineconeId, .text)
 * @param {object} [opts]      { window }
 * @returns {Promise<Array>}   copies with .text expanded for truncated clips (others unchanged)
 */
async function expandPassages(candidates, { window = DEFAULT_WINDOW } = {}) {
  try {
    if (!Array.isArray(candidates) || !candidates.length) return candidates;
    const targets = candidates.filter((c) => c && c.pineconeId && looksTruncated(c.text));
    if (!targets.length) return candidates;

    // 1) seed lookup: clip id -> { guid, start_time } (cheap, unique-indexed)
    const seeds = await JamieVectorMetadata.find(
      { pineconeId: { $in: targets.map((c) => c.pineconeId) }, type: 'paragraph' },
      { pineconeId: 1, guid: 1, start_time: 1 },
    ).lean();
    if (!seeds.length) return candidates;
    const seedById = new Map(seeds.map((s) => [s.pineconeId, s]));
    const guids = [...new Set(seeds.map((s) => s.guid).filter(Boolean))];

    // 2) one query for every involved episode's paragraphs, time-ordered, w/ text
    const all = await JamieVectorMetadata.find(
      { type: 'paragraph', guid: { $in: guids } },
      { pineconeId: 1, guid: 1, start_time: 1, 'metadataRaw.text': 1 },
    ).sort({ guid: 1, start_time: 1 }).lean();
    const byGuid = new Map();
    for (const d of all) {
      if (!byGuid.has(d.guid)) byGuid.set(d.guid, []);
      byGuid.get(d.guid).push(d);
    }

    const textOf = (d) => (d && d.metadataRaw && d.metadataRaw.text) || '';
    const expandedById = new Map();
    for (const c of targets) {
      const seed = seedById.get(c.pineconeId);
      const arr = seed ? byGuid.get(seed.guid) : null;
      if (!arr) continue;
      const idx = arr.findIndex((d) => d.pineconeId === c.pineconeId);
      if (idx === -1) continue;
      const slice = arr.slice(Math.max(0, idx - window), Math.min(arr.length, idx + 1 + window));
      let text = slice.map(textOf).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (text.length > MAX_EXPANDED_CHARS) text = `${text.slice(0, MAX_EXPANDED_CHARS).replace(/\s+\S*$/, '')}…`;
      if (text && text.length > String(c.text || '').length) expandedById.set(c.pineconeId, text);
    }
    if (!expandedById.size) return candidates;
    printLog(`[contextExpander] expanded ${expandedById.size}/${candidates.length} truncated clips (window ${window})`);
    return candidates.map((c) => (expandedById.has(c.pineconeId) ? { ...c, text: expandedById.get(c.pineconeId) } : c));
  } catch (err) {
    printLog(`[contextExpander] error: ${err.message} — using un-expanded candidates`);
    return candidates;
  }
}

module.exports = { expandPassages, looksTruncated };
