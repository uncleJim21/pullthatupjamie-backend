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
 * narration-only short outputs ("Let me grab more context...").
 *
 * Drives the Tier 1/2/3 recovery flow in agentChatRoutes.js. See
 * docs/WIP/SYNTHESIS_FAILURE_RECOVERY_PLAN.md.
 */

const { hasToolCallMarkup } = require('./sanitizeOutput');

// Thresholds are env-configurable to allow tuning without code edits.
const LOW_TOKEN_THRESHOLD = parseInt(process.env.AGENT_SYNTHESIS_MIN_OUTPUT_TOKENS || '250', 10);
const SHORT_TEXT_THRESHOLD = parseInt(process.env.AGENT_SYNTHESIS_MIN_TEXT_LEN || '500', 10);

// Narration-prefix patterns — these strings open responses where the model
// gave up partway and emitted preamble in lieu of a real answer.
const NARRATION_PREFIX_RE = /^\s*(let me\b|i'?ll\b|i'?m going to\b|i'?m about to\b|now let me\b|first,? let me\b|allow me to\b|let'?s grab\b|let'?s see\b|let'?s look\b|let'?s |perfect[!.]|great[!.]|ok(?:ay)?[,!.])/i;

// Mid-clip-token truncation (e.g. "{{clip:9fd5e7dc-72de-11f0-9be" with no
// closing braces). Caused by maxTokens cutting the response mid-UUID.
const TRUNCATED_CLIP_RE = /\{\{clip:[^}]*$/;

/**
 * @param {{ text: string, outputTokens?: number }} input
 * @returns {{ ok: boolean, trigger?: string, reason?: string }}
 */
function evaluateSynthesisOutput({ text, outputTokens } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, trigger: 'empty', reason: 'no usable text emitted' };
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
    return {
      ok: false,
      trigger: 'truncated_clip',
      reason: 'output ends mid-clip-token (max_tokens truncation)',
    };
  }

  return { ok: true };
}

module.exports = { evaluateSynthesisOutput };
