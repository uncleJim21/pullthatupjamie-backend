const JamieVectorMetadata = require('../models/JamieVectorMetadata');

const MAX_PINECONE_IDS_DEFAULT = 50;
const MAX_ITEMS_IN_CONTEXT_DEFAULT = 20;

function normalizePineconeIds(pineconeIds = [], maxIds = MAX_PINECONE_IDS_DEFAULT) {
  if (!Array.isArray(pineconeIds)) {
    return { ordered: [], unique: [], dropped: [{ id: null, reason: 'pineconeIds_not_array' }] };
  }

  const dropped = [];
  const ordered = [];
  const seen = new Set();

  for (const raw of pineconeIds) {
    if (ordered.length >= maxIds) {
      dropped.push({ id: raw, reason: 'over_limit' });
      continue;
    }
    if (typeof raw !== 'string') {
      dropped.push({ id: raw, reason: 'not_string' });
      continue;
    }
    const id = raw.trim();
    if (!id) {
      dropped.push({ id: raw, reason: 'empty' });
      continue;
    }
    if (seen.has(id)) {
      dropped.push({ id, reason: 'duplicate' });
      continue;
    }
    seen.add(id);
    ordered.push(id);
  }

  return { ordered, unique: ordered, dropped };
}

function buildBaseInstructions() {
  // Keep this in one place so both endpoints always match.
  return `
You are an AI assistant analyzing a research session composed of podcast clips. Keep it modestly succinct and to the point.

You will receive:
- An indexed array of items (0-based), each with episode title, creator, a short quote,
  and when available: a StartTimeSeconds value.

Your goals:
1. Identify and summarize key themes and ideas that are relevant to the research session.
2. Include quick blurbs from the most salient items that support (1) above. Do not include more than 3 or so.
3. Call out any patterns, contradictions, or notable perspectives.
4. Enumerate and use clear lines of demarcation where possible.

Source citation requirements (IMPORTANT):
- Each item in the context includes a line "CiteToken: ⟦CITE:<index>⟧".
- When you reference a specific item or quote, you MUST append that exact CiteToken at the END of the SAME line.
- The CiteToken must be the final content on the line (no trailing punctuation).
- Do NOT output CARD_JSON in your response.
- Do NOT reference items using patterns like "item[7]" or "items[7]" or "[7]". Only use CiteToken.
- Example:
  ...some sentence about an item... ⟦CITE:7⟧

Output format (IMPORTANT):
- On the FIRST line, output: TITLE: <concise title, max 8 words, no quotes, no emojis>.
- On the SECOND line, output a single blank line.
- Starting from the THIRD line, output your full analysis of the research session
  following the source citation rules above.

Do NOT output anything before the TITLE line. Be concise but insightful. Assume the reader is technical and curious.
`.trim();
}

function buildContextLinesFromMongoDocs(limitedItems = []) {
  return (limitedItems || [])
    .map((entry) => entry && entry.doc && entry.doc.metadataRaw ? entry : null)
    .filter(Boolean)
    .map((entry, index) => {
      const meta = entry.doc.metadataRaw || {};

      const quote =
        meta.text ||
        meta.quote ||
        meta.summary ||
        meta.headline ||
        '(no quote)';

      const episode = meta.episode || meta.title || 'Unknown episode';
      const creator = meta.creator || 'Unknown creator';

      const episodeImage =
        meta.episodeImage ||
        meta.imageUrl ||
        meta.podcastImage ||
        meta.image ||
        '';

      const episodeOrChapterTitle =
        meta.headline ||
        meta.chapterTitle ||
        meta.chapter ||
        meta.episode ||
        meta.title ||
        'Unknown title';

      const startTime =
        (typeof entry.doc.start_time === 'number' ? entry.doc.start_time : null) ??
        (typeof meta.start_time === 'number' ? meta.start_time : null) ??
        (meta.timeContext && typeof meta.timeContext.start_time === 'number' ? meta.timeContext.start_time : null) ??
        null;

      const startSeconds =
        typeof startTime === 'number' && !Number.isNaN(startTime)
          ? Math.floor(startTime)
          : null;

      return [
        `items[${index}]:`,
        `CiteToken: ⟦CITE:${index}⟧`,
        `PineconeId: ${entry.pineconeId}`,
        `Episode: ${episode}`,
        `Creator: ${creator}`,
        `EpisodeOrChapterTitle: ${episodeOrChapterTitle}`,
        startSeconds !== null
          ? `StartTimeSeconds: ${startSeconds}`
          : 'StartTimeSeconds: (unknown)',
        `Quote: ${quote}`,
        ''
      ].join('\n');
    });
}

/**
 * Shared streaming analysis pipeline for both:
 * - session-based analyze
 * - ad-hoc analyze (explicit pineconeIds)
 */
