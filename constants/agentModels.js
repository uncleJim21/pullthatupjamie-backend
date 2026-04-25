/**
 * Agent model/provider registry and execution profile controls.
 *
 * Notes:
 * - Keep legacy "fast"/"quality" aliases for backward compatibility.
 * - Gemma defaults can be overridden via env without code edits.
 */

// Latency budgets are wall-clock from agent start to current loop check.
// They drive the same SYSTEM-marker mechanism as cost budgets: soft injects
// a "wrap up next round" hint, hard exits the orchestration loop.
// Per-request overrides accepted via body.latencyBudgetSoftMs / latencyBudgetHardMs.
const EXECUTION_PROFILES = {
  default: {
    maxToolRounds: 6,
    costBudgetSoft: 0.055,
    costBudgetHard: 0.08,
    latencyBudgetSoftMs: 25_000,
    latencyBudgetHardMs: 40_000,
    label: 'Default',
  },
  'deep-turns': {
    maxToolRounds: 10,
    costBudgetSoft: 0.08,
    costBudgetHard: 0.12,
    latencyBudgetSoftMs: 60_000,
    latencyBudgetHardMs: 90_000,
    label: 'Deep Turns',
  },
};

const AGENT_MODELS = {
  fast: {
    key: 'fast',
    provider: 'anthropic',
    id: 'claude-haiku-4-5-20251001',
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    label: 'Haiku 4.5',
  },
  quality: {
    key: 'quality',
    provider: 'anthropic',
    id: 'claude-sonnet-4-6',
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    label: 'Sonnet 4.6',
  },
  gemma: {
    key: 'gemma',
    provider: 'tinfoil',
    id: process.env.TINFOIL_GEMMA_MODEL || 'gemma4-31b',
    // Tinfoil list price as of 2026-04 (per 1M tokens).
    inputPer1M: parseFloat(process.env.TINFOIL_GEMMA_INPUT_PER_1M || '0.45'),
    outputPer1M: parseFloat(process.env.TINFOIL_GEMMA_OUTPUT_PER_1M || '1.00'),
    label: 'Gemma (Tinfoil)',
  },
  'kimi-k2-6': {
    key: 'kimi-k2-6',
    provider: 'tinfoil',
    id: process.env.TINFOIL_KIMI_K26_MODEL || 'kimi-k2-6',
    inputPer1M: parseFloat(process.env.TINFOIL_KIMI_K26_INPUT_PER_1M || '1.50'),
    outputPer1M: parseFloat(process.env.TINFOIL_KIMI_K26_OUTPUT_PER_1M || '5.25'),
    label: 'Kimi K2.6 (Tinfoil)',
  },
  'kimi-k2-5': {
    key: 'kimi-k2-5',
    provider: 'tinfoil',
    id: process.env.TINFOIL_KIMI_K25_MODEL || 'kimi-k2-5',
    inputPer1M: parseFloat(process.env.TINFOIL_KIMI_K25_INPUT_PER_1M || '1.50'),
    outputPer1M: parseFloat(process.env.TINFOIL_KIMI_K25_OUTPUT_PER_1M || '5.25'),
    label: 'Kimi K2.5 (Tinfoil)',
  },
  'glm-5-1': {
    key: 'glm-5-1',
    provider: 'tinfoil',
    id: process.env.TINFOIL_GLM_MODEL || 'glm-5-1',
    inputPer1M: parseFloat(process.env.TINFOIL_GLM_INPUT_PER_1M || '1.50'),
    outputPer1M: parseFloat(process.env.TINFOIL_GLM_OUTPUT_PER_1M || '5.25'),
    label: 'GLM-5.1 (Tinfoil)',
  },
  // DeepSeek V4 via OpenRouter (passthrough pricing, no confidential enclave).
  // Rates verified empirically 2026-04-25 on a Novita-routed call.
  // When/if Tinfoil adds DeepSeek, register a parallel entry with provider: 'tinfoil'
  // (e.g. key 'deepseek-v4-flash-tinfoil') so callers can pick the routing.
  'deepseek-v4-flash': {
    key: 'deepseek-v4-flash',
    provider: 'openrouter',
    id: process.env.OPENROUTER_DEEPSEEK_FLASH_MODEL || 'deepseek/deepseek-v4-flash',
    inputPer1M: parseFloat(process.env.OPENROUTER_DEEPSEEK_FLASH_INPUT_PER_1M || '0.14'),
    outputPer1M: parseFloat(process.env.OPENROUTER_DEEPSEEK_FLASH_OUTPUT_PER_1M || '0.28'),
    label: 'DeepSeek V4-Flash (OpenRouter)',
  },
  'deepseek-v4-pro': {
    key: 'deepseek-v4-pro',
    provider: 'openrouter',
    id: process.env.OPENROUTER_DEEPSEEK_PRO_MODEL || 'deepseek/deepseek-v4-pro',
    // Empirically verified 2026-04-25 via Together (only OR upstream that
    // accepts tool calls for V4-Pro today). Together charges ~5x DeepSeek's
    // direct rate; if/when other upstreams open up, switch routing or move
    // off OpenRouter to DeepSeek direct ($0.435/$0.87 per 1M).
    inputPer1M: parseFloat(process.env.OPENROUTER_DEEPSEEK_PRO_INPUT_PER_1M || '2.10'),
    outputPer1M: parseFloat(process.env.OPENROUTER_DEEPSEEK_PRO_OUTPUT_PER_1M || '4.40'),
    label: 'DeepSeek V4-Pro (OpenRouter/Together)',
  },
  // DeepSeek V4 via the first-party API (api.deepseek.com).
  // Cheapest option and only path that doesn't depend on OpenRouter's shared
  // upstream pool. Note: data is sent directly to DeepSeek (Hangzhou) — pick
  // this routing only when the privacy tradeoff is acceptable.
  'deepseek-v4-flash-direct': {
    key: 'deepseek-v4-flash-direct',
    provider: 'deepseek',
    id: process.env.DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash',
    inputPer1M: parseFloat(process.env.DEEPSEEK_FLASH_INPUT_PER_1M || '0.14'),
    outputPer1M: parseFloat(process.env.DEEPSEEK_FLASH_OUTPUT_PER_1M || '0.28'),
    label: 'DeepSeek V4-Flash (Direct)',
  },
  'deepseek-v4-pro-direct': {
    key: 'deepseek-v4-pro-direct',
    provider: 'deepseek',
    id: process.env.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro',
    inputPer1M: parseFloat(process.env.DEEPSEEK_PRO_INPUT_PER_1M || '0.435'),
    outputPer1M: parseFloat(process.env.DEEPSEEK_PRO_OUTPUT_PER_1M || '0.87'),
    label: 'DeepSeek V4-Pro (Direct)',
  },
};

