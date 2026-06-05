/**
 * Semantic cache layer for the kind endpoints — lets "essentially the same"
 * query reuse a cached result even when the bytes differ ("spacex IPO" vs
 * "spacex ipo" vs "when is SpaceX going public").
 *
 * How: embed the query's free-text (ada-002), compare by cosine to the embeddings
 * of recent cached queries WITHIN the same hard scope (kind + prompt version +
 * asOfDate + model); a match ≥ threshold returns that query's cache key. No
 * LLM-per-comparison — just one embedding + an in-memory cosine scan.
 *
 * Storage is tiny and in-memory: ~6 KB per vector, LRU-capped per scope, wiped on
 * restart exactly like the result cache. `refresh:true` bypasses it upstream.
 *
 * Read-in is intentionally NOT semantically matched — tickers are exact symbols
 * (serving NVDA's read-in for an AVGO query would be a real error); free-text
 * kinds (brief / split / narrative / dossier) are where this helps.
 */

const ENABLED = process.env.TAPE_SEMANTIC_CACHE !== 'false';
const THRESHOLD = parseFloat(process.env.TAPE_SEMANTIC_CACHE_THRESHOLD || '0.93');
const MAX_PER_SCOPE = parseInt(process.env.TAPE_SEMANTIC_CACHE_MAX || '2000', 10);
const EMB_MODEL = process.env.TAPE_SEMANTIC_CACHE_MODEL || 'text-embedding-ada-002';

// scope string -> [{ emb: Float32Array, key, t }]
const index = new Map();

function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

/** The free-text to match on, per kind. Empty string → skip semantic matching. */
function semanticText(kind, body = {}) {
  switch (kind) {
    case 'brief': return norm(body.topic);
    case 'split': return norm([body.personA, body.personB, body.topic].filter(Boolean).join(' | '));
    case 'narrative': return norm([body.topic, body.group].filter(Boolean).join(' | '));
    case 'dossier': return norm(body.person);
    default: return ''; // readin (tickers are exact) and anything else
  }
}

/** Hard-key fields that must match exactly for two queries to be interchangeable. */
function scopeOf(kind, body = {}, promptVersion = '') {
  return [kind, promptVersion, body.asOfDate || '', body.model || 'default'].join('|');
}

async function embed(text, openai) {
  if (!text || !openai) return null;
  try {
    const r = await openai.embeddings.create({ model: EMB_MODEL, input: text });
    const v = r && r.data && r.data[0] && r.data[0].embedding;
    return Array.isArray(v) ? Float32Array.from(v) : null;
  } catch (_) { return null; }
}

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/** Nearest cached query in `scope` ≥ threshold → { key, sim }, else null. */
function lookup(scope, emb) {
  if (!emb) return null;
  const arr = index.get(scope);
  if (!arr || !arr.length) return null;
  let best = null; let bestSim = -1;
  for (const e of arr) { const s = cosine(emb, e.emb); if (s > bestSim) { bestSim = s; best = e; } }
  return (best && bestSim >= THRESHOLD) ? { key: best.key, sim: bestSim } : null;
}

/** Record a query embedding → its cache key (LRU-capped per scope). */
function remember(scope, emb, key) {
  if (!emb || !key) return;
  let arr = index.get(scope);
  if (!arr) { arr = []; index.set(scope, arr); }
  const i = arr.findIndex((e) => e.key === key);
  if (i >= 0) arr.splice(i, 1); // refresh position
  arr.push({ emb, key, t: Date.now() });
  if (arr.length > MAX_PER_SCOPE) arr.splice(0, arr.length - MAX_PER_SCOPE);
}

/** Drop a mapping whose cached value has since expired. */
function forget(scope, key) {
  const arr = index.get(scope);
  if (!arr) return;
  const i = arr.findIndex((e) => e.key === key);
  if (i >= 0) arr.splice(i, 1);
}

module.exports = { ENABLED, THRESHOLD, semanticText, scopeOf, embed, lookup, remember, forget };
