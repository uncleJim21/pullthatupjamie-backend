/**
 * gpt-4o-mini grader for benchmark responses.
 *
 * Heuristic checks (keyword presence, length) catch the easy cases but miss
 * paraphrased-but-correct answers. The judge picks up that slack: given the
 * original question, the agent's response, and a one-line criteria string,
 * it returns { pass, reason }.
 *
 * Cost is small (~$0.005 per call for a few hundred response tokens), so
 * grading the whole 12-query suite is ~$0.06 per run.
 */

const OpenAI = require('openai');

const JUDGE_MODEL = process.env.BENCHMARK_JUDGE_MODEL || 'gpt-4o-mini';
const JUDGE_TIMEOUT_MS = 20000;

function buildSystemPrompt() {
  const today = new Date();
  const year = today.getUTCFullYear();
  const dateStr = today.toISOString().slice(0, 10);
  return `You are a strict but fair grader of search-agent responses. The agent searches a corpus of podcast transcripts and synthesizes answers from cited clips.

IMPORTANT CONTEXT: Today's date is ${dateStr}. The current year is ${year}. The podcast corpus contains content from past years up through ${year}. When the agent references ${year} content or describes events "this year," that is the CURRENT year and is NOT a fabrication — your training cutoff may pre-date ${year} but the agent's clips are real and time-stamped. Do not flag ${year} dates as "in the future."

You will receive:
  - The original USER QUESTION
  - The agent's RESPONSE
  - Specific CRITERIA describing what a passing response looks like

Reply with a single JSON object on one line, no markdown fences:
  {"pass": true|false, "reason": "one short sentence"}

Grading rules:
  - PASS if the response substantively addresses the question per the criteria.
  - PASS if the criteria mentions a graceful "no info found" response is acceptable AND the agent declined honestly.
  - FAIL if the agent fabricated content (made-up facts, fake citations).
  - FAIL if the agent refused for non-content reasons (safety filter, unclear question).
  - FAIL if the response is empty, garbled, or under ~50 characters of substance.
  - Paraphrase is fine; exact keyword matches are not required.
  - Do NOT downgrade responses for using current-year dates (${year}) — those are real.
  - Be honest. "Pass" doesn't require perfection, just substantive accuracy on the question asked.`;
}

async function judgeResponse({ question, response, criteria }) {
  if (!process.env.OPENAI_API_KEY) {
    return { pass: null, reason: 'OPENAI_API_KEY not set; judge skipped', skipped: true };
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userPrompt = [
    `USER QUESTION:`,
    question,
    ``,
    `AGENT RESPONSE:`,
    response,
    ``,
    `CRITERIA:`,
    criteria,
    ``,
    `Reply with a single line: {"pass": ..., "reason": "..."}`,
  ].join('\n');

  const started = Date.now();
  let raw = '';
  try {
    const resp = await Promise.race([
      openai.chat.completions.create({
        model: JUDGE_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 150,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('judge timeout')), JUDGE_TIMEOUT_MS)),
    ]);
    raw = resp?.choices?.[0]?.message?.content?.trim() || '';
  } catch (err) {
    return { pass: null, reason: `judge error: ${err.message}`, skipped: true, latencyMs: Date.now() - started };
  }

  const latencyMs = Date.now() - started;

  // Lenient JSON parse — strip code fences if the judge slipped them in.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.pass !== 'boolean') throw new Error('missing pass field');
    return {
      pass: parsed.pass,
      reason: String(parsed.reason || '').slice(0, 200),
      latencyMs,
      model: JUDGE_MODEL,
    };
  } catch (err) {
    return {
      pass: null,
      reason: `judge JSON parse failed: ${err.message}; raw="${raw.slice(0, 120)}"`,
      latencyMs,
      model: JUDGE_MODEL,
      skipped: true,
    };
  }
}

module.exports = { judgeResponse };