const DEFAULT_AGENT_MODEL = process.env.AGENT_MODEL && AGENT_MODELS[process.env.AGENT_MODEL]
  ? process.env.AGENT_MODEL
  : 'fast';

const DEFAULT_EXECUTION_PROFILE = process.env.AGENT_EXECUTION_PROFILE && EXECUTION_PROFILES[process.env.AGENT_EXECUTION_PROFILE]
  ? process.env.AGENT_EXECUTION_PROFILE
  : 'default';

const LEGACY_MODEL_ALIASES = {
  'anthropic-fast': 'fast',
  'anthropic-quality': 'quality',
  'tinfoil-gemma': 'gemma',
  gemma4: 'gemma',
  'tinfoil-kimi-k2-6': 'kimi-k2-6',
  'tinfoil-kimi-k2-5': 'kimi-k2-5',
  'tinfoil-glm-5-1': 'glm-5-1',
  kimi: 'kimi-k2-6',
  glm: 'glm-5-1',
  'openrouter-deepseek-v4-flash': 'deepseek-v4-flash',
  'openrouter-deepseek-v4-pro': 'deepseek-v4-pro',
  deepseek: 'deepseek-v4-flash-direct',
  'deepseek-flash': 'deepseek-v4-flash-direct',
  'deepseek-pro': 'deepseek-v4-pro-direct',
  'deepseek-direct': 'deepseek-v4-flash-direct',
  'deepseek-flash-direct': 'deepseek-v4-flash-direct',
  'deepseek-pro-direct': 'deepseek-v4-pro-direct',
};

