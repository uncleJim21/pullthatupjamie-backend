const AnthropicProvider = require('./anthropicProvider');
const TinfoilProvider = require('./tinfoilProvider');
const OpenRouterProvider = require('./openRouterProvider');
const DeepSeekProvider = require('./deepSeekProvider');
const OpenAIProvider = require('./openAIProvider');

// Supported provider IDs. Each model entry in constants/agentModels.js picks
// one of these as its `provider`. Same model can appear under multiple
// providers (e.g. deepseek-v4-flash via openrouter today, via tinfoil later)
// as separate registry entries with distinct keys.
const SUPPORTED_PROVIDERS = ['anthropic', 'tinfoil', 'openrouter', 'deepseek', 'openai'];

const providerCache = new Map();

function createProvider(name) {
  if (providerCache.has(name)) return providerCache.get(name);

  let provider;
  if (name === 'anthropic') provider = new AnthropicProvider();
  else if (name === 'tinfoil') provider = new TinfoilProvider();
  else if (name === 'openrouter') provider = new OpenRouterProvider();
  else if (name === 'deepseek') provider = new DeepSeekProvider();
  else if (name === 'openai') provider = new OpenAIProvider();
  else throw new Error(`Unknown provider: ${name}`);

  providerCache.set(name, provider);
  return provider;
}

module.exports = { createProvider, SUPPORTED_PROVIDERS };
