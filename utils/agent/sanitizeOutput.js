'use strict';

/**
 * Strip provider-specific tool-call markup that occasionally leaks into the
 * model's text output.
 *
 * Most common cause: the model is asked to write a tool-less synthesis
 * answer but the underlying provider (DeepSeek today, others tomorrow) falls
 * back to inlining its native tool-call DSL when the API tool surface is
 * removed mid-conversation. We sanitize defensively at every text emission
 * path so client code never sees raw markup, regardless of which provider
 * misbehaves.
 *
 * Patterns covered:
 *  - DeepSeek DSML (uses full-width vertical bar U+FF5C, not ASCII pipe)
 *      <｜DSML｜tool_calls> ... </｜DSML｜tool_calls>
 *      <｜DSML｜invoke name="..."> ... </｜DSML｜invoke>
 *      <｜DSML｜parameter ...> ... </｜DSML｜parameter>
 *  - Anthropic legacy XML
 *      <function_calls><invoke name="..."><parameter ...>...</parameter></invoke></function_calls>
 *  - Generic / OpenAI-style wrappers
 *      <tool_calls> / <tool_call>, <function_call>
 */

const FULL_BAR = '\uFF5C'; // U+FF5C FULLWIDTH VERTICAL LINE

// Block-level patterns: paired open/close, removed wholesale (greedy non-greedy).
const STRIP_BLOCK_PATTERNS = [
  // DeepSeek DSML
  new RegExp(`<${FULL_BAR}DSML${FULL_BAR}tool_calls>[\\s\\S]*?<\\/${FULL_BAR}DSML${FULL_BAR}tool_calls>`, 'g'),
  new RegExp(`<${FULL_BAR}DSML${FULL_BAR}invoke[^>]*>[\\s\\S]*?<\\/${FULL_BAR}DSML${FULL_BAR}invoke>`, 'g'),
  new RegExp(`<${FULL_BAR}DSML${FULL_BAR}parameter[^>]*>[\\s\\S]*?<\\/${FULL_BAR}DSML${FULL_BAR}parameter>`, 'g'),

  // Anthropic legacy XML (also the antml: namespaced variant some forks emit)
  /<function_calls>[\s\S]*?<\/function_calls>/g,
  /<function_calls>[\s\S]*?<\/antml:function_calls>/g,
  /<invoke\b[^>]*>[\s\S]*?<\/invoke>/g,
  /<invoke\b[^>]*>[\s\S]*?<\/antml:invoke>/g,
  /<parameter\b[^>]*>[\s\S]*?<\/parameter>/g,
  /<parameter\b[^>]*>[\s\S]*?<\/antml:parameter>/g,

  // Generic tool/function call wrappers
  /<tool_calls>[\s\S]*?<\/tool_calls>/g,
  /<tool_call>[\s\S]*?<\/tool_call>/g,
  /<function_call>[\s\S]*?<\/function_call>/g,
];

// Stray-tag patterns: clean up orphan opens/closes left behind after an
// incomplete or mid-stream truncation.
const STRIP_TAG_PATTERNS = [
  new RegExp(`<\\/?${FULL_BAR}DSML${FULL_BAR}[^>]*>`, 'g'),
  /<\/?function_calls>/g,
  /<\/?tool_calls>/g,
  /<\/?tool_call>/g,
  /<\/?function_call>/g,
  /<\/?invoke\b[^>]*>/g,
  /<\/?parameter\b[^>]*>/g,
  /<\/?antml:function_calls>/g,
  /<\/?antml:invoke\b[^>]*>/g,
  /<\/?antml:parameter\b[^>]*>/g,
];

const ALL_PATTERNS = [...STRIP_BLOCK_PATTERNS, ...STRIP_TAG_PATTERNS];

function sanitizeAgentText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const pattern of STRIP_BLOCK_PATTERNS) out = out.replace(pattern, '');
  for (const pattern of STRIP_TAG_PATTERNS) out = out.replace(pattern, '');
  // Collapse the empty paragraphs left behind so the result reads cleanly.
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

function hasToolCallMarkup(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (const pattern of ALL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

module.exports = { sanitizeAgentText, hasToolCallMarkup };
