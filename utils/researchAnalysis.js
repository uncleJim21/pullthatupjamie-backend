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
- A list of items, each with episode title, creator, a short quote,
  and when available: an AudioUrl and a StartTimeSeconds value.

Your goals:
1. Summarize the key themes and ideas across all items.
2. Call out any patterns, contradictions, or notable perspectives.

Source citation requirements (IMPORTANT):
- When you reference a specific item or quote, append a machine-readable "card" marker at the END of the SAME line
  using this exact format:
  CARD_JSON: <valid JSON>
- The JSON MUST be valid and MUST include these keys:
  - pineconeId (string)
  - episodeImage (string or null)
  - title (string)  // episode/chapter title
- IMPORTANT: Each item in the context includes a line "CardJSON: {...}".
  For citations, COPY that JSON EXACTLY (do not modify any characters).
- The "CARD_JSON: ..." must be the final content on the line (no trailing punctuation).
- Do NOT wrap CARD_JSON in parentheses or brackets. Bad: "(CARD_JSON: {...})". Good: "CARD_JSON: {...}"
- Do NOT include the literal prefix "Quote:" or parentheticals like "(Quote: ...)" in your output.
  If you want to include a direct quote, include it naturally in the sentence (with quotes) and then append CARD_JSON.
- Example:
  ...some sentence about an item... CARD_JSON: {"pineconeId":"9a1bc097..._p43","episodeImage":"https://.../image.jpg","title":"Bitcoin Revealed What School Never Wanted Us to Understand"}

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

      const cardJson = JSON.stringify({
        pineconeId: entry.pineconeId,
        episodeImage: episodeImage ? episodeImage : null,
        title: episodeOrChapterTitle
      });

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
        `Item ${index + 1}:`,
        `PineconeId: ${entry.pineconeId}`,
        `Episode: ${episode}`,
        `Creator: ${creator}`,
        episodeImage ? `EpisodeImage: ${episodeImage}` : 'EpisodeImage: (not available)',
        `EpisodeOrChapterTitle: ${episodeOrChapterTitle}`,
        `CardJSON: ${cardJson}`,
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

  for await (const chunk of stream) {
    const content = chunk.choices?.[0]?.delta?.content || '';
    if (content) {
      res.write(content);
    }
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

