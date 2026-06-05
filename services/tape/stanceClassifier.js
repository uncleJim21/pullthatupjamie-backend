/**
 * Stance gate — classify each clip's directional stance toward a subject
 * (bull / bear / neutral) so retrieval-seeded pools can be FILTERED to genuinely
 * polarized quotes before they fill a bear slot (Read-in) or a camp side (Split).
 *
 * Why: polarity-seeded retrieval (e.g. "{ticker} bear case overvalued") improves
 * RECALL of the bearish neighborhood, but a topically-adjacent quote that isn't
 * actually bearish still comes back — and lands in the bear slot, making both
 * sides look the same (eval: bear_slot_not_bearish, both_sides_same). This is the
 * PRECISION half: a cheap gpt-4o-mini pass that scores each clip's stance so the
 * orchestrator can keep only stance-correct quotes per side.
 *
 * One structured-output call (strict json_schema — the same shape that fixed the
 * reranker). Fail-open: on any error the caller keeps its un-gated pool.
 */

const { printLog } = require('../../constants.js');

const STANCE_MODEL = process.env.TAPE_STANCE_MODEL || 'gpt-4o-mini';
const STANCES = ['bull', 'bear', 'neutral'];

/**
 * @param {object} opts
 * @param {string} opts.subject  what the stance is measured TOWARD (ticker/company/topic)
 * @param {Array}  opts.clips    clip objects (need .quote or .text, + .pineconeId)
 * @param {object} opts.openai   OpenAI client
 * @returns {{ stances: Map<string,'bull'|'bear'|'neutral'>, usage: object }}
 *          stances keyed by pineconeId; clips without a verdict are absent.
 */
async function classifyStance({ subject, clips, openai }) {
  const empty = { stances: new Map(), usage: { model: STANCE_MODEL, input_tokens: 0, output_tokens: 0 } };
  if (!openai || !Array.isArray(clips) || clips.length === 0) return empty;

  const list = clips.map((c, i) => {
    const text = (c.quote || c.text || '').replace(/\s+/g, ' ').slice(0, 260);
    return `[${i}] "${text}"`;
  }).join('\n');

  const system = `You classify each podcast clip's STANCE toward "${subject}". For each clip return exactly one of: bull, bear, neutral.
- bull  = the speaker is directionally POSITIVE on ${subject}: upside, buy, growth, undervalued, will rise, secular tailwind.
- bear  = the speaker is directionally NEGATIVE on ${subject}: downside, sell, overvalued, bubble, will fall, headwinds, structural risk to ${subject} itself.
- neutral = descriptive only, mixed/balanced, a sponsor/ad/intro segment, OR not actually a directional view ON ${subject} (e.g. praises a competitor, generic market commentary, merely mentions ${subject} in passing).
Be STRICT: merely mentioning ${subject}, or stating a fact about it, is NOT a stance — that is neutral. A "bear" must argue ${subject} specifically is likely to do badly.
Return JSON {"stances":[{"i":0,"s":"bear"}, ...]} — exactly one entry per clip, i = the clip index.`;

  try {
    const resp = await openai.chat.completions.create({
      model: STANCE_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Subject: "${subject}"\n\nClips:\n${list}` },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'clip_stances',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['stances'],
            properties: {
              stances: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['i', 's'],
                  properties: {
                    i: { type: 'integer' },
                    s: { type: 'string', enum: STANCES },
                  },
                },
              },
            },
          },
        },
      },
      temperature: 0.0,
      max_tokens: 700,
    });

    const usage = resp.usage || {};
    const parsed = JSON.parse(resp.choices[0].message.content || '{"stances":[]}');
    const stances = new Map();
    let bull = 0; let bear = 0; let neutral = 0;
    for (const entry of parsed.stances || []) {
      const clip = clips[entry.i];
      if (!clip || !clip.pineconeId || !STANCES.includes(entry.s)) continue;
      stances.set(clip.pineconeId, entry.s);
      if (entry.s === 'bull') bull += 1; else if (entry.s === 'bear') bear += 1; else neutral += 1;
    }
    printLog(`[STANCE] "${subject}" ${clips.length} clips → bull ${bull} / bear ${bear} / neutral ${neutral}, ${usage.total_tokens || 0} tokens`);
    return { stances, usage: { model: STANCE_MODEL, input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } };
  } catch (err) {
    printLog(`[STANCE] error: ${err.message} — failing open (no gate)`);
    return empty;
  }
}

module.exports = { classifyStance, STANCE_MODEL };
