const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { printLog } = require('../constants.js');

let feedCache = null;
let feedCacheTimestamp = 0;
const FEED_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let keywordCache = null;
let keywordCacheTimestamp = 0;
const KEYWORD_CACHE_TTL_MS = 60 * 60 * 1000;

async function loadFeedCache() {
  const now = Date.now();
  if (feedCache && (now - feedCacheTimestamp) < FEED_CACHE_TTL_MS) {
    return feedCache;
  }

  const feedDocs = await JamieVectorMetadata.find({ type: 'feed' })
    .select('feedId metadataRaw')
    .lean();

  feedCache = feedDocs.map(doc => ({
    feedId: String(doc.feedId || doc.metadataRaw?.feedId || ''),
    title: doc.metadataRaw?.title || '',
    description: doc.metadataRaw?.description || ''
  }));
  feedCacheTimestamp = now;

  printLog(`[QUERY-TRIAGE] Feed cache loaded: ${feedCache.length} feeds`);
  return feedCache;
}

async function loadKeywordCache() {
  const now = Date.now();
  if (keywordCache && (now - keywordCacheTimestamp) < KEYWORD_CACHE_TTL_MS) {
    return keywordCache;
  }

  const pipeline = [
    { $match: { type: 'chapter', 'metadataRaw.keywords': { $exists: true, $ne: [] } } },
    { $unwind: '$metadataRaw.keywords' },
    { $group: { _id: { $toLower: '$metadataRaw.keywords' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 500 }
  ];

  const results = await JamieVectorMetadata.aggregate(pipeline);
  keywordCache = results.map(r => r._id);
  keywordCacheTimestamp = now;

  printLog(`[QUERY-TRIAGE] Keyword cache loaded: ${keywordCache.length} keywords`);
  return keywordCache;
}

function buildAcronym(title) {
  return title
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => w[0])
    .join('')
    .toLowerCase();
}

function buildInitialism(title) {
  // "The Joe Rogan Experience" -> "jre" (skip articles)
  const skipWords = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'with', 'for']);
  return title
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0 && !skipWords.has(w.toLowerCase()))
    .map(w => w[0])
    .join('')
    .toLowerCase();
}

function fuzzyMatchFeed(showHint, feeds) {
  if (!showHint) return null;
  const hint = showHint.toLowerCase().trim();

  // Exact title match first
  const exact = feeds.find(f => f.title.toLowerCase() === hint);
  if (exact) return exact;

  // Abbreviation/acronym match (e.g. "JRE" -> "The Joe Rogan Experience")
  if (hint.length <= 6) {
    const acronymMatch = feeds.find(f => {
      const acro = buildAcronym(f.title);
      const init = buildInitialism(f.title);
      return acro === hint || init === hint;
    });
    if (acronymMatch) return acronymMatch;
  }

  // Substring match
  const substring = feeds.find(f => f.title.toLowerCase().includes(hint) || hint.includes(f.title.toLowerCase()));
  if (substring) return substring;

  // Word overlap scoring
  const hintWords = hint.split(/\s+/).filter(w => w.length > 2);
  let bestMatch = null;
  let bestScore = 0;

  for (const feed of feeds) {
    const titleLower = feed.title.toLowerCase();
    const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);
    const overlap = hintWords.filter(w => titleWords.some(tw => tw.includes(w) || w.includes(tw))).length;
    const score = overlap / Math.max(hintWords.length, 1);
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestMatch = feed;
    }
  }

  return bestMatch;
}

const TRIAGE_SYSTEM_PROMPT = `You classify podcast transcript search queries and extract structured entities.

Given a user's search query for a podcast transcript database, return JSON with these fields:

- "intent": one of "direct_quote", "topical", or "descriptive"
  - "direct_quote": user typed specific words/phrases actually spoken (e.g. "four score and seven years ago")
  - "topical": user is searching for a topic/subject discussed (e.g. "Bitcoin price prediction")
  - "descriptive": user is describing a moment, story, or conversation they vaguely remember (e.g. "that funny story Steve O told Joe Rogan")

- "show_hint": the podcast/show name mentioned or implied, or null
- "person_hint": a specific person, organization, or brand mentioned that identifies who is speaking or being discussed. This could be a person name (guest/host), a company, a brand, or an affiliation (e.g. "Weinstein" -> person, "CASCDR" -> organization, "Breaking Points" -> show/org). Extract the most specific entity the user is referring to. Null if none.
- "person_variants": array of 2-5 plausible spelling/formatting variants for database matching. Include the original plus: alternate spellings, hyphenations, full names, nicknames, and for people include their known organizational affiliations or brand names (e.g. for "Steve O" include ["Steve O", "Steve-O", "SteveO", "Steve O."], for "Sagar" include ["Sagar", "Saagar", "Sagar Enjeti", "Saagar Enjeti", "Breaking Points"], for "Weinstein" include ["Weinstein", "Eric Weinstein", "Bret Weinstein", "Brett Weinstein"]). Return empty array if no entity.
- "topic_keywords": array of 1-5 topic keywords extracted from the query (short, specific terms)
- "time_hint": any time reference ("last year", "2023", "recent"), or null
- "rewritten_query": the query rewritten to match what would actually appear in a transcript. Strip out meta-references like "that time" or "the episode where" and focus on the actual content/topic words. For direct_quote intent, return the original query unchanged.
- "confidence": 0.0-1.0 how confident you are in the classification

Return ONLY valid JSON, no markdown or explanation.`;

