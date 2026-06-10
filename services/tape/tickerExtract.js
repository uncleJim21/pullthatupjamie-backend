/**
 * Parse the trailing `## TICKERS` block out of a synthesis response, validate
 * the symbols, and return both the cleaned text (block removed) and the ordered
 * ticker list. Used by synthesize.js to populate the structured `tickers` field
 * (the "On the tape" strip) without leaking the block into the rendered text.
 *
 * Symbol forms accepted (Yahoo-typed): AAPL, BRK-B, BRK.B, ^TNX, ^GSPC,
 * DX-Y.NYB, CL=F, BTC-USD, GLD, TM.
 */

const { TICKERS_MARKER } = require('./tapePrompts');

const HEADER_RE = new RegExp(`^#{1,3}\\s*${TICKERS_MARKER}\\b.*$`, 'im');
// A single ticker token: optional ^, 1-5 alnum, then up to two .-= suffixes.
const TICKER_RE = /^\^?[A-Z][A-Z0-9]{0,4}(?:[.\-=][A-Z0-9]{1,4}){0,2}$/;
const STOPWORDS = new Set(['TICKERS', 'NONE', 'NA', 'N', 'A', 'THE', 'AND', 'ETC', 'TBD']);
const MAX_TICKERS = 8;

function isTicker(tok) {
  return TICKER_RE.test(tok) && /[A-Z]/.test(tok) && !STOPWORDS.has(tok);
}

/**
 * @param {string} rawText
 * @returns {{ cleanedText: string, tickers: string[] }}
 */
function extractTickers(rawText) {
  if (typeof rawText !== 'string' || !rawText) return { cleanedText: rawText || '', tickers: [] };
  const m = rawText.match(HEADER_RE);
  if (!m || m.index == null) return { cleanedText: rawText, tickers: [] };

  const cleanedText = rawText.slice(0, m.index).replace(/\s+$/, '');
  const block = rawText.slice(m.index + m[0].length);

  const seen = new Set();
  const tickers = [];
  for (const line of block.split('\n')) {
    // Strip bullet / list punctuation, then scan every token on the line so
    // both "- AAPL" and "AAPL, MSFT, GOOGL" forms are handled.
    const cleaned = line.replace(/^[\s\-*•\d.)]+/, '').trim();
    if (!cleaned) continue;
    for (const raw of cleaned.split(/[\s,|]+/)) {
      const tok = raw.toUpperCase().replace(/[.,;]+$/, '');
      if (isTicker(tok) && !seen.has(tok)) {
        seen.add(tok);
        tickers.push(tok);
        if (tickers.length >= MAX_TICKERS) break;
      }
    }
    if (tickers.length >= MAX_TICKERS) break;
  }
  return { cleanedText, tickers };
}

module.exports = { extractTickers, isTicker };
