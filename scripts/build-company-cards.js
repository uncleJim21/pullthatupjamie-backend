#!/usr/bin/env node
/**
 * Build config/tape-company-cards.yaml for the Tape company-card layer.
 *
 *   node scripts/build-company-cards.js              # all, skip existing
 *   node scripts/build-company-cards.js --force      # rebuild every ticker
 *   node scripts/build-company-cards.js --limit 10   # first N (smoke)
 *   node scripts/build-company-cards.js --no-llm     # Finnhub backbone only
 *
 * Per ticker:
 *   - Finnhub profile2  → name, industry, marketCap, weburl, exchange (RELIABLE)
 *   - gpt-4o-mini batch → description, products[], execs[] (BEST-EFFORT; the
 *     prompt is conservative — leave fields empty rather than guess).
 *
 * Finnhub free tier is ~60 calls/min, so calls are spaced ~1.1s. Idempotent:
 * existing cards are preserved unless --force.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { OpenAI } = require('openai');

const OUT = path.join(__dirname, '..', 'config', 'tape-company-cards.yaml');
const FINNHUB = 'https://finnhub.io/api/v1';
const LLM_MODEL = process.env.TAPE_CARD_LLM_MODEL || 'gpt-4o-mini';
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const optN = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) : d; };
const optList = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null; };
const BUILD_TS = new Date().toISOString(); // stamps builtAt so the hydration job can find stale cards

// ~250 top US-listed names across sectors + the Tape demo set. Edit freely.
const UNIVERSE = [
  // Mega-cap tech / AI
  'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'AMD', 'INTC', 'QCOM', 'TXN', 'MU', 'AMAT', 'LRCX', 'KLAC', 'ARM', 'PLTR', 'SNOW', 'NOW', 'PANW', 'CRWD', 'NET', 'DDOG', 'ZS', 'SNPS', 'CDNS', 'ANET', 'DELL', 'HPQ', 'IBM', 'CSCO', 'SMCI', 'CRWV', 'APP', 'TTD', 'U', 'RBLX', 'SHOP', 'UBER', 'ABNB', 'DASH', 'SPOT', 'COIN', 'HOOD', 'SQ', 'PYPL', 'MSTR',
  // Comms / media
  'NFLX', 'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'WBD', 'PARA', 'EA', 'TTWO',
  // Consumer
  'WMT', 'COST', 'TGT', 'HD', 'LOW', 'NKE', 'SBUX', 'MCD', 'KO', 'PEP', 'PG', 'CL', 'MDLZ', 'KHC', 'GIS', 'PM', 'MO', 'EL', 'LULU', 'CMG', 'YUM', 'DPZ', 'ULTA', 'DG', 'DLTR', 'KR', 'F', 'GM',
  // Financials
  'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BLK', 'SCHW', 'AXP', 'V', 'MA', 'SPGI', 'CME', 'ICE', 'COF', 'USB', 'PNC', 'TFC', 'BX', 'KKR', 'APO', 'BRK.B',
  // Healthcare / biotech
  'UNH', 'JNJ', 'LLY', 'PFE', 'MRK', 'ABBV', 'TMO', 'ABT', 'DHR', 'BMY', 'AMGN', 'GILD', 'VRTX', 'REGN', 'MRNA', 'BIIB', 'ISRG', 'MDT', 'SYK', 'BSX', 'CVS', 'CI', 'HUM', 'ZTS',
  // Industrials
  'CAT', 'DE', 'BA', 'GE', 'HON', 'RTX', 'LMT', 'NOC', 'GD', 'MMM', 'UPS', 'FDX', 'UNP', 'CSX', 'EMR', 'ETN', 'PH', 'ITW', 'GEV',
  // Energy
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY', 'PSX', 'MPC', 'VLO', 'WMB', 'KMI', 'LNG', 'HAL', 'DVN', 'FANG',
  // Utilities / nuclear / power
  'CEG', 'VST', 'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'OKLO', 'SMR', 'CCJ',
  // Materials / commodities-linked equities
  'LIN', 'SHW', 'FCX', 'NEM', 'GOLD', 'NUE', 'DOW', 'GLW',
  // Real estate
  'PLD', 'AMT', 'EQIX', 'O', 'SPG',
  // Autos / EV / mobility
  'TSLA', 'RIVN', 'LCID',
  // China tech (US-listed ADRs)
  'BABA', 'PDD', 'JD', 'BIDU', 'NIO',
  // ETFs / commodity proxies in the demo set
  'IBIT', 'GLD',
  // User-added (2026-06-05): biotech + optics/semis
  'TVTX', 'AXSM', 'VKTX', 'CRSP', 'NTLA', 'INSM', 'ALNY', 'SRPT', 'ARWR',
  'COHR', 'TTMI', 'TSM',
  // +20 biotech (2026-06-05)
  'BEAM', 'RXRX', 'EXEL', 'INCY', 'BMRN', 'NBIX', 'RARE', 'IONS', 'HALO', 'CYTK',
  'MDGL', 'KRYS', 'APLS', 'ARGX', 'DNLI', 'TGTX', 'AGIO', 'RVMD', 'ARVN', 'NVAX',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function finnhubProfile(symbol, key) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const resp = await fetch(`${FINNHUB}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`);
      if (resp.status === 429) { await sleep(2000); continue; }
      if (!resp.ok) return null;
      const j = await resp.json();
      if (!j || !j.name) return null;
      return {
        name: j.name,
        industry: j.finnhubIndustry || null,
        marketCap: j.marketCapitalization ? Math.round(j.marketCapitalization) : null,
        weburl: j.weburl || null,
        exchange: j.exchange || null,
      };
    } catch (_) { await sleep(1000); }
  }
  return null;
}

const ENRICH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['ticker', 'description', 'products', 'execs'],
        properties: {
          ticker: { type: 'string' },
          description: { type: 'string', description: '1-2 sentence plain-English summary of what the company does' },
          products: { type: 'array', items: { type: 'string' }, description: '3-6 flagship products / business segments / brands' },
          execs: { type: 'array', items: { type: 'string' }, description: 'current CEO and at most 1-2 other widely-known executives, full names' },
        },
      },
    },
  },
};

async function enrichBatch(openai, batch) {
  const list = batch.map((b) => `${b.ticker} = ${b.name}${b.industry ? ` [${b.industry}]` : ''}`).join('\n');
  const system = `You produce concise reference cards for well-known public companies. For each ticker return a 1-2 sentence description of what it does, 3-6 flagship products/segments/brands, and the current CEO (plus at most 1-2 other widely-known executives) by full name.
CRITICAL: only state facts you are confident are current and correct. If you are unsure of a company's executives or products, return an EMPTY array for that field rather than guessing — a wrong CEO name or product is worse than an empty list. Do not invent.`;
  const resp = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Produce cards for:\n${list}` },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'company_cards', strict: true, schema: ENRICH_SCHEMA } },
    temperature: 0.1,
    max_tokens: 4000,
  });
  const parsed = JSON.parse(resp.choices[0].message.content || '{"cards":[]}');
  const byTicker = new Map();
  for (const c of parsed.cards || []) byTicker.set(String(c.ticker).toUpperCase(), c);
  return byTicker;
}

async function main() {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) { console.error('FINNHUB_API_KEY not set'); process.exit(2); }
  const useLlm = !has('--no-llm');
  const openai = useLlm ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  if (useLlm && !process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set (or pass --no-llm)'); process.exit(2); }

  const existing = fs.existsSync(OUT) ? (yaml.load(fs.readFileSync(OUT, 'utf8')) || {}) : {};
  const force = has('--force');
  const only = optList('--only'); // rebuild just these (used by the hydration job)
  let universe = only && only.length ? only : [...new Set(UNIVERSE)];
  const limit = optN('--limit', 0);
  if (limit > 0) universe = universe.slice(0, limit);
  const todo = force ? universe : universe.filter((t) => !existing[t]);
  console.log(`Universe ${universe.length}, building ${todo.length} (skipping ${universe.length - todo.length} existing). LLM: ${useLlm ? LLM_MODEL : 'off'}`);

  // 1) Finnhub backbone (throttled).
  const backbone = {};
  let i = 0;
  for (const t of todo) {
    i += 1;
    const p = await finnhubProfile(t, key);
    if (p) backbone[t] = p;
    else console.warn(`  ! ${t}: no Finnhub profile`);
    if (i % 25 === 0) console.log(`  finnhub ${i}/${todo.length}`);
    await sleep(1100); // ~55/min, under the 60/min free cap
  }

  // 2) LLM enrichment in batches of 12.
  const enrich = new Map();
  if (useLlm) {
    const have = todo.filter((t) => backbone[t]).map((t) => ({ ticker: t, ...backbone[t] }));
    for (let b = 0; b < have.length; b += 12) {
      const batch = have.slice(b, b + 12);
      try { const m = await enrichBatch(openai, batch); for (const [k, v] of m) enrich.set(k, v); }
      catch (e) { console.warn(`  ! enrich batch ${b}: ${e.message}`); }
      console.log(`  enrich ${Math.min(b + 12, have.length)}/${have.length}`);
    }
  }

  // 3) Merge → cards.
  const out = { ...existing };
  for (const t of todo) {
    const bb = backbone[t];
    if (!bb) continue;
    const e = enrich.get(t) || {};
    out[t] = {
      name: bb.name,
      industry: bb.industry,
      marketCap: bb.marketCap,
      weburl: bb.weburl,
      ...(e.description ? { description: e.description } : {}),
      ...(Array.isArray(e.products) && e.products.length ? { products: e.products } : {}),
      ...(Array.isArray(e.execs) && e.execs.length ? { execs: e.execs } : {}),
      source: useLlm ? 'finnhub+llm' : 'finnhub',
      builtAt: BUILD_TS,
    };
  }

  // Stable sort by ticker for a clean diff.
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `# Tape company cards — built by scripts/build-company-cards.js\n# Backbone (name/industry/marketCap/weburl) from Finnhub; description/products/execs LLM-drafted (verify before trusting).\n${yaml.dump(sorted, { lineWidth: 120 })}`);
  console.log(`\nWrote ${Object.keys(sorted).length} cards → ${OUT}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
