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

// Indexed clip references that synthesis models sometimes emit instead of the
// correct {{clip:shareLink}} format. Strip them so they don't render as literal
// text in the UI. Examples: [[CLIP:0]], [CLIP:1], (clip 2), [[clip:3]]
const INDEXED_CLIP_RE = /\[\[clip:\d+\]\]|\[clip:\d+\]|\(clip\s*\d+\)/gi;

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
  // Document-level cleanup: strip markup and indexed clip refs, then collapse
  // empty paragraphs and trim. Do NOT use this on streaming fragments.
  return stripMarkupOnly(text)
    .replace(INDEXED_CLIP_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

// Narration phrases that signal a model "thinking aloud" rather than answering.
// Applied line-by-line to live token streams so sycophantic openers never reach
// the client even when streaming directly (no buffer-then-flush).
const NARRATION_LINE_RE = /^\s*(let me\b|i'?ll\b|i'?m going to\b|i'?m about to\b|now let me\b|first,? let me\b|allow me to\b|let'?s grab\b|let'?s see\b|let'?s look\b|let'?s \w|perfect[!.,]|great[!.,]|ok(?:ay)?[,!.]\s|excellent[!.,]|interesting[!.,]|hmm\b|based on (the|my|these|our)\b|here'?s what (i found|i have|we have)\b|now,?\s+i'?ve\b|i (can see|have found|have gathered|have compiled|now have|found)\b|i'?ve (found|gathered|compiled|now got)\b)/i;

// How many characters to buffer at the start of each line before deciding
// it is not narration. 60 chars covers all known narration openers and is
// imperceptibly short for the user (~2–4 tokens at typical token sizes).
const NARRATION_DETECT_WINDOW = 60;

/**
 * Create a streaming narration filter. Buffers the opening characters of each
 * line to detect sycophantic/narration prefixes and drops those lines entirely.
 * Non-narration content is forwarded to `onEmit` character-by-character as
 * tokens arrive — no end-of-response flush required.
 *
 * @param {(text: string) => void} onEmit  called with safe text fragments
 * @returns {{ feed(chunk: string): void, flush(): void }}
 */
function createNarrationFilter(onEmit) {
  let lineBuf = '';     // characters buffered at line start for narration detection
  let decided = false;  // true once we've resolved emit/suppress for the current line
  let suppress = false; // true when current line is narration

  return {
    feed(chunk) {
      for (const ch of chunk) {
        if (ch === '\n') {
          if (!suppress) {
            if (lineBuf) onEmit(lineBuf);
            onEmit('\n');
          }
          lineBuf = '';
          decided = false;
          suppress = false;
          continue;
        }

        if (decided) {
          if (!suppress) onEmit(ch);
        } else {
          lineBuf += ch;
          if (NARRATION_LINE_RE.test(lineBuf)) {
            suppress = true;
            decided = true;
            lineBuf = '';
          } else if (lineBuf.length >= NARRATION_DETECT_WINDOW) {
            // No narration pattern found in the detection window — safe to emit.
            onEmit(lineBuf);
            lineBuf = '';
            decided = true;
            suppress = false;
          }
        }
      }
    },

    flush() {
      if (!suppress && lineBuf) {
        onEmit(lineBuf);
        lineBuf = '';
      }
    },
  };
}

/**
 * Validate and correct {{clip:ID}} tokens in synthesis output against the
 * known clipCache (shareLink → metadata map populated by search_quotes results).
 *
 * Models like nano occasionally:
 *   1. Prepend whitespace inside the token: {{clip: https___...}}
 *   2. Concatenate two paragraph IDs: {{clip:abc_p380_p368}} (hybrid of _p380 and _p368)
 *   3. Fabricate IDs entirely
 *
 * Fix strategy per token:
 *   a) Trim whitespace from the extracted ID.
 *   b) If the trimmed ID exists in clipCache → emit as-is.
 *   c) If not, repeatedly strip the last `_pN` segment and retry until a
 *      valid prefix is found or we run out of segments.
 *   d) If no match found → remove the {{clip:...}} token entirely (don't
 *      silently emit a broken reference that renders as "Loading...").
 *
 * @param {string} text       Raw synthesis text containing {{clip:...}} tokens.
 * @param {Map<string, *>} clipCache  shareLink → metadata from search_quotes.
 * @returns {string}          Cleaned text with validated/corrected clip tokens.
 */
function scrubClipIds(text, clipCache) {
  if (!clipCache || clipCache.size === 0) return text;

  return text.replace(/\{\{clip:([^}]*)\}\}/g, (match, rawId) => {
    const id = rawId.trim();
    if (!id) return ''; // empty token

    // Exact match
    if (clipCache.has(id)) return `{{clip:${id}}}`;

    // Try stripping trailing _pN segments (handles hybrid IDs like _p380_p368)
    let candidate = id;
    while (true) {
      const stripped = candidate.replace(/_p\d+$/, '');
      if (stripped === candidate) break; // no more _pN to strip
      candidate = stripped;
      if (clipCache.has(candidate)) {
        return `{{clip:${candidate}}}`;
      }
    }

    // No valid ID found — remove the token rather than emit a broken reference.
    return '';
  });
}

module.exports = {
  sanitizeAgentText,
  hasToolCallMarkup,
  sanitizeStreamDelta,
  createStreamSanitizer,
  createNarrationFilter,
  scrubClipIds,
};
