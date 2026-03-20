const express = require('express');
const router = express.Router();
const axios = require('axios');
const { OpenAI } = require('openai');
const { printLog } = require('../constants.js');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { createEntitlementMiddleware } = require('../utils/entitlementMiddleware');
const { ENTITLEMENT_TYPES } = require('../constants/entitlementTypes');
const { serviceHmac } = require('../middleware/hmac');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const RSS_EXTRACTOR_BASE = 'https://rss-extractor-app-yufbq.ondigitalocean.app';
const RSS_TIMEOUT_MS = 10000;
const MAX_EPISODE_FETCH_FEEDS = 2;

const RSS_HEADERS = {
  'accept': 'application/json',
  'content-type': 'application/json',
  'authorization': 'Bearer: no-token'
};

// ========== LLM Extraction ==========

function buildDiscoveryPrompt() {
  return `You route podcast discovery queries to the right search backends.

IMPORTANT: All search backends use LITERAL TEXT MATCHING, not semantic search. Only use search terms that would literally appear in podcast titles, episode titles, or person tags.

The Podcast Index has three search endpoints:

1. **byterm** — literal substring search against podcast FEED titles, authors, and owners. Good for: exact show names ("Joe Rogan Experience"), very common genre/topic words that literally appear in podcast titles ("bitcoin", "true crime", "AI"). BAD for: niche concepts, book titles, abstract ideas, or anything that wouldn't literally be in a show name.

2. **byperson** — literal search against EPISODE titles, descriptions, and person tags. Good for: finding episodes where a specific person appeared or was discussed. Returns episode-level results. WARNING: partial name matches are common — "Balaji" matches ANY Balaji, not just Balaji Srinivasan.

3. **trending** — returns currently popular/trending podcasts, optionally filtered by category. Good for: exploratory queries ("find me something good about tech", "popular science podcasts").

Given a user query, return JSON with:
- "intent": one of "show", "person", "topic", "explore", or "compound"
- "byterm_queries": array of 0-2 search strings for byterm. Only use for exact show names or very common topic words that literally appear in podcast titles.
- "byperson_queries": array of 0-2 FULL person names for byperson. ALWAYS use the person's complete name — never abbreviate ("Balaji Srinivasan" not "Balaji S", "Naval Ravikant" not "Naval R").
- "topic_hints": array of 0-2 broad, popular topic keywords associated with the person/concept that would plausibly appear in podcast show titles. For tech figures, think "crypto", "bitcoin", "AI", "startups". These are used as supplementary searches to cast a wider net.
- "trending": object with optional { "cat": "Category", "max": N } if the user wants to browse/explore. null otherwise. Categories: Technology, News, Comedy, Business, Science, Health, Society, Education, Sports, Arts.
- "fetch_episodes": boolean — true if the user wants specific episodes, not just show-level results

Rules:
- A query can use multiple backends. "Lex Fridman interviewing Sam Altman" → byterm: ["Lex Fridman"], byperson: ["Sam Altman"]
- If a person is clearly a podcast HOST, put them in byterm. If they're a GUEST or discussed figure, put them in byperson.
- For vague/exploratory queries, prefer trending with a category filter.
- When a query is about a person + a niche concept (book title, specific idea), use byperson for the person and topic_hints for broad associated keywords. Do NOT put niche concepts in byterm — they match garbage.
- At least one of byterm_queries, byperson_queries, topic_hints, or trending must be populated.

Examples:
- "Balaji Srinivasan discussing The Network State" → byperson: ["Balaji Srinivasan"], topic_hints: ["crypto", "bitcoin"], byterm: [] (NOT byterm: ["network state"] — that matches sports podcasts)
- "Joe Rogan Experience" → byterm: ["Joe Rogan Experience"], topic_hints: []
- "episodes with Naval Ravikant about startups" → byperson: ["Naval Ravikant"], topic_hints: ["startups", "venture capital"]
- "find me good comedy podcasts" → trending: {"cat": "Comedy"}, topic_hints: []

Return ONLY valid JSON, no markdown or explanation.`;
}

async function extractSearchRouting(query) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildDiscoveryPrompt() },
      { role: 'user', content: query }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 300
  });

  return JSON.parse(response.choices[0].message.content);
}

// ========== Relevance Filtering ==========

