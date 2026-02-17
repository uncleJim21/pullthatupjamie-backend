const axios = require('axios');

/**
 * BTC/USD Price Service
 * 
 * Fetches BTC/USD from multiple providers, takes the median, and caches.
 * 
 * Freshness rules:
 *   < 5 min:   return cached, no fetch
 *   5-30 min:  fetch fresh in background, return cached
 *   30-60 min: log warning, still serve
 *   > 1 hour:  isLightningAvailable() returns false → agent endpoints return 503
 */

const CACHE_TTL_MS = 5 * 60 * 1000;         // 5 minutes
const STALE_WARN_MS = 30 * 60 * 1000;       // 30 minutes
const STALE_DISABLE_MS = 60 * 60 * 1000;    // 1 hour
const FETCH_TIMEOUT_MS = 8000;               // 8 second timeout per provider

let priceCache = {
  rate: null,
  fetchedAt: null,
  providers: [],
  isFetching: false
};

/**
 * Provider fetchers — each returns a number (BTC/USD rate) or throws
 */
const providers = {
  async coinbase() {
    const res = await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', {
      timeout: FETCH_TIMEOUT_MS
    });
    return parseFloat(res.data.data.amount);
  },

  async coingecko() {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', {
      timeout: FETCH_TIMEOUT_MS
    });
    return res.data.bitcoin.usd;
  },

  async kraken() {
    const res = await axios.get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', {
      timeout: FETCH_TIMEOUT_MS
    });
    const pair = res.data.result.XXBTZUSD || res.data.result.XBTUSD;
    return parseFloat(pair.c[0]);
  },

  async bitstamp() {
    const res = await axios.get('https://www.bitstamp.net/api/v2/ticker/btcusd/', {
      timeout: FETCH_TIMEOUT_MS
    });
    return parseFloat(res.data.last);
  }
};

/**
 * Compute the median of an array of numbers
 */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Fetch prices from all providers in parallel, return median
 */
async function fetchFreshPrice() {
  const results = await Promise.allSettled(
    Object.entries(providers).map(async ([name, fetcher]) => {
      const price = await fetcher();
      if (typeof price !== 'number' || isNaN(price) || price <= 0) {
        throw new Error(`Invalid price from ${name}: ${price}`);
      }
      return { name, price };
    })
  );

  const successful = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  const failed = results
    .filter(r => r.status === 'rejected')
    .map((r, i) => Object.keys(providers)[i]);

  if (failed.length > 0) {
    console.warn(`[btcPrice] Failed providers: ${failed.join(', ')}`);
  }

  if (successful.length === 0) {
    throw new Error('[btcPrice] All providers failed — cannot determine BTC/USD rate');
  }

  const prices = successful.map(s => s.price);
  const medianPrice = median(prices);
  const providerNames = successful.map(s => s.name);

  console.log(`[btcPrice] Fetched from ${providerNames.join(', ')}: median $${medianPrice.toFixed(2)} (${successful.length}/${Object.keys(providers).length} providers)`);

  return {
    rate: medianPrice,
    fetchedAt: new Date(),
    providers: providerNames
  };
}

/**
 * Refresh the cache (non-blocking if called in background)
 */
async function refreshCache() {
  if (priceCache.isFetching) return;
  priceCache.isFetching = true;

  try {
    const fresh = await fetchFreshPrice();
    priceCache.rate = fresh.rate;
    priceCache.fetchedAt = fresh.fetchedAt;
    priceCache.providers = fresh.providers;
  } catch (err) {
    console.error('[btcPrice] Failed to refresh cache:', err.message);
  } finally {
    priceCache.isFetching = false;
  }
}

/**
 * Get the current BTC/USD rate (cached, with freshness rules)
 * 
 * @returns {Promise<{ rate: number, fetchedAt: Date, providers: string[], isStale: boolean }>}
 * @throws if no cached rate and fresh fetch fails
 */
async function getBtcUsdRate() {
  const now = Date.now();
  const age = priceCache.fetchedAt ? now - priceCache.fetchedAt.getTime() : Infinity;

  // No cache at all — must fetch synchronously
  if (!priceCache.rate) {
    await refreshCache();
    if (!priceCache.rate) {
      throw new Error('[btcPrice] Unable to determine BTC/USD rate');
    }
    return {
      rate: priceCache.rate,
      fetchedAt: priceCache.fetchedAt,
      providers: priceCache.providers,
      isStale: false
    };
  }

  // Fresh enough
  if (age < CACHE_TTL_MS) {
    return {
      rate: priceCache.rate,
      fetchedAt: priceCache.fetchedAt,
      providers: priceCache.providers,
      isStale: false
    };
  }

  // Stale but usable — refresh in background
  if (age < STALE_WARN_MS) {
    refreshCache();
    return {
      rate: priceCache.rate,
      fetchedAt: priceCache.fetchedAt,
      providers: priceCache.providers,
      isStale: false
    };
  }

  // Getting old — warn but still serve
  if (age < STALE_DISABLE_MS) {
    console.warn(`[btcPrice] Price is ${Math.round(age / 60000)} minutes old — approaching staleness limit`);
    refreshCache();
    return {
      rate: priceCache.rate,
      fetchedAt: priceCache.fetchedAt,
      providers: priceCache.providers,
      isStale: true
    };
  }

  // Too old — try one synchronous refresh before giving up
  await refreshCache();
  const newAge = priceCache.fetchedAt ? now - priceCache.fetchedAt.getTime() : Infinity;
  if (newAge >= STALE_DISABLE_MS) {
    throw new Error(`[btcPrice] Price is ${Math.round(newAge / 60000)} minutes old — lightning services disabled`);
  }

  return {
    rate: priceCache.rate,
    fetchedAt: priceCache.fetchedAt,
    providers: priceCache.providers,
    isStale: false
  };
}

/**
 * Check if lightning services should be available based on price freshness
 */
function isLightningAvailable() {
  if (!priceCache.rate || !priceCache.fetchedAt) return false;
  const age = Date.now() - priceCache.fetchedAt.getTime();
  return age < STALE_DISABLE_MS;
}

/**
 * Convert USD to satoshis at the current cached rate
 * 
 * @param {number} usdAmount - USD amount
 * @returns {number} satoshis (integer)
 */
function usdToSats(usdAmount) {
  if (!priceCache.rate) throw new Error('[btcPrice] No cached rate available');
  return Math.round((usdAmount / priceCache.rate) * 1e8);
}

/**
 * Convert satoshis to USD microdollars at the current cached rate
 * 1 microdollar = $0.000001
 * 
 * @param {number} sats - satoshis
 * @returns {number} microdollars (integer)
 */
function satsToUsdMicro(sats) {
  if (!priceCache.rate) throw new Error('[btcPrice] No cached rate available');
  const usd = (sats / 1e8) * priceCache.rate;
  return Math.round(usd * 1e6);
}

/**
 * Convert USD microdollars to a human-readable USD string
 * 
 * @param {number} microUsd - microdollars
 * @returns {number} USD (float, 6 decimal places)
 */
function microUsdToUsd(microUsd) {
  return microUsd / 1e6;
}

module.exports = {
  getBtcUsdRate,
  isLightningAvailable,
  usdToSats,
  satsToUsdMicro,
  microUsdToUsd,
  refreshCache
};