async function classifyQuery(query, openai) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
      { role: 'user', content: query }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 300
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  const usage = response.usage || {};
  parsed._usage = {
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0
  };
  return parsed;
}

async function resolveEntities(classification) {
  const { show_hint, person_hint, person_variants = [], topic_keywords = [], intent } = classification;
  const results = { feedIds: [], guids: [], episodeName: null };
  const signals = {
    feed: { matched: false },
    guest: { matched: false },
    keywords: { matched: false }
  };

  const feeds = await loadFeedCache();

  // Signal 1: Feed resolution (from cache, instant)
  if (show_hint) {
    const matchedFeed = fuzzyMatchFeed(show_hint, feeds);
    if (matchedFeed) {
      results.feedIds = [matchedFeed.feedId];
      signals.feed = { matched: true, feedId: matchedFeed.feedId, title: matchedFeed.title };
      printLog(`[QUERY-TRIAGE] Feed resolved: "${show_hint}" -> ${matchedFeed.title} (${matchedFeed.feedId})`);
    }
  }

  // Signal 2 & 3 run in parallel
  const parallelQueries = [];

  // Signal 2: Guest resolution using name variants for fuzzy matching
  const nameVariants = person_variants.length > 0 ? person_variants : (person_hint ? [person_hint] : []);
  if (nameVariants.length > 0) {
    const escapedVariants = nameVariants.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const variantRegex = escapedVariants.join('|');
    const feedFilter = results.feedIds.length > 0 ? { feedId: { $in: results.feedIds } } : {};
    parallelQueries.push(
      JamieVectorMetadata.aggregate([
        { $match: {
          type: 'episode',
          'metadataRaw.guests': { $exists: true, $ne: [] },
          ...feedFilter
        }},
        { $unwind: '$metadataRaw.guests' },
        { $match: {
          'metadataRaw.guests': { $regex: variantRegex, $options: 'i' }
        }},
        { $group: {
          _id: '$guid',
          feedId: { $first: '$feedId' },
          title: { $first: '$metadataRaw.title' }
        }},
        { $limit: 20 }
      ]).then(episodes => {
          if (episodes.length > 0) {
            signals.guest = {
              matched: true,
              episodeCount: episodes.length,
              guids: episodes.map(e => e._id).filter(Boolean).slice(0, 10)
            };
            if (episodes.length <= 5) {
              results.guids = episodes.map(e => e._id).filter(Boolean);
            }
            if (results.feedIds.length === 0) {
              const guestFeedIds = [...new Set(episodes.map(e => e.feedId).filter(Boolean))];
              if (guestFeedIds.length <= 3) {
                results.feedIds = guestFeedIds;
              }
            }
            printLog(`[QUERY-TRIAGE] Guest resolved: "${nameVariants.join(' / ')}" -> ${episodes.length} episodes`);
          }
        })
    );
  }

  // Signal 3: Chapter keyword resolution
  // Only use keywords to narrow feedIds for "descriptive" intent.
  // For "topical" queries, keywords inform metadata but don't filter.
  if (topic_keywords.length > 0) {
    const loweredKeywords = topic_keywords.map(k => k.toLowerCase());
    const keywordQuery = {
      type: 'chapter',
      'metadataRaw.keywords': { $in: loweredKeywords }
    };
    if (results.feedIds.length > 0) {
      keywordQuery.feedId = { $in: results.feedIds };
    }
    parallelQueries.push(
      JamieVectorMetadata.find(keywordQuery)
        .select('guid feedId metadataRaw.keywords')
        .limit(50)
        .lean()
        .then(chapters => {
          if (chapters.length > 0) {
            const matchedGuids = [...new Set(chapters.map(c => c.guid).filter(Boolean))];
            const matchedKeywords = [...new Set(chapters.flatMap(c => c.metadataRaw?.keywords || []))];
            signals.keywords = {
              matched: true,
              chapterCount: chapters.length,
              matchedKeywords: matchedKeywords.slice(0, 10),
              guids: matchedGuids.slice(0, 10)
            };
            // Only use keyword-derived feedIds for descriptive intent to avoid
            // over-narrowing topical searches.
            if (intent === 'descriptive' && results.feedIds.length === 0) {
              const kwFeedIds = [...new Set(chapters.map(c => c.feedId).filter(Boolean))];
              if (kwFeedIds.length <= 5) {
                results.feedIds = kwFeedIds;
              }
            }
            printLog(`[QUERY-TRIAGE] Keywords resolved: ${topic_keywords.join(', ')} -> ${chapters.length} chapters, ${matchedGuids.length} episodes`);
          }
        })
    );
  }

  await Promise.all(parallelQueries);

  return { ...results, signals };
}