function filterByPersonRelevance(episodes, personQuery) {
  const tokens = personQuery.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (tokens.length <= 1) return episodes;

  return episodes.filter(ep => {
    const text = [ep.title, ep.description, ep.feedTitle, ep.feedAuthor]
      .join(' ').toLowerCase();
    return tokens.every(token => text.includes(token));
  });
}

function buildFilterPrompt() {
  return `You filter podcast search results for relevance. Given the original query and a list of results, return a JSON object with a "keep" array containing the indices (0-based) of results that are plausibly relevant to the query.

Be MODERATE — keep anything that could reasonably be relevant. Only drop results that are clearly false positives (wrong person, completely unrelated topic, wrong language for an English query, etc.).

Return ONLY valid JSON like: {"keep": [0, 2, 4]}`;
}

async function filterResultsWithLLM(query, results, requestId) {
  if (results.length === 0) return results;

  const compact = results.map((r, i) => {
    const ep = r.matchedEpisodes?.[0];
    const epInfo = ep ? ` | ep: "${ep.title}"` : '';
    return `${i}. "${r.title}" by ${r.author || 'unknown'}${epInfo}`;
  }).join('\n');

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildFilterPrompt() },
        { role: 'user', content: `Query: "${query}"\n\nResults:\n${compact}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 100
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    const keepIndices = new Set(parsed.keep || []);

    if (keepIndices.size === 0) {
      printLog(`[${requestId}] LLM filter kept 0 results — returning all to avoid empty response`);
      return results;
    }

    const filtered = results.filter((_, i) => keepIndices.has(i));
    printLog(`[${requestId}] LLM filter: ${results.length} → ${filtered.length} results`);
    return filtered;
  } catch (error) {
    printLog(`[${requestId}] LLM filter failed, returning unfiltered: ${error.message}`);
    return results;
  }
}

// ========== RSS Extractor Calls ==========

async function searchByTerm(searchTerm) {
  try {
    const response = await axios.post(`${RSS_EXTRACTOR_BASE}/searchFeeds`, {
      podcastName: searchTerm
    }, { headers: RSS_HEADERS, timeout: RSS_TIMEOUT_MS });
    return response.data?.data?.feeds || response.data?.feeds || [];
  } catch (error) {
    printLog(`[DISCOVER] searchFeeds failed for "${searchTerm}": ${error.message}`);
    return [];
  }
}

async function searchByPerson(personName) {
  try {
    const response = await axios.post(`${RSS_EXTRACTOR_BASE}/searchByPerson`, {
      query: personName
    }, { headers: RSS_HEADERS, timeout: RSS_TIMEOUT_MS });
    return response.data?.data?.items || response.data?.items || [];
  } catch (error) {
    printLog(`[DISCOVER] searchByPerson failed for "${personName}": ${error.message}`);
    return [];
  }
}

async function fetchTrending(params) {
  try {
    const response = await axios.post(`${RSS_EXTRACTOR_BASE}/getTrending`, {
      max: params.max || 10,
      ...(params.cat ? { cat: params.cat } : {}),
      ...(params.lang ? { lang: params.lang } : {})
    }, { headers: RSS_HEADERS, timeout: RSS_TIMEOUT_MS });
    return response.data?.data?.feeds || response.data?.feeds || [];
  } catch (error) {
    printLog(`[DISCOVER] getTrending failed: ${error.message}`);
    return [];
  }
}

async function fetchEpisodesForFeed(feedId) {
  try {
    const response = await axios.post(`${RSS_EXTRACTOR_BASE}/getPodcastByFeedId`, {
      feedId: String(feedId),
      skipCleanGuid: true
    }, { headers: RSS_HEADERS, timeout: RSS_TIMEOUT_MS });
    const data = response.data;
    const feedInfo = data?.episodes?.feedInfo || data?.feedInfo || {};
    const episodes = data?.episodes?.episodes || data?.episodes || [];
    return { feedInfo, episodes };
  } catch (error) {
    printLog(`[DISCOVER] getPodcastByFeedId failed for feedId ${feedId}: ${error.message}`);
    return { feedInfo: {}, episodes: [] };
  }
}

// ========== Result Normalization ==========

function normalizeFeed(raw) {
  return {
    feedId: String(raw.id || raw.feedId || ''),
    title: raw.title || raw.feedTitle || '',
    url: raw.url || raw.feedUrl || '',
    description: raw.description || '',
    author: raw.author || raw.feedAuthor || '',
    image: raw.image || raw.artwork || '',
    language: raw.language || raw.feedLanguage || '',
    categories: raw.categories || {},
    trendScore: raw.trendScore || null
  };
}

function normalizePersonEpisode(item) {
  return {
    guid: item.guid || item.id,
    title: item.title || 'Untitled',
    description: (item.description || '').substring(0, 300),
    date: item.datePublished
      ? new Date(item.datePublished * 1000).toISOString().split('T')[0]
      : null,
    duration: item.duration || null,
    feedId: String(item.feedId || ''),
    feedTitle: item.feedTitle || '',
    feedUrl: item.feedUrl || '',
    feedAuthor: item.feedAuthor || ''
  };
}

function buildNextSteps(feed, transcriptAvailable) {
  if (transcriptAvailable) {
    return {
      searchTranscript: {
        description: 'Semantic search across this podcast\'s transcripts with timestamped deeplinks',
        method: 'POST',
        url: '/api/search-quotes',
        body: { query: '...', feedIds: [feed.feedId], smartMode: true }
      },
      getChapters: {
        description: 'Get timestamped chapters for a specific episode',
        method: 'GET',
        url: '/api/episode-with-chapters/:guid'
      }
    };
  }

  return {
    requestTranscription: {
      description: 'Submit episodes for transcription, timestamped chaptering, and semantic indexing',
      method: 'POST',
      url: '/api/on-demand/submitOnDemandRun',
      bodyTemplate: {
        message: `Transcribe episodes from ${feed.title || 'podcast'}`,
        parameters: {},
        episodes: [{ guid: '<episodeGUID>', feedGuid: '<feedGuid>', feedId: String(feed.feedId) }]
      }
    },
    getEpisodes: {
      description: 'Fetch episode list with GUIDs needed for transcription',
      method: 'POST',
      url: '/api/rss/getFeed',
      body: { feedUrl: feed.url, feedId: String(feed.feedId), limit: 25 }
    }
  };
}

// ========== Main Endpoint ==========

/**
 * POST /api/discover-podcasts
 * LLM-assisted podcast discovery across the Podcast Index catalog.
 * Routes queries to byterm, byperson, and/or trending based on intent.
 * Applies string-based name filtering + LLM re-ranking to reduce false positives.
 */
router.post('/discover-podcasts', serviceHmac({ optional: true }), createEntitlementMiddleware(ENTITLEMENT_TYPES.DISCOVER_PODCASTS), async (req, res) => {
  // #swagger.tags = ['Discovery']
  // #swagger.summary = 'LLM-assisted podcast discovery across the Podcast Index catalog'
  // #swagger.description = 'Takes a natural language query, classifies intent, routes to the appropriate Podcast Index search backends (byterm, byperson, trending), and returns matching podcasts enriched with transcript availability flags and actionable next-step endpoints.'
  /* #swagger.parameters['body'] = {
    in: 'body',
    required: true,
    schema: {
      query: 'bitcoin mining podcasts',
      limit: 10
    }
  } */
  const requestId = `DISCOVER-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  const timings = { llm: 0, search: 0, filter: 0, episodes: 0, enrichment: 0, total: 0 };

  try {
    const { query, limit = 10 } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query is required and must be a string' });
    }

    const effectiveLimit = Math.min(25, Math.max(1, Math.floor(limit)));

    printLog(`[${requestId}] ========== DISCOVER REQUEST ==========`);
    printLog(`[${requestId}] Query: "${query}", Limit: ${effectiveLimit}`);

    // Step 1: LLM extracts routing instructions + topic hints
    const llmStart = Date.now();
    const routing = await extractSearchRouting(query);
    timings.llm = Date.now() - llmStart;

    const bytermQueries = (routing.byterm_queries || []).slice(0, 2);
    const bypersonQueries = (routing.byperson_queries || []).slice(0, 2);
    const topicHints = (routing.topic_hints || []).slice(0, 2);
    const trendingParams = routing.trending || null;

    printLog(`[${requestId}] LLM routing (${timings.llm}ms): intent=${routing.intent}, byterm=${JSON.stringify(bytermQueries)}, byperson=${JSON.stringify(bypersonQueries)}, topic_hints=${JSON.stringify(topicHints)}, trending=${JSON.stringify(trendingParams)}`);

    const hasAnySearch = bytermQueries.length > 0 || bypersonQueries.length > 0 || topicHints.length > 0 || trendingParams;
    if (!hasAnySearch) {
      return res.status(400).json({
        error: 'Could not determine search strategy from query',
        detail: 'Try being more specific about the podcast name, topic, or person you\'re looking for'
      });
    }

    // Step 2: Fan out ALL searches in parallel (byterm + byperson + topic_hints + trending)
    const searchStart = Date.now();
    const searchPromises = [];
    const searchLabels = [];

    for (const term of bytermQueries) {
      searchPromises.push(searchByTerm(term));
      searchLabels.push(`byterm:"${term}"`);
    }
    for (const person of bypersonQueries) {
      searchPromises.push(searchByPerson(person));
      searchLabels.push(`byperson:"${person}"`);
    }
    for (const hint of topicHints) {
      searchPromises.push(searchByTerm(hint));
      searchLabels.push(`topic_hint:"${hint}"`);
    }
    if (trendingParams) {
      searchPromises.push(fetchTrending(trendingParams));
      searchLabels.push(`trending:${JSON.stringify(trendingParams)}`);
    }

    const rawResults = await Promise.all(searchPromises);
    timings.search = Date.now() - searchStart;

    printLog(`[${requestId}] Search (${timings.search}ms): ${searchLabels.length} backends queried: ${searchLabels.join(', ')}`);

    // Step 3: Normalize, name-filter, and deduplicate
    const feedMap = new Map();
    const personEpisodes = [];
    let resultIdx = 0;

    // Process byterm results (feeds)
    for (let i = 0; i < bytermQueries.length; i++) {
      const feeds = rawResults[resultIdx++] || [];
      for (const feed of feeds) {
        const normalized = normalizeFeed(feed);
        if (normalized.feedId && !feedMap.has(normalized.feedId)) {
          feedMap.set(normalized.feedId, normalized);
        }
      }
      printLog(`[${requestId}] byterm "${bytermQueries[i]}": ${feeds.length} feeds`);
    }

    // Process byperson results with string-based name filtering
    for (let i = 0; i < bypersonQueries.length; i++) {
      const rawEpisodes = rawResults[resultIdx++] || [];
      const normalized = rawEpisodes.map(ep => normalizePersonEpisode(ep));
      const filtered = filterByPersonRelevance(normalized, bypersonQueries[i]);

      printLog(`[${requestId}] byperson "${bypersonQueries[i]}": ${rawEpisodes.length} raw → ${filtered.length} after name filter`);

      for (const ep of filtered) {
        personEpisodes.push(ep);
        const fid = ep.feedId;
        if (fid && !feedMap.has(fid)) {
          feedMap.set(fid, {
            feedId: fid,
            title: ep.feedTitle,
            url: ep.feedUrl,
            description: '',
            author: ep.feedAuthor,
            image: '',
            language: '',
            categories: {},
            trendScore: null
          });
        }
      }
    }

    // Process topic_hint results (feeds, ranked lower by virtue of being added after byterm/byperson)
    for (let i = 0; i < topicHints.length; i++) {
      const feeds = rawResults[resultIdx++] || [];
      for (const feed of feeds) {
        const normalized = normalizeFeed(feed);
        if (normalized.feedId && !feedMap.has(normalized.feedId)) {
          feedMap.set(normalized.feedId, normalized);
        }
      }
      printLog(`[${requestId}] topic_hint "${topicHints[i]}": ${feeds.length} feeds`);
    }

    // Process trending results (feeds)
    if (trendingParams) {
      const feeds = rawResults[resultIdx++] || [];
      for (const feed of feeds) {
        const normalized = normalizeFeed(feed);
        if (normalized.feedId && !feedMap.has(normalized.feedId)) {
          feedMap.set(normalized.feedId, normalized);
        }
      }
      printLog(`[${requestId}] trending: ${feeds.length} feeds`);
    }

    // Group person episodes by feedId for inline attachment
    const episodesByFeed = new Map();
    for (const ep of personEpisodes) {
      if (!episodesByFeed.has(ep.feedId)) {
        episodesByFeed.set(ep.feedId, []);
      }
      episodesByFeed.get(ep.feedId).push(ep);
    }

    // Step 4: Transcript availability via JamieVectorMetadata
    const enrichStart = Date.now();
    const feedIds = Array.from(feedMap.keys());
    const episodeGuids = personEpisodes.map(ep => ep.guid).filter(Boolean);

    const [transcribedFeedDocs, transcribedEpisodeDocs] = await Promise.all([
      feedIds.length > 0
        ? JamieVectorMetadata.find({ type: 'feed', feedId: { $in: feedIds } }).select('feedId').lean()
        : [],
      episodeGuids.length > 0
        ? JamieVectorMetadata.find({ type: 'episode', guid: { $in: episodeGuids } }).select('guid feedId').lean()
        : []
    ]);

    const transcribedFeedIds = new Set(transcribedFeedDocs.map(f => String(f.feedId)));
    for (const ep of transcribedEpisodeDocs) {
      if (ep.feedId) transcribedFeedIds.add(String(ep.feedId));
    }
    timings.enrichment = Date.now() - enrichStart;

    printLog(`[${requestId}] Enrichment (${timings.enrichment}ms): ${transcribedFeedIds.size} transcribed feeds found`);

    // Step 5: Build preliminary results with nextSteps
    let results = Array.from(feedMap.values())
      .slice(0, effectiveLimit)
      .map(feed => {
        const transcriptAvailable = transcribedFeedIds.has(feed.feedId);
        const matchedEpisodes = episodesByFeed.get(feed.feedId) || null;

        return {
          ...feed,
          transcriptAvailable,
          matchedEpisodes: matchedEpisodes ? matchedEpisodes.slice(0, 10) : null,
          episodes: null,
          nextSteps: buildNextSteps(feed, transcriptAvailable)
        };
      });

    // Step 6: LLM filter pass — remove obvious false positives
    if (results.length > 0) {
      const filterStart = Date.now();
      results = await filterResultsWithLLM(query, results, requestId);
      timings.filter = Date.now() - filterStart;
      printLog(`[${requestId}] LLM filter pass (${timings.filter}ms)`);
    }

    // Step 7: Fetch episodes for top untranscribed feeds without person-matched episodes
    const shouldFetchEpisodes = routing.fetch_episodes ||
      results.some(r => !r.transcriptAvailable && !r.matchedEpisodes);

    if (shouldFetchEpisodes) {
      const feedsToFetch = results
        .filter(r => !r.transcriptAvailable && !r.matchedEpisodes)
        .slice(0, MAX_EPISODE_FETCH_FEEDS);

      if (feedsToFetch.length > 0) {
        const episodeStart = Date.now();
        const episodeResults = await Promise.all(
          feedsToFetch.map(f => fetchEpisodesForFeed(f.feedId))
        );
        timings.episodes = Date.now() - episodeStart;

        for (let i = 0; i < feedsToFetch.length; i++) {
          const { feedInfo, episodes } = episodeResults[i];
          const feedGuid = feedInfo?.feedGuid || feedInfo?.podcastGuid || null;
          const feedResult = results.find(r => r.feedId === feedsToFetch[i].feedId);

          if (feedResult && episodes.length > 0) {
            feedResult.feedGuid = feedGuid;
            feedResult.episodes = episodes.slice(0, 10).map(ep => ({
              guid: ep.episodeGUID || ep.enclosureUrl || ep.itemUUID,
              title: ep.itemTitle || ep.title || 'Untitled',
              date: ep.publishedDate
                ? new Date(ep.publishedDate * 1000).toISOString().split('T')[0]
                : null,
              duration: ep.length || ep.duration || null,
              feedGuid: feedGuid,
              feedId: feedResult.feedId
            }));

            if (feedResult.nextSteps.requestTranscription) {
              feedResult.nextSteps.requestTranscription.bodyTemplate.episodes =
                feedResult.episodes.map(ep => ({
                  guid: ep.guid,
                  feedGuid: ep.feedGuid,
                  feedId: ep.feedId
                }));
            }
          }
        }

        printLog(`[${requestId}] Episodes fetched (${timings.episodes}ms) for ${feedsToFetch.length} feeds`);
      }
    }

    timings.total = Date.now() - startTime;

    printLog(`[${requestId}] ========== DISCOVER COMPLETE (${timings.total}ms) ==========`);
    printLog(`[${requestId}] Returning ${results.length} results (${results.filter(r => r.transcriptAvailable).length} transcribed, ${results.filter(r => !r.transcriptAvailable).length} untranscribed)`);

    res.json({
      query,
      routing: {
        intent: routing.intent,
        byterm: bytermQueries,
        byperson: bypersonQueries,
        topicHints,
        trending: trendingParams
      },
      results,
      total: results.length,
      transcribedCount: results.filter(r => r.transcriptAvailable).length,
      untranscribedCount: results.filter(r => !r.transcriptAvailable).length,
      metadata: {
        llmLatencyMs: timings.llm,
        searchLatencyMs: timings.search,
        filterLatencyMs: timings.filter,
        episodeFetchLatencyMs: timings.episodes,
        enrichmentLatencyMs: timings.enrichment,
        totalLatencyMs: timings.total,
        backendsQueried: searchLabels
      },
      relatedEndpoints: {
        searchTranscripts: {
          description: 'Semantic search across transcribed podcast content with timestamped deeplinks',
          method: 'POST',
          url: '/api/search-quotes'
        },
        submitTranscription: {
          description: 'Submit episodes for transcription, timestamped chaptering, and semantic indexing',
          method: 'POST',
          url: '/api/on-demand/submitOnDemandRun'
        }
      }
    });

  } catch (error) {
    timings.total = Date.now() - startTime;
    printLog(`[${requestId}] ✗ Error (${timings.total}ms): ${error.message}`);
    console.error(`[${requestId}] Stack:`, error.stack);

    res.status(500).json({
      error: 'Discovery failed',
      detail: error.message,
      requestId
    });
  }
});