/**
 * Resolve a client-supplied model string to a registered model key.
 *
 * Returns:
 *   - The canonical key when the input matches a model in AGENT_MODELS.
 *   - The aliased key when the input matches LEGACY_MODEL_ALIASES.
 *   - DEFAULT_AGENT_MODEL when the input is the literal string "default".
 *   - null when the input is empty/missing OR doesn't resolve to anything.
 *
 * Callers handle the null case by falling back to DEFAULT_AGENT_MODEL — this
 * is the contract documented on the `/api/pull` endpoint: any unknown / empty
 * model value resolves to whatever the server's AGENT_MODEL env points to.
 */
function normalizeModelKey(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === 'default') return DEFAULT_AGENT_MODEL;
  if (AGENT_MODELS[trimmed]) return trimmed;
  if (LEGACY_MODEL_ALIASES[trimmed]) return LEGACY_MODEL_ALIASES[trimmed];
  return null;
}

function resolveModelSelection(body = {}) {
  const rawRequestedModel = body.model;
  const requestedModel = normalizeModelKey(rawRequestedModel);
  const requestedProvider = body.provider;

  // Visibility: if the caller passed *something* non-empty for `model` and it
  // didn't resolve, log it once. We still fall back to the default below —
  // this is a debugging aid, not an error response.
  if (requestedModel === null
      && typeof rawRequestedModel === 'string'
      && rawRequestedModel.trim().length > 0
      && rawRequestedModel.trim() !== 'default') {
    console.warn(`[resolveModelSelection] Unknown model "${rawRequestedModel}" — falling back to "${DEFAULT_AGENT_MODEL}"`);
  }

  let modelKey = requestedModel;
  if (!modelKey && requestedProvider === 'tinfoil') modelKey = 'gemma';
  if (!modelKey && requestedProvider === 'anthropic') modelKey = DEFAULT_AGENT_MODEL;
  if (!modelKey && requestedProvider === 'openrouter') modelKey = 'deepseek-v4-flash';
  if (!modelKey && requestedProvider === 'deepseek') modelKey = 'deepseek-v4-flash-direct';
  if (!modelKey) modelKey = DEFAULT_AGENT_MODEL;

  const modelConfig = AGENT_MODELS[modelKey] || AGENT_MODELS[DEFAULT_AGENT_MODEL];
  const profileKey = EXECUTION_PROFILES[body.executionProfile]
    ? body.executionProfile
    : DEFAULT_EXECUTION_PROFILE;
  const baseProfile = EXECUTION_PROFILES[profileKey];

  const overrideSoftMs = Number.isFinite(body.latencyBudgetSoftMs) && body.latencyBudgetSoftMs > 0
    ? Math.floor(body.latencyBudgetSoftMs)
    : null;
  const overrideHardMs = Number.isFinite(body.latencyBudgetHardMs) && body.latencyBudgetHardMs > 0
    ? Math.floor(body.latencyBudgetHardMs)
    : null;

  const executionProfile = (overrideSoftMs !== null || overrideHardMs !== null)
    ? {
        ...baseProfile,
        ...(overrideSoftMs !== null ? { latencyBudgetSoftMs: overrideSoftMs } : {}),
        ...(overrideHardMs !== null ? { latencyBudgetHardMs: overrideHardMs } : {}),
      }
    : baseProfile;

  return {
    modelKey,
    modelConfig,
    profileKey,
    executionProfile,
  };
}

module.exports = {
  AGENT_MODELS,
  DEFAULT_AGENT_MODEL,
  EXECUTION_PROFILES,
  DEFAULT_EXECUTION_PROFILE,
  resolveModelSelection,
};