async function streamResearchAnalysis({
  openai,
  res,
  orderedPineconeIds,
  instructions,
  maxItemsInContext = MAX_ITEMS_IN_CONTEXT_DEFAULT
}) {
  const uniqueIds = Array.from(new Set(orderedPineconeIds || []));

  const mongoDocs = uniqueIds.length
    ? await JamieVectorMetadata.find({ pineconeId: { $in: uniqueIds } })
        .select('pineconeId metadataRaw start_time end_time')
        .lean()
    : [];

  const mongoById = new Map((mongoDocs || []).map((doc) => [doc.pineconeId, doc]));

  const limitedItems = [];
  for (const pid of orderedPineconeIds || []) {
    if (limitedItems.length >= maxItemsInContext) break;
    const doc = mongoById.get(pid);
    if (!doc || !doc.metadataRaw) continue;
    limitedItems.push({ pineconeId: pid, doc });
  }

  if (!limitedItems.length) {
    const err = new Error('Missing metadata');
    err.statusCode = 400;
    err.details = 'None of the requested items could be hydrated from MongoDB (JamieVectorMetadata)';
    throw err;
  }

  // Precompute CARD_JSON payloads by context index (0-based) so we can translate
  // model-emitted CARD_REF:<index> markers into the exact CARD_JSON format expected by the frontend.
  const cardJsonByIndex = limitedItems.map((entry) => {
    const meta = entry.doc.metadataRaw || {};
    const episodeImage =
      meta.episodeImage ||
      meta.imageUrl ||
      meta.podcastImage ||
      meta.image ||
      null;
    const title =
      meta.headline ||
      meta.chapterTitle ||
      meta.chapter ||
      meta.episode ||
      meta.title ||
      'Unknown title';

    return JSON.stringify({
      pineconeId: entry.pineconeId,
      episodeImage: episodeImage ? episodeImage : null,
      title
    });
  });

  const contextLines = buildContextLinesFromMongoDocs(limitedItems);
  const contextText = contextLines.join('\n---\n');

  const baseInstructions = buildBaseInstructions();
  const userInstructions =
    typeof instructions === 'string' && instructions.trim().length > 0
      ? instructions.trim()
      : 'Use the default analysis goals above.';

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    stream: true,
    messages: [
      { role: 'system', content: baseInstructions },
      {
        role: 'user',
        content: `Here is the research session context:\n\n${contextText}\n\nUser instructions: ${userInstructions}`
      }
    ],
    temperature: 0.4
  });

  // Transform the streaming text on the fly:
  // - Forward content continuously (preserves "typewriter" feel)
  // - Keep a small tail buffer so cite markers that are split across chunks
  //   can still be rewritten correctly.
  // With up to 50 items, the longest possible cite token is tiny (e.g. ⟦CITE:49⟧),
  // so N=64 is a safe upper bound for any conceivable partial marker fragment.
  const TAIL_CHARS = 64;
  let buffer = '';

  const toCardJson = (idxStr, markerLabel) => {
    const idx = parseInt(idxStr, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= cardJsonByIndex.length) {
      console.warn('[researchAnalysis] Invalid cite index:', { markerLabel, idxStr });
      const fallback = JSON.stringify({ pineconeId: '', episodeImage: null, title: '' });
      return `CARD_JSON: ${fallback}`;
    }
    return `CARD_JSON: ${cardJsonByIndex[idx]}`;
  };

  const replaceCitationsInText = (text) => {
    // Normalize common bracket lookalikes so we don't miss citations due to Unicode variants.
    // We only do minimal normalization around the cite token patterns.
    let normalized = text;
    // ⟦ ⟧ (U+27E6/U+27E7) and 〚 〛 (U+301A/U+301B) and 【 】 (U+3010/U+3011)
    // are all visually "double brackets" in many fonts.
    normalized = normalized
      .replace(/⟦/g, '[[')
      .replace(/⟧/g, ']]')
      .replace(/〚/g, '[[')
      .replace(/〛/g, ']]')
      .replace(/【/g, '[[')
      .replace(/】/g, ']]');

    // Preferred: weird-delimiter CiteToken ⟦CITE:7⟧
    // (After normalization, these become [[CITE:7]])
    let out = normalized.replace(/\[\[CITE:?\s*(\d+)\s*\]\]/g, (_m, idxStr) =>
      toCardJson(idxStr, 'CITE_TOKEN')
    );
    // Accept bracket variant too: [[CITE 7]] or [[CITE:7]]
    // Back-compat: CARD_REF: 7
    out = out.replace(/CARD_REF:\s*(\d+)/g, (_m, idxStr) => toCardJson(idxStr, 'CARD_REF'));
    return out;
  };

  const findSafeFlushCut = (buf, desiredCut) => {
    // Ensure we don't flush through the start of an incomplete marker.
    let cut = desiredCut;
    const flushable = buf.slice(0, cut);

    // 1) CiteToken ⟦CITE:...⟧
    // Check a few likely token starts (including normalized bracket variants).
    const openCite =
      Math.max(
        flushable.lastIndexOf('⟦CITE:'),
        flushable.lastIndexOf('〚CITE:'),
        flushable.lastIndexOf('【CITE:'),
        flushable.lastIndexOf('[[CITE'),
        flushable.lastIndexOf('⟦CITE'),
        flushable.lastIndexOf('〚CITE'),
        flushable.lastIndexOf('【CITE')
      );
    if (openCite !== -1) {
      const close1 = flushable.indexOf('⟧', openCite);
      const close2 = flushable.indexOf('〛', openCite);
      const close3 = flushable.indexOf('】', openCite);
      const close4 = flushable.indexOf(']]', openCite);
      const close = [close1, close2, close3, close4].filter((x) => x !== -1).sort((a, b) => a - b)[0] ?? -1;
      if (close === -1) {
        cut = Math.min(cut, openCite);
      }
    }

    // 2) Bracket CiteToken [[CITE...]]
    const openBracket = flushable.lastIndexOf('[[CITE');
    if (openBracket !== -1) {
      const close = flushable.indexOf(']]', openBracket);
      if (close === -1) {
        cut = Math.min(cut, openBracket);
      }
    }

    // 3) Legacy CARD_REF
    const openRef = flushable.lastIndexOf('CARD_REF');
    if (openRef !== -1) {
      const snippet = flushable.slice(openRef);
      // If we haven't received a digit yet, keep it buffered.
      if (!/CARD_REF:\s*\d/.test(snippet)) {
        cut = Math.min(cut, openRef);
      }
    }

    // 4) Prevent splitting the *opening sequence itself* across flush boundaries.
    // Example leak mode:
    //   flush writes "... [[CI" (no match), next write writes "TE:2]]" (no match) => client sees [[CITE:2]].
    // To prevent this, if the flushable text ends with a suffix that is a prefix of any marker open,
    // keep that suffix in the buffer by moving the cut backward.
    const OPEN_SEEDS = ['[[CITE', '⟦CITE', '〚CITE', '【CITE', 'CARD_REF'];
    for (const seed of OPEN_SEEDS) {
      // Check all proper prefixes (exclude full seed; full seed is handled by the incomplete-marker checks above)
      for (let k = 1; k < seed.length; k++) {
        const prefix = seed.slice(0, k);
        if (flushable.endsWith(prefix)) {
          cut = Math.min(cut, cut - k);
        }
      }
    }

    return cut;
  };

  const stripTrailingIncompleteMarkers = (text) => {
    // If the stream ends unexpectedly mid-marker, drop the trailing partial marker rather than leaking it.
    // (We keep this conservative and only strip if the open appears after the last close.)
    const lastCiteOpen = Math.max(
      text.lastIndexOf('⟦CITE'),
      text.lastIndexOf('〚CITE'),
      text.lastIndexOf('【CITE'),
      text.lastIndexOf('[[CITE')
    );
    if (lastCiteOpen !== -1) {
      const lastClose = Math.max(
        text.lastIndexOf('⟧'),
        text.lastIndexOf('〛'),
        text.lastIndexOf('】'),
        text.lastIndexOf(']]')
      );
      if (lastClose < lastCiteOpen) {
        return text.slice(0, lastCiteOpen);
      }
    }
    const lastBracketOpen = text.lastIndexOf('[[CITE');
    if (lastBracketOpen !== -1) {
      const lastBracketClose = text.lastIndexOf(']]');
      if (lastBracketClose < lastBracketOpen) {
        return text.slice(0, lastBracketOpen);
      }
    }
    const lastRefOpen = text.lastIndexOf('CARD_REF');
    if (lastRefOpen !== -1) {
      const tail = text.slice(lastRefOpen);
      if (!/CARD_REF:\s*\d/.test(tail)) {
        return text.slice(0, lastRefOpen);
      }
    }
    return text;
  };

  for await (const chunk of stream) {
    const content = chunk.choices?.[0]?.delta?.content || '';
    if (!content) continue;

    buffer += content;

    if (buffer.length > TAIL_CHARS) {
      const desiredCut = buffer.length - TAIL_CHARS;
      const cut = findSafeFlushCut(buffer, desiredCut);
      const flushable = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      if (flushable) res.write(replaceCitationsInText(flushable));
    }
  }

  // Flush remainder
  if (buffer) {
    const safe = stripTrailingIncompleteMarkers(buffer);
    if (safe) res.write(replaceCitationsInText(safe));
  }

  res.end();
}

module.exports = {
  MAX_PINECONE_IDS_DEFAULT,
  MAX_ITEMS_IN_CONTEXT_DEFAULT,
  normalizePineconeIds,
  buildBaseInstructions,
  streamResearchAnalysis
};