// ========== RSS Proxy Routes ==========

/**
 * POST /api/rss/searchFeeds
 * Proxy to RSS extractor searchFeeds (Podcast Index byterm search).
 */
router.post('/rss/searchFeeds', serviceHmac({ optional: true }), createEntitlementMiddleware(ENTITLEMENT_TYPES.DISCOVER_PODCASTS), async (req, res) => {
  const { podcastName } = req.body;

  if (!podcastName || typeof podcastName !== 'string') {
    return res.status(400).json({ error: 'podcastName is required' });
  }

  try {
    const response = await axios.post(`${RSS_EXTRACTOR_BASE}/searchFeeds`, {
      podcastName
    }, { headers: RSS_HEADERS, timeout: RSS_TIMEOUT_MS });

    res.json(response.data);
  } catch (error) {
    printLog(`[RSS-PROXY] searchFeeds error: ${error.message}`);
    res.status(502).json({ error: 'RSS extractor unavailable', detail: error.message });
  }
});

/**
 * POST /api/rss/searchByPerson
 * Proxy to RSS extractor searchByPerson (Podcast Index byperson search).
 */
router.post('/rss/searchByPerson', serviceHmac({ optional: true }), createEntitlementMiddleware(ENTITLEMENT_TYPES.DISCOVER_PODCASTS), async (req, res) => {
  const { query } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query is required' });
  }

  try {
    const response = await axios.post(`${RSS_EXTRACTOR_BASE}/searchByPerson`, {
      query
    }, { headers: RSS_HEADERS, timeout: RSS_TIMEOUT_MS });

    res.json(response.data);
  } catch (error) {
    printLog(`[RSS-PROXY] searchByPerson error: ${error.message}`);
    res.status(502).json({ error: 'RSS extractor unavailable', detail: error.message });
  }
});

/**
 * POST /api/rss/getFeed
 * Proxy to RSS extractor getFeed.
 */
router.post('/rss/getFeed', serviceHmac({ optional: true }), createEntitlementMiddleware(ENTITLEMENT_TYPES.DISCOVER_PODCASTS), async (req, res) => {
  const { feedUrl, feedId, limit = 25, skipCleanGuid } = req.body;

  if (!feedUrl || !feedId) {
    return res.status(400).json({ error: 'feedUrl and feedId are required' });
  }

  try {
    const body = { feedUrl, feedId: String(feedId), limit: Math.min(50, limit) };
    if (skipCleanGuid) body.skipCleanGuid = true;

    const response = await axios.post(`${RSS_EXTRACTOR_BASE}/getFeed`, body, {
      headers: RSS_HEADERS, timeout: RSS_TIMEOUT_MS
    });

    res.json(response.data);
  } catch (error) {
    printLog(`[RSS-PROXY] getFeed error: ${error.message}`);
    res.status(502).json({ error: 'RSS extractor unavailable', detail: error.message });
  }
});

module.exports = router;
