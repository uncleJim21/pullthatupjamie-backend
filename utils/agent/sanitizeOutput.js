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
 *
 * For SSE streaming we also expose `createStreamSanitizer()` — a stateful
 * wrapper that buffers text across deltas so an open tag in chunk N and its
 * close in chunk N+M are recognized as a single block and stripped together.
 * Without this, paired-pattern regexes only fire on the final `text_done`
 * payload and raw markup leaks through every intermediate `text_delta`.
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

/**
 * Strip block + orphan markup but preserve whitespace exactly. Used by the
 * streaming sanitizer where each delta is a *fragment* of the final text —
 * trimming or collapsing would mangle word boundaries across chunks (e.g.
 * "Hello " + "world" would emit as "Helloworld").
 */
function stripMarkupOnly(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const pattern of STRIP_BLOCK_PATTERNS) out = out.replace(pattern, '');
  for (const pattern of STRIP_TAG_PATTERNS) out = out.replace(pattern, '');
  return out;
}

function sanitizeAgentText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  // Document-level cleanup: strip markup, then collapse the empty paragraphs
  // it leaves behind and trim leading/trailing whitespace so the final
  // payload reads cleanly. Do NOT use this on streaming fragments.
  return stripMarkupOnly(text).replace(/\n{3,}/g, '\n\n').trim();
}

function hasToolCallMarkup(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (const pattern of ALL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Streaming sanitizer
// ---------------------------------------------------------------------------

// Literal open/close pairs the streaming sanitizer recognizes. The open
// literal is what we look for both as a complete substring and as a partial
// suffix of the carry buffer (so we can hold back a chunk that ends with
// just `<｜DSM` until the next chunk arrives). Tag-like opens (`<invoke`,
// `<parameter`) are stored without their trailing `>` because they accept
// attributes before the close bracket.
const STREAM_BLOCK_MARKERS = [
  [`<${FULL_BAR}DSML${FULL_BAR}tool_calls>`, `</${FULL_BAR}DSML${FULL_BAR}tool_calls>`],
  [`<${FULL_BAR}DSML${FULL_BAR}invoke`,      `</${FULL_BAR}DSML${FULL_BAR}invoke>`],
  [`<${FULL_BAR}DSML${FULL_BAR}parameter`,   `</${FULL_BAR}DSML${FULL_BAR}parameter>`],
  ['<function_calls>',                        '</function_calls>'],
  ['<tool_calls>',                            '</tool_calls>'],
  ['<tool_call>',                             '</tool_call>'],
  ['<function_call>',                         '</function_call>'],
  ['<invoke',                                 '</invoke>'],
  ['<parameter',                              '</parameter>'],
];

const STREAM_OPEN_LITERALS = STREAM_BLOCK_MARKERS.map(([open]) => open);

// Cap on the carry buffer. If a single in-flight block grows past this, we
// give up holding it and flush the contents through the regular sanitizer.
// 8KB is comfortably larger than any realistic tool-call payload but small
// enough that a runaway hold would surface quickly in logs.
const MAX_STREAM_CARRY = 8192;

/**
 * Find the index of the earliest *unclosed* tracked open literal in `buf`,
 * or -1 if every open we see has its matching close already in the buffer.
 */
function findEarliestUnclosedOpen(buf) {
  let earliest = -1;
  for (const [open, close] of STREAM_BLOCK_MARKERS) {
    let from = 0;
    while (from < buf.length) {
      const openIdx = buf.indexOf(open, from);
      if (openIdx === -1) break;
      const closeIdx = buf.indexOf(close, openIdx + open.length);
      if (closeIdx === -1) {
        if (earliest === -1 || openIdx < earliest) earliest = openIdx;
        break;
      }
      from = closeIdx + close.length;
    }
  }
  return earliest;
}

/**
 * Find the longest non-empty prefix of any tracked open literal that
 * matches the *tail* of `buf`. Returns the length to hold back (0 = none).
 *
 * Example: buf="hello world <｜DSM" with open="<｜DSML｜tool_calls>" should
 * return 5 (the trailing "<｜DSM" could become "<｜DSML｜tool_calls>" once
 * the next delta arrives, so we don't ship it yet).
 */
function findTrailingPartialOpenLength(buf) {
  if (!buf.length) return 0;
  let maxHold = 0;
  for (const open of STREAM_OPEN_LITERALS) {
    const upTo = Math.min(open.length - 1, buf.length);
    for (let k = upTo; k > maxHold; k--) {
      if (buf.endsWith(open.slice(0, k))) {
        maxHold = k;
        break;
      }
    }
  }
  return maxHold;
}

/**
 * Pure-functional streaming step. Given the current carry-buffer and a new
 * delta, return the text safe to emit *now* and the new carry-buffer.
 *
 * Caller should track the returned `pending` per-request and call `flush`
 * once the upstream stream signals completion (text_done / error / abort).
 */
function sanitizeStreamDelta(pending, delta) {
  const buf = (pending || '') + (delta || '');
  if (!buf.length) return { emit: '', pending: '' };

  // Runaway guard: if the carry has grown past MAX_STREAM_CARRY we likely
  // mis-classified a `<` somewhere. Flush whatever we have as a fragment
  // (no trim/collapse — this is a stream chunk, not a document) rather
  // than holding indefinitely.
  if (buf.length > MAX_STREAM_CARRY) {
    return { emit: stripMarkupOnly(buf), pending: '' };
  }

  let cutoff = findEarliestUnclosedOpen(buf);
  if (cutoff === -1) {
    // No in-flight block; only hold the trailing chars that *could* be
    // the start of a tracked open literal in the next delta.
    const holdLen = findTrailingPartialOpenLength(buf);
    cutoff = buf.length - holdLen;
  }
  const safe = buf.slice(0, cutoff);
  const carry = buf.slice(cutoff);
  return { emit: stripMarkupOnly(safe), pending: carry };
}

/**
 * Stateful factory: returns `{ feed, flush }` bound to a private carry
 * buffer. Convenient for SSE handlers that want to stay agnostic of the
 * underlying carry semantics.
 *
 *   const stream = createStreamSanitizer();
 *   for (const delta of deltas) socket.write(stream.feed(delta));
 *   socket.write(stream.flush());
 */
function createStreamSanitizer() {
  let pending = '';
  return {
    feed(delta) {
      const { emit, pending: nextPending } = sanitizeStreamDelta(pending, delta);
      pending = nextPending;
      return emit;
    },
    flush() {
      // Stream is ending. Whatever's in the carry is either:
      // 1) Legit prose that happens to begin/end with `<` (treat as text).
      // 2) An open marker that never got its close (broken markup; the
      //    orphan-tag pass at least drops complete stray opens).
      // Either way, don't trim/collapse — the caller will run the full
      // document sanitizer on the canonical `text_done` payload.
      const out = stripMarkupOnly(pending);
      pending = '';
      return out;
    },
    peekPending() {
      return pending;
    },
  };
}

module.exports = {
  sanitizeAgentText,
  hasToolCallMarkup,
  sanitizeStreamDelta,
  createStreamSanitizer,
};