/**
 * Main triage function. Classifies a search query and resolves entities
 * to filter parameters for the existing search pipeline.
 *
 * @param {string} query - The user's raw search query
 * @param {object} openai - OpenAI client instance
 * @returns {object} { rewrittenQuery, feedIds, guid, episodeName, minDate, maxDate, triage }
 */
async function triageQuery(query, openai) {
  const startTime = Date.now();
  const debugPrefix = '[QUERY-TRIAGE]';

  try {
    printLog(`${debugPrefix} ========== TRIAGE START ==========`);
    printLog(`${debugPrefix} Query: "${query}"`);

    // Step 1: LLM Classification
    const classStart = Date.now();
    const classification = await classifyQuery(query, openai);
    const classLatency = Date.now() - classStart;
    printLog(`${debugPrefix} Classification (${classLatency}ms):`, JSON.stringify(classification));

    // Short-circuit for direct quotes
    if (classification.intent === 'direct_quote') {
      const totalLatency = Date.now() - startTime;
      printLog(`${debugPrefix} Direct quote detected - skipping entity resolution (${totalLatency}ms)`);
      return {
        rewrittenQuery: null,
        feedIds: [],
        guid: null,
        episodeName: null,
        minDate: null,
        maxDate: null,
        triage: {
          intent: 'direct_quote',
          confidence: classification.confidence,
          resolvedSignals: {},
          latencyMs: totalLatency,
          usage: classification._usage
        }
      };
    }

    // Step 2: Entity Resolution
    const resolveStart = Date.now();
    const resolved = await resolveEntities(classification);
    const resolveLatency = Date.now() - resolveStart;
    printLog(`${debugPrefix} Entity resolution (${resolveLatency}ms):`, JSON.stringify(resolved.signals));

    // Pass resolved GUIDs when the set is small enough to be a useful filter.
    // Too many GUIDs (>10) means the match was too broad (e.g. "Jim" matched everyone named Jim).
    const MAX_GUID_FILTER = 10;
    const guids = resolved.guids.length <= MAX_GUID_FILTER ? resolved.guids : [];

    // If confidence is too low, don't apply any filters
    const confidenceThreshold = 0.5;
    const applyFilters = classification.confidence >= confidenceThreshold;

    const totalLatency = Date.now() - startTime;
    printLog(`${debugPrefix} ========== TRIAGE COMPLETE (${totalLatency}ms) ==========`);

    return {
      rewrittenQuery: classification.rewritten_query || null,
      feedIds: applyFilters ? resolved.feedIds : [],
      guids: applyFilters ? guids : [],
      episodeName: null,
      minDate: null,
      maxDate: null,
      triage: {
        intent: classification.intent,
        show_hint: classification.show_hint,
        person_hint: classification.person_hint,
        person_variants: classification.person_variants || [],
        topic_keywords: classification.topic_keywords,
        time_hint: classification.time_hint,
        rewrittenQuery: classification.rewritten_query,
        confidence: classification.confidence,
        resolvedSignals: resolved.signals,
        filtersApplied: applyFilters,
        latencyMs: totalLatency,
        classificationLatencyMs: classLatency,
        resolutionLatencyMs: resolveLatency,
        usage: classification._usage
      }
    };

  } catch (error) {
    const totalLatency = Date.now() - startTime;
    printLog(`${debugPrefix} ERROR (${totalLatency}ms): ${error.message}`);
    console.error(`${debugPrefix} Triage failed:`, error);

    // Graceful fallback: return null signals so the original query runs unmodified
    return {
      rewrittenQuery: null,
      feedIds: [],
      guid: null,
      episodeName: null,
      minDate: null,
      maxDate: null,
      triage: {
        intent: 'error',
        error: error.message,
        latencyMs: totalLatency
      }
    };
  }
}

module.exports = { triageQuery, loadFeedCache, loadKeywordCache };
