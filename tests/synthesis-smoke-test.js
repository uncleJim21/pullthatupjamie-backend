#!/usr/bin/env node

/**
 * Synthesis Model Smoke Test
 *
 * Fires a minimal "Say hello." completion at each candidate synthesis
 * model via OpenRouter to confirm the model ID + auth + upstream routing
 * are all healthy before kicking off a multi-run benchmark.
 *
 * Why: the benchmark cohort takes ~10–15 minutes per run × 3 runs. A bad
 * model ID or a flat OPENROUTER_API_KEY is much cheaper to discover here
 * than mid-cohort.
 *
 * Usage:
 *   node tests/synthesis-smoke-test.js
 *
 * Exits 0 on full success, 1 on any failure (so it can gate a CI job).
 *
 * Models tested are read from AGENT_MODELS (filtered to OpenRouter +
 * the synthesis-only candidates we register in this branch). To extend
 * the list, register the model in constants/agentModels.js and add its
 * key to SYNTHESIS_MODEL_KEYS below.
 */

require('dotenv').config();

const OpenRouterProvider = require('../utils/agent/providers/openRouterProvider');
const { AGENT_MODELS } = require('../constants/agentModels');

// Synthesis-only candidates being benchmarked. Keep this list narrow —
// we only want to verify the models the benchmark will actually exercise.
const SYNTHESIS_MODEL_KEYS = [
  'gemma4-31b-or',
  'qwen3-next-80b',
];

const HELLO_PROMPT = 'Reply with exactly the two words: hello world';

async function smokeOne(provider, modelKey) {
  const cfg = AGENT_MODELS[modelKey];
  if (!cfg) {
    return { modelKey, ok: false, error: `unknown model key in AGENT_MODELS: ${modelKey}` };
  }

  const started = Date.now();
  try {
    const resp = await provider.createResponse({
      model: cfg.id,
      maxTokens: 16,
      system: 'You are a smoke test. Respond minimally.',
      messages: [{ role: 'user', content: HELLO_PROMPT }],
      tools: [],
      requestId: `smoke-${modelKey}`,
    });
    const latencyMs = Date.now() - started;
    const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) {
      return { modelKey, modelId: cfg.id, label: cfg.label, ok: false, latencyMs,
        error: 'empty response (no text content blocks)' };
    }
    return {
      modelKey,
      modelId: cfg.id,
      label: cfg.label,
      ok: true,
      latencyMs,
      preview: text.substring(0, 80),
      usage: resp.usage,
    };
  } catch (err) {
    return {
      modelKey,
      modelId: cfg.id,
      label: cfg.label,
      ok: false,
      latencyMs: Date.now() - started,
      error: err.message,
    };
  }
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('\x1b[31m✘ OPENROUTER_API_KEY is not set in env — smoke test cannot run\x1b[0m');
    process.exit(1);
  }

  const provider = new OpenRouterProvider();
  const validated = await provider.validate();
  if (!validated) {
    console.error('\x1b[31m✘ OpenRouter /models endpoint did not validate — check OPENROUTER_API_KEY\x1b[0m');
    process.exit(1);
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║         Synthesis Model Smoke Test (OpenRouter)         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`Provider validated. Testing ${SYNTHESIS_MODEL_KEYS.length} model(s):\n`);

  const results = [];
  for (const key of SYNTHESIS_MODEL_KEYS) {
    process.stdout.write(`  • ${key.padEnd(20)} `);
    const r = await smokeOne(provider, key);
    results.push(r);
    if (r.ok) {
      console.log(`\x1b[32m✔\x1b[0m  ${r.modelId} (${r.latencyMs}ms) — "${r.preview.replace(/\s+/g, ' ')}"`);
    } else {
      console.log(`\x1b[31m✘\x1b[0m  ${r.modelId || '?'} (${r.latencyMs || 0}ms) — ${r.error}`);
    }
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) {
    console.log('\n\x1b[32m✔ All synthesis models OK — safe to run benchmark.\x1b[0m\n');
    process.exit(0);
  } else {
    console.log(`\n\x1b[31m✘ ${failed.length}/${results.length} model(s) failed — fix before running benchmark.\x1b[0m`);
    for (const r of failed) {
      console.log(`  - ${r.modelKey} (${r.modelId || '?'}): ${r.error}`);
    }
    console.log();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\x1b[31mSmoke test crashed:\x1b[0m', err);
  process.exit(1);
});
