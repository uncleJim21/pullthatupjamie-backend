/**
 * Agent model/provider registry and execution profile controls.
 *
 * Notes:
 * - Keep legacy "fast"/"quality" aliases for backward compatibility.
 * - Gemma defaults can be overridden via env without code edits.
 */

const EXECUTION_PROFILES = {
  default: {
    maxToolRounds: 6,
    costBudgetSoft: 0.055,
    costBudgetHard: 0.08,
    label: 'Default',
  },
  'deep-turns': {
    maxToolRounds: 10,
    costBudgetSoft: 0.08,
    costBudgetHard: 0.12,
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
};

function normalizeModelKey(input) {
  if (!input || typeof input !== 'string') return null;
  if (AGENT_MODELS[input]) return input;
  return LEGACY_MODEL_ALIASES[input] || null;
}

function resolveModelSelection(body = {}) {
  const requestedModel = normalizeModelKey(body.model);
  const requestedProvider = body.provider;

  let modelKey = requestedModel;
  if (!modelKey && requestedProvider === 'tinfoil') modelKey = 'gemma';
  if (!modelKey && requestedProvider === 'anthropic') modelKey = DEFAULT_AGENT_MODEL;
  if (!modelKey) modelKey = DEFAULT_AGENT_MODEL;

  const modelConfig = AGENT_MODELS[modelKey] || AGENT_MODELS[DEFAULT_AGENT_MODEL];
  const profileKey = EXECUTION_PROFILES[body.executionProfile]
    ? body.executionProfile
    : DEFAULT_EXECUTION_PROFILE;
  const executionProfile = EXECUTION_PROFILES[profileKey];

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
