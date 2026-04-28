'use strict';

/**
 * Detect bad synthesis-pass output before it reaches the user.
 *
 * Empirically validated against the 2026-04-27 regression dataset
 * (40 queries, 6 known failures). The output-token count cleanly
 * separated success and failure: failed synthesis emitted 96-403
 * output tokens, successful synthesis emitted 341-742. We also
 * watch for residual tool-call markup (Chamath-style: model emitted
 * 403 tokens of DSML — high token count but bad content) and
 * narration-only short outputs ("Let me grab more context..."). Long
 * answers that end mid-{{clip:…}} still pass when above SUBSTANTIVE_TEXT_FLOOR
 * so we do not replace a useful partial with Tier 3.
 *
 * Drives the Tier 1/2/3 recovery flow in agentChatRoutes.js. See
 * docs/WIP/SYNTHESIS_FAILURE_RECOVERY_PLAN.md.
 */

const { hasToolCallMarkup } = require('./sanitizeOutput');

// Thresholds are env-configurable to allow tuning without code edits.
//
// 2026-04-28 — LOW_TOKEN_THRESHOLD lowered 250 → 80 after the 41-query
// regression showed Tier 2 (Haiku) was emitting *legitimate* honest "no
// transcribed coverage" answers (45-422 chars, 12-93 tokens) on thin-
// corpus queries (Saylor on TFTC, Kill Tony, EconTalk space colonization)
// and our gate was rejecting them as "too short", cascading to Tier 3
// fallback. The check is meant to catch DSML-only emissions where the
// model wrote 200-400 tokens of markup that got stripped to 0 chars of
// prose — those are already caught by the `empty` trigger, which fires
// first. 80 is low enough to pass real terse answers and high enough
// that any output above it is unambiguously substantive prose.
const LOW_TOKEN_THRESHOLD = parseInt(process.env.AGENT_SYNTHESIS_MIN_OUTPUT_TOKENS || '80', 10);
const SHORT_TEXT_THRESHOLD = parseInt(process.env.AGENT_SYNTHESIS_MIN_TEXT_LEN || '500', 10);

// Substantive-text floor — `truncated_prose` doesn't fire above this.
// 2026-04-28: long answers (>1500 chars) that happen to end mid-sentence
// on the last line (e.g. empires query 4576c ending "...the Syrian
// Empire,") are cosmetically blemished but still useful answers; running
// recovery on them often produces a SHORTER worse result. Cap the
// detector to short outputs where mid-sentence cut means the answer is
// genuinely incomplete.
const SUBSTANTIVE_TEXT_FLOOR = parseInt(process.env.AGENT_SYNTHESIS_SUBSTANTIVE_FLOOR || '1500', 10);

// The strict synthesis prompt explicitly instructs the model to emit
// this exact line when it cannot ground an answer in the conversation
// history. We must accept it on its own merits — it's the *expected*
// shape of a thin-evidence honest answer, not a failure.
const NO_COVERAGE_PREFIX_RE = /^\s*no transcribed coverage found/i;

// Narration-prefix patterns — these strings open responses where the model
// gave up partway and emitted preamble in lieu of a real answer.
const NARRATION_PREFIX_RE = /^\s*(let me\b|i'?ll\b|i'?m going to\b|i'?m about to\b|now let me\b|first,? let me\b|allow me to\b|let'?s grab\b|let'?s see\b|let'?s look\b|let'?s |perfect[!.]|great[!.]|ok(?:ay)?[,!.])/i;

// Mid-clip-token truncation (e.g. "{{clip:9fd5e7dc-72de-11f0-9be" with no
// closing braces). Caused by maxTokens cutting the response mid-UUID.
const TRUNCATED_CLIP_RE = /\{\{clip:[^}]*$/;

// Mid-prose truncation: text doesn't end with terminal punctuation, a
// closing quote/bracket, or a markdown emphasis marker. Catches the
// "...spending balloons during an" / "...the Syrian Empire," shape where
// the synthesis budget aborted the stream mid-sentence.
const TERMINAL_CHAR_RE = /[.!?"'*)\]}]/;

/**
 * @param {{ text: string, outputTokens?: number }} input
 * @returns {{ ok: boolean, trigger?: string, reason?: string }}
 */
function evaluateSynthesisOutput({ text, outputTokens } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, trigger: 'empty', reason: 'no usable text emitted' };
  }

  const trimmed = text.trim();

  // Pass-through for the canonical "no transcribed coverage found" honest
  // answer. The strict synthesis prompt explicitly asks the model to emit
  // this exact line when there's nothing in the conversation history to
  // ground an answer in. We must not reject it as "too short" or recovery
  // will cascade to Tier 3 generic-error message.
  if (NO_COVERAGE_PREFIX_RE.test(trimmed)) {
    return { ok: true };
  }

  if (Number.isFinite(outputTokens) && outputTokens > 0 && outputTokens < LOW_TOKEN_THRESHOLD) {
    return {
      ok: false,
      trigger: 'low_tokens',
      reason: `synthesis emitted ${outputTokens} output tokens (< ${LOW_TOKEN_THRESHOLD})`,
    };
  }

  if (hasToolCallMarkup(text)) {
    return {
      ok: false,
      trigger: 'markup_residue',
      reason: 'tool-call DSL detected in synthesis text after sanitization',
    };
  }

  if (text.length < SHORT_TEXT_THRESHOLD && NARRATION_PREFIX_RE.test(text)) {
    return {
      ok: false,
      trigger: 'narration',
      reason: `short output (${text.length} chars) opens with narration phrase`,
    };
  }

  if (TRUNCATED_CLIP_RE.test(text)) {
    // Same idea as truncated_prose below: a long synthesis that dies cutting
    // off mid-{{clip:…}} is still far more valuable than Tier 2/3 recovery
    // (which often has less budget and returns worse or generic text). Only
    // treat mid-clip truncation as a hard failure for shorter outputs.
    if (trimmed.length >= SUBSTANTIVE_TEXT_FLOOR) {
      return { ok: true };
    }
    return {
      ok: false,
      trigger: 'truncated_clip',
      reason: 'output ends mid-clip-token (max_tokens truncation)',
    };
  }

  // Mid-prose truncation: short answer that doesn't end on terminal
  // punctuation/quote/bracket. Skipped for substantive answers
  // (>SUBSTANTIVE_TEXT_FLOOR chars) where re-running synthesis with even
  // less budget will probably make things worse, not better — better to
  // ship the long answer with a cosmetically blemished tail than try to
  // rewrite it. Also skipped when outputTokens are unreliable (synthesis
  // exception path) AND text is substantive — that means primary streamed
  // a real answer and just got cut at the wall-clock deadline.
  const tail = trimmed.slice(-3);
  const endsCleanly = TERMINAL_CHAR_RE.test(tail);
  if (!endsCleanly && trimmed.length > 200 && trimmed.length < SUBSTANTIVE_TEXT_FLOOR) {
    return {
      ok: false,
      trigger: 'truncated_prose',
      reason: `${trimmed.length}c output ends mid-sentence: "...${trimmed.slice(-50)}"`,
    };
  }

  return { ok: true };
}

module.exports = { evaluateSynthesisOutput };
