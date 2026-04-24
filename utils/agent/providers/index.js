const AnthropicProvider = require('./anthropicProvider');
const TinfoilProvider = require('./tinfoilProvider');

const providerCache = new Map();

function createProvider(name) {
  if (providerCache.has(name)) return providerCache.get(name);

  let provider;
  if (name === 'anthropic') provider = new AnthropicProvider();
  else if (name === 'tinfoil') provider = new TinfoilProvider();
  else throw new Error(`Unknown provider: ${name}`);

  providerCache.set(name, provider);
  return provider;
}

module.exports = { createProvider };
