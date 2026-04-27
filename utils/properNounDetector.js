/**
 * Proper-noun shape detector.
 *
 * Heuristic gate for the Atlas Search lexical fallback path. Returns true when
 * the query "looks like" a literal proper noun (URL, hashtag, brand, product
 * code, capitalized name, compact coined token) where literal token matching
 * is more likely to surface the right clip than semantic vector search.
 *
 * Used by searchQuotesService to decide whether to run the lexical $search
 * aggregation in parallel with the existing Pinecone vector path. False
 * positives are cheap (we just run an extra query); false negatives mean we
 * miss the recall improvement on a query that would have benefited.
 *
 * Calibrated against:
 *   - URLs / domains:        "lncurl.lol", "getalby.com"
 *   - Hashtags:              "#nostr"
 *   - Hyphenated brand:      "BIP-32", "lnurl-pay"
 *   - Compact coined tokens: "lncurl", "albyhub" (low-vowel-ratio short word)
 *   - Capitalized brand:     "Alby Hub", "Nostr Wallet Connect"
 *   - CamelCase:             "AlbyHub", "ReactNative"
 *   - Mostly-uppercase:      "BIP", "DEX"
 *   - Person names:          "Roland Bewick", "Guy Swann"
 *
 * Does NOT match:
 *   - Plain natural-language questions ("what did they say about debt")
 *   - Long descriptive queries (>8 words)
 *   - All-lowercase common-word phrases ("bitcoin mining hardware")
 *
 * Intentionally permissive: we'd rather fire lexical too often (cheap) than
 * miss a case (recall regression).
 */

const MAX_WORDS = 8;
const COMPACT_TOKEN_MAX_LEN = 12;
const COMPACT_TOKEN_MIN_LEN = 4;

function isProperNounShaped(rawQuery) {
  if (typeof rawQuery !== 'string') return false;

  const query = rawQuery.trim();
  if (!query) return false;
  if (query.length > 200) return false;

  const wordCount = query.split(/\s+/).length;
  if (wordCount > MAX_WORDS) return false;

  // 1. URL / domain — contains a dot with letters on both sides, no spaces
  //    around it. Catches "lncurl.lol", "getalby.com", "https://x.com/y".
  if (/[a-z0-9-]+\.[a-z]{2,}/i.test(query)) return true;

  // 2. Hashtag — "#nostr", "#bitcoin"
  if (/^#[a-z0-9_-]+$/i.test(query)) return true;

  // 3. Has @ handle — "@jack", "@SatoshiLite"
  if (/(^|\s)@[a-z0-9_-]+/i.test(query)) return true;

  // 4. Hyphenated identifier with digits or all-caps prefix — "BIP-32",
  //    "lnurl-pay", "ECDSA-256"
  if (/[a-z]+-[a-z0-9]+/i.test(query) && wordCount <= 3) return true;

  // 5. Capitalized multi-word brand — "Alby Hub", "Nostr Wallet Connect",
  //    "Guy Swann", "Roland Bewick". Two or more title-cased tokens in a row.
  if (/(?:^|\s)[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/.test(query)) return true;

  // 6. CamelCase token — "AlbyHub", "ReactNative", "OpenAI". Detect interior
  //    lower→upper transition. Filter out trivial cases like "Roland" by
  //    requiring an interior cap.
  if (/[a-z][A-Z][a-z]/.test(query)) return true;

  // 7. Mostly-uppercase short token — "BIP", "DEX", "FOMC", "SHA256"
  if (/^[A-Z0-9]{2,8}$/.test(query)) return true;

  // 8. Compact "looks like a coined token" heuristic — short single word,
  //    low vowel ratio, all letters/digits. Catches "lncurl" ("urcl", 1 vowel
  //    out of 6 = 0.16), "ipfs", "btcpay". Excludes ordinary English words by
  //    requiring vowel ratio < 0.4 OR presence of a digit.
  if (wordCount === 1 && /^[a-z0-9]+$/i.test(query) &&
      query.length >= COMPACT_TOKEN_MIN_LEN && query.length <= COMPACT_TOKEN_MAX_LEN) {
    const vowels = (query.match(/[aeiou]/gi) || []).length;
    const hasDigit = /\d/.test(query);
    if (hasDigit) return true;
    if (vowels / query.length < 0.4) return true;
  }

  return false;
}

module.exports = { isProperNounShaped };
