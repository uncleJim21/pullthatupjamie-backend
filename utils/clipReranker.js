const { printLog } = require('../constants.js');

const RERANKER_MODEL = 'gpt-4o-mini';
const MIN_RELEVANCE_SCORE = 4;

/**
 * Re-rank clips using a lightweight LLM call. Scores each clip 0-10 on
 * relevance to the query, filters out low-scorers, and re-orders by score.
 *
 * @param {object} options
 * @param {string} options.query - The (possibly rewritten) embedding query
 * @param {Array}  options.clips - Array of clip objects (must have .quote or .text). May include .guests (episode-level tagged guests).
 * @param {object} options.openai - OpenAI client instance
 * @param {number} [options.minScore=4] - Minimum score to keep (0-10)
 * @param {string} [options.userMessage] - The original user question (NOT the rewritten search query). When provided, the scorer applies a person-mismatch penalty: clips from episodes whose tagged guests don't include a person the user named score 0-3.
 * @returns {{ clips: Array, usage: { model: string, input_tokens: number, output_tokens: number } }}
 */
async function rerankClips({ query, clips, openai, minScore = MIN_RELEVANCE_SCORE, userMessage }) {
  const debugPrefix = '[RERANKER]';

  if (!clips || clips.length === 0) {
    return { clips: [], usage: { model: RERANKER_MODEL, input_tokens: 0, output_tokens: 0 } };
  }

  if (clips.length <= 2) {
    printLog(`${debugPrefix} Only ${clips.length} clips — skipping rerank`);
    return { clips, usage: { model: RERANKER_MODEL, input_tokens: 0, output_tokens: 0 } };
  }

  const clipSummaries = clips.map((c, i) => {
    const text = (c.quote || c.text || '').substring(0, 250);
    const speaker = c.creator || 'Unknown';
    const episode = c.episode || '';
    const guests = Array.isArray(c.guests) ? c.guests : [];
    const guestStr = guests.length > 0
      ? ` [guests: ${guests.slice(0, 4).join(', ')}]`
      : ' [guests: none-tagged]';
    return `[${i}] (${speaker} — ${episode})${guestStr} "${text}"`;
  });

  const systemPrompt = `You are a relevance scorer for podcast transcript clips. Given the user's question and a numbered list of clips, score each clip 0-10 on how directly relevant and substantive it is to answering the question.

Scoring guide:
- 0-1: Completely irrelevant, sponsor/ad reads, promo codes, "brought to you by" segments, social media plugs, or intro/outro greetings
- 2-3: Mentions a keyword but discusses something else entirely
- 4-5: Somewhat relevant but tangential or shallow
- 6-7: Relevant and contains useful information
- 8-10: Directly and substantively addresses the question

Additional penalties:
- Clips that are primarily advertising, sponsorship reads, or promotional content (promo codes, URLs to sign up, "brought to you by", discount offers) should score 0-1 regardless of keyword overlap with the query
- Clips that are just someone else talking ABOUT the topic person (rather than the person speaking) should be scored 3-5 unless the commentary itself is particularly insightful
- Very short clips with no real content should score 0-2
- If the question specifically names a podcast, host, or creator (e.g. "whatifalthist", "Lex Fridman", "All-In"), clips NOT from that source should score 0-2 regardless of topical relevance
- Closing/farewell exchanges ("where can people find you", "where can I follow you", "thanks for coming on", "that's all for today") should score 0-1 regardless of keyword overlap

Person-mismatch penalty (HARD RULE — apply before any topical score):
- Each clip carries a [guests: ...] tag listing the episode's tagged guests, OR [guests: none-tagged] when the show/episode has no guest metadata.
- If the user's question names a specific person (a guest, "what did X say", "X's appearance on Y", "summary of X on Z"), and the clip's [guests: ...] list is non-empty AND does NOT include that person (case-insensitive substring match against any listed guest), score the clip **0-3** regardless of topical fit. Topical relevance is NOT proof the user's named person is the speaker.
- If the clip is [guests: none-tagged], do NOT apply this penalty — score normally on topical/substantive relevance. Empty guest metadata is ambiguous, not exonerating.
- This penalty does NOT apply when the user's question is a pure topic query with no named person ("Bitcoin custody", "AI agents").

Return ONLY a JSON array: [{"i":0,"s":7},{"i":1,"s":3},...]`;

  const questionForScorer = (typeof userMessage === 'string' && userMessage.trim().length > 0)
    ? userMessage.trim()
    : query;
  const userPrompt = `Question: "${questionForScorer}"

Clips:
${clipSummaries.join('\n')}`;

  try {
    const response = await openai.chat.completions.create({
      model: RERANKER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.0,
      max_tokens: 600,
    });

    const usage = response.usage || {};
    const raw = response.choices[0].message.content?.trim() || '[]';

    let scores;
    try {
      const parsed = JSON.parse(raw);
      scores = Array.isArray(parsed) ? parsed : (parsed.scores || parsed.results || []);
    } catch {
      printLog(`${debugPrefix} Failed to parse LLM response: ${raw.substring(0, 200)}`);
      return { clips, usage: { model: RERANKER_MODEL, input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } };
    }

    const scoreMap = new Map();
    for (const entry of scores) {
      const idx = entry.i ?? entry.index;
      const score = entry.s ?? entry.score;
      if (typeof idx === 'number' && typeof score === 'number') {
        scoreMap.set(idx, score);
      }
    }

    const scored = clips.map((clip, i) => ({
      clip,
      llmScore: scoreMap.get(i) ?? 5,
    }));

    const filtered = scored
      .filter(s => s.llmScore >= minScore)
      .sort((a, b) => b.llmScore - a.llmScore)
      .map(s => s.clip);

    const removed = clips.length - filtered.length;
    printLog(`${debugPrefix} ${clips.length} clips → ${filtered.length} kept (${removed} below threshold ${minScore}), ${usage.total_tokens || 0} tokens`);

    return {
      clips: filtered,
      usage: { model: RERANKER_MODEL, input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
    };

  } catch (error) {
    printLog(`${debugPrefix} ERROR: ${error.message} — returning unranked clips`);
    return { clips, usage: { model: RERANKER_MODEL, input_tokens: 0, output_tokens: 0 } };
  }
}

module.exports = { rerankClips, RERANKER_MODEL, MIN_RELEVANCE_SCORE };
