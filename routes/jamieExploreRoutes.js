const express = require('express');
const router = express.Router();
const { OpenAI } = require('openai');
const { findSimilarDiscussions, getEpisodeByGuid, getParagraphWithEpisodeData, getClipById, formatResults } = require('../agent-tools/pineconeTools.js');
const JamieVectorMetadata = require('../models/JamieVectorMetadata');
const { ResearchSession } = require('../models/ResearchSession');
const { printLog } = require('../constants.js');

// Feature flags
const jamieExplorePostRoutesEnabled = false; // Set to true to enable POST routes (/search-quotes-3d, /fetch-research-id)

// Pinecone timeout helper
const PINECONE_TIMEOUT_MS = parseInt(process.env.PINECONE_TIMEOUT_MS || '45000', 10);
const withPineconeTimeout = async (operationName, fn) => {
  const timeoutMs = PINECONE_TIMEOUT_MS;
  return Promise.race([
    fn(),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Pinecone operation "${operationName}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
};

// OpenAI client initialization
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// OpenAI helper: configurable timeout & retries for embeddings
const OPENAI_EMBEDDING_TIMEOUT_MS = parseInt(process.env.OPENAI_EMBEDDING_TIMEOUT_MS || '20000', 10);
const OPENAI_EMBEDDING_MAX_RETRIES = parseInt(process.env.OPENAI_EMBEDDING_MAX_RETRIES || '2', 10);

async function withTimeout(promiseFactory, timeoutMs, requestId, description) {
  const effectiveTimeout = timeoutMs && Number.isFinite(timeoutMs) ? timeoutMs : OPENAI_EMBEDDING_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const msg = `[${requestId}] ✗ Timeout in withTimeout for ${description} after ${effectiveTimeout}ms`;
      printLog(msg);
      const err = new Error(msg);
      err.code = 'OPENAI_TIMEOUT';
      reject(err);
    }, effectiveTimeout);

    Promise.resolve()
      .then(() => promiseFactory())
      .then(result => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function callOpenAIEmbeddingsWithRetry({ input, model = "text-embedding-ada-002", requestId, description }) {
  const maxRetries = Number.isFinite(OPENAI_EMBEDDING_MAX_RETRIES) ? OPENAI_EMBEDDING_MAX_RETRIES : 2;

  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const attemptLabel = attempt === 1 ? 'initial attempt' : `retry ${attempt - 1}/${maxRetries}`;
    printLog(`[${requestId}] callOpenAIEmbeddingsWithRetry: ${attemptLabel} for ${description}`);

    try {
      const response = await withTimeout(
        () => openai.embeddings.create({ model, input }),
        OPENAI_EMBEDDING_TIMEOUT_MS,
        requestId,
        description
      );
      printLog(`[${requestId}] ✓ OpenAI embeddings succeeded on ${attemptLabel}`);
      return response;
    } catch (err) {
      lastError = err;
      printLog(`[${requestId}] ✗ OpenAI embeddings failed on ${attemptLabel}: ${err.message}`);

      if (attempt <= maxRetries) {
        const delayMs = attempt * 1000;
        printLog(`[${requestId}] Waiting ${delayMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  printLog(`[${requestId}] ✗ All retry attempts exhausted for ${description}`);
  throw lastError;
}

// ========== POST ROUTES (conditionally enabled) ==========
if (jamieExplorePostRoutesEnabled) {
  printLog('[JAMIE-EXPLORE-ROUTES] POST routes ENABLED (search-quotes-3d, fetch-research-id)');

router.post('/search-quotes-3d', async (req, res) => {
  const requestId = `SEARCH-3D-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  let { query, feedIds=[], limit = 100, minDate = null, maxDate = null, episodeName = null, fastMode = false, extractAxisLabels = false } = req.body;
  
  printLog(`[${requestId}] ========== 3D SEARCH REQUEST RECEIVED ==========`);
  printLog(`[${requestId}] Raw request body:`, JSON.stringify(req.body));
  
  // Use requested limit directly (capped at 50 for re-embedding approach)
  limit = Math.min(50, Math.max(1, Math.floor(limit)));
  printLog(`[${requestId}] Using limit: ${limit} (max 50 for performance)`);
  
  const effectiveLimit = limit; // Use it directly
  
  const startTime = Date.now();
  const timings = {
    embedding: 0,
    search: 0,
    reembedding: 0,
    umap: 0,
    axisLabeling: 0,
    total: 0
  };

  printLog(`[${requestId}] ========== 3D SEARCH REQUEST ==========`);
  printLog(`[${requestId}] Query: "${query}", Limit: ${effectiveLimit} (requested: ${limit}), FastMode: ${fastMode}`);

  if (!query) {
    printLog(`[${requestId}] ERROR: Missing query parameter`);
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    // Step 1: Get query embedding
    printLog(`[${requestId}] Step 1: Starting embedding generation...`);
    console.time(`[${requestId}] Embedding`);
    const embeddingStart = Date.now();
    
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: query
    });
    
    const embedding = embeddingResponse.data[0].embedding;
    timings.embedding = Date.now() - embeddingStart;
    console.timeEnd(`[${requestId}] Embedding`);
    printLog(`[${requestId}] ✓ Embedding generated successfully in ${timings.embedding}ms`);
    printLog(`[${requestId}] Embedding dimensions: ${embedding.length}`);

    // Step 2: Search Pinecone (WITHOUT values - Pinecone doesn't support efficient values+metadata fetch)
    printLog(`[${requestId}] Step 2: Starting Pinecone search (WITHOUT includeValues)...`);
    printLog(`[${requestId}] Note: Pinecone has system limitations fetching values efficiently at scale`);
    printLog(`[${requestId}] Pinecone query params:`, {
      limit: effectiveLimit,
      feedIds,
      minDate,
      maxDate,
      episodeName,
      includeValues: false, // Pinecone limitation: can't efficiently fetch values at scale
      includeMetadata: false // Metadata comes from MongoDB
    });
    console.time(`[${requestId}] Pinecone-Search`);
    const searchStart = Date.now();
    
    const pineconeMatches = await findSimilarDiscussions({
      embedding,
      feedIds,
      limit: effectiveLimit,
      query,
      minDate,
      maxDate,
      episodeName,
      includeValues: false, // Pinecone limitation
      includeMetadata: false // Use MongoDB instead
    });
    
    timings.search = Date.now() - searchStart;
    console.timeEnd(`[${requestId}] Pinecone-Search`);
    printLog(`[${requestId}] ✓ Pinecone search completed in ${timings.search}ms`);
    printLog(`[${requestId}] Found ${pineconeMatches.length} results`);

    // Step 3: Check minimum results requirement
    printLog(`[${requestId}] Step 3: Validating result count (need ≥4 for UMAP)...`);
    if (pineconeMatches.length < 1) {
      printLog(`[${requestId}] ✗ NO RESULTS: ${pineconeMatches.length}`);
      return res.status(400).json({ 
        error: 'No results found',
        message: `No results found for query.`,
        resultCount: pineconeMatches.length
      });
    }
    printLog(`[${requestId}] ✓ Result count validation passed: ${pineconeMatches.length} results`);
    
    // Step 3b: Fetch metadata from MongoDB (fast lookup by pineconeId index)
    printLog(`[${requestId}] Step 3b: Fetching metadata from MongoDB...`);
    const mongoStart = Date.now();
    
    const pineconeIds = pineconeMatches.map(m => m.id);
    const pineconeScores = new Map(pineconeMatches.map(m => [m.id, m.score]));
    
    const mongoDocs = await JamieVectorMetadata.find({
      pineconeId: { $in: pineconeIds }
    }).select('pineconeId metadataRaw').lean();
    
    timings.mongoLookup = Date.now() - mongoStart;
    printLog(`[${requestId}] ✓ MongoDB fetch completed in ${timings.mongoLookup}ms, found ${mongoDocs.length} documents`);
    
    // Map MongoDB docs by pineconeId
    const mongoMetadataMap = new Map(mongoDocs.map(doc => [doc.pineconeId, doc.metadataRaw]));
    
    // Merge Pinecone results with MongoDB metadata
    const mergedResults = pineconeMatches.map(pineconeMatch => {
      const metadata = mongoMetadataMap.get(pineconeMatch.id);
      if (!metadata) {
        printLog(`[${requestId}] ⚠️ No MongoDB metadata found for Pinecone ID: ${pineconeMatch.id}`);
        return null;
      }
      return {
        id: pineconeMatch.id,
        score: pineconeMatch.score,
        metadata: metadata
      };
    }).filter(Boolean);
    
    // Format results (this adds hierarchyLevel and other display fields)
    const similarDiscussions = formatResults(mergedResults);
    printLog(`[${requestId}] ✓ Merged Pinecone + MongoDB data: ${similarDiscussions.length} results`);
    
    // Step 3c: Re-embed texts for UMAP (Pinecone fetch() tested but slower than re-embedding)
    printLog(`[${requestId}] Step 3c: Re-embedding texts for UMAP projection...`);
    const reembedStart = Date.now();
    
    // Extract texts from results
    const texts = similarDiscussions.map(result => result.quote || result.summary || result.description || '');
    printLog(`[${requestId}] Extracted ${texts.length} text snippets`);
    if (texts.length > 0) {
      printLog(
        `[${requestId}] Sample text (first 100 chars): "${(texts[0] || '').substring(0, 100)}..."`
      );
    }
    
    // Batch embed all texts
    printLog(
      `[${requestId}] Calling OpenAI batch embeddings API with timeout=${OPENAI_EMBEDDING_TIMEOUT_MS}ms and maxRetries=${OPENAI_EMBEDDING_MAX_RETRIES}...`
    );
    
    const batchEmbeddingResponse = await callOpenAIEmbeddingsWithRetry({
      input: texts,
      model: "text-embedding-ada-002",
      requestId,
      description: "3D search batch embeddings"
    });
    
    const embeddings = batchEmbeddingResponse.data.map(item => item.embedding);
    timings.reembedding = Date.now() - reembedStart;
    
    printLog(`[${requestId}] ✓ Re-embedded ${embeddings.length} texts in ${timings.reembedding}ms`);
    printLog(`[${requestId}] Embedding dimensions: ${embeddings[0]?.length || 0}`);
    printLog(`[${requestId}] Cost estimate: ~$${(texts.join(' ').length / 1000 * 0.0001).toFixed(4)}`);
    
    // Step 3d: Enrich chapter/paragraph results with episode metadata
    printLog(`[${requestId}] Step 3d: Enriching results with episode metadata where missing...`);
    const episodeCache = {};
    const guidsToFetch = new Set();

    // First pass: collect GUIDs for which we need episode data
    similarDiscussions.forEach(result => {
      // We care about non-feed items that have a guid in additionalFields
      const guidForResult = result?.additionalFields?.guid;
      const level = result?.hierarchyLevel;

      if (!guidForResult) return;
      if (level !== 'chapter' && level !== 'paragraph') return;

      // Only fetch if key episode fields are missing or generic
      const missingEpisodeTitle = !result.episode || result.episode === 'Unknown episode';
      const missingEpisodeImage = !result.episodeImage || result.episodeImage === 'Image unavailable';
      const missingAudioUrl = !result.audioUrl || result.audioUrl === 'URL unavailable';

      if (missingEpisodeTitle || missingEpisodeImage || missingAudioUrl) {
        guidsToFetch.add(guidForResult);
      }
    });

    printLog(
      `[${requestId}] Episode enrichment: identified ${guidsToFetch.size} GUIDs needing episode data`
    );

    // Fetch episode data in parallel for all needed GUIDs
    if (guidsToFetch.size > 0) {
      const guidList = Array.from(guidsToFetch);
      const episodePromises = guidList.map(async guid => {
        try {
          const episodeData = await getEpisodeByGuid(guid);
          if (episodeData) {
            episodeCache[guid] = episodeData;
          } else {
            printLog(`[${requestId}] Episode enrichment: no episode found for guid=${guid}`);
          }
        } catch (e) {
          printLog(
            `[${requestId}] Episode enrichment: error fetching episode for guid=${guid}: ${e.message}`
          );
        }
      });

      await Promise.all(episodePromises);
      printLog(
        `[${requestId}] Episode enrichment: fetched metadata for ${
          Object.keys(episodeCache).length
        } episodes`
      );

      // Second pass: apply episode metadata to chapter/paragraph results
      similarDiscussions.forEach(result => {
        const guidForResult = result?.additionalFields?.guid;
        const level = result?.hierarchyLevel;
        if (!guidForResult) return;
        if (level !== 'chapter' && level !== 'paragraph') return;

        const ep = episodeCache[guidForResult];
        if (!ep) return;

        // Fill in missing/generic fields from episode metadata
        if (!result.episode || result.episode === 'Unknown episode') {
          result.episode = ep.title || result.episode;
        }
        if (!result.episodeImage || result.episodeImage === 'Image unavailable') {
          if (ep.episodeImage) result.episodeImage = ep.episodeImage;
        }
        if (!result.audioUrl || result.audioUrl === 'URL unavailable') {
          if (ep.audioUrl) result.audioUrl = ep.audioUrl;
        }
        if (!result.creator || result.creator === 'Creator not specified') {
          if (ep.creator) result.creator = ep.creator;
        }
        if (!result.description && ep.description) {
          result.description = ep.description;
        }
      });
    }
    
    // Step 4: Skip UMAP if less than 4 results
    if (similarDiscussions.length < 4) {
      printLog(`[${requestId}] ⚠️ Less than 4 results (${similarDiscussions.length}) - skipping UMAP`);
      timings.total = Date.now() - startTime;
      return res.json({
        query,
        results: similarDiscussions.map(r => {
          const { embedding, values, ...rest } = r;
          return { ...rest, coordinates3d: { x: 0, y: 0, z: 0 } }; // Dummy coords
        }),
        total: similarDiscussions.length,
        model: "text-embedding-ada-002",
        metadata: {
          numResults: similarDiscussions.length,
          embeddingTimeMs: timings.embedding,
          searchTimeMs: timings.search,
          mongoLookupTimeMs: timings.mongoLookup,
          reembeddingTimeMs: timings.reembedding,
          umapTimeMs: 0,
          totalTimeMs: timings.total,
          fastMode: false,
          umapConfig: 'skipped',
          debugMode: true,
          skippedUMAP: true,
          approach: 'mongodb-optimized'
        }
      });
    }

    // Step 5: Project to 3D using UMAP
    printLog(`[${requestId}] Step 5: Starting UMAP projection to 3D...`);
    printLog(`[${requestId}] UMAP mode: ${fastMode ? 'FAST' : 'STANDARD'}`);
    console.time(`[${requestId}] UMAP-Projection`);
    const umapStart = Date.now();
    
    const UmapProjector = require('../utils/UmapProjector');
    const projectorConfig = fastMode 
      ? UmapProjector.getFastModeConfig() 
      : {}; // Use default config
    
    printLog(`[${requestId}] Creating UMAP projector with config:`, projectorConfig);
    const projector = new UmapProjector(projectorConfig);
    
    printLog(`[${requestId}] Calling UMAP project() with ${embeddings.length} embeddings...`);
    const coordinates3d = await projector.project(embeddings);
    
    timings.umap = Date.now() - umapStart;
    console.timeEnd(`[${requestId}] UMAP-Projection`);
    printLog(`[${requestId}] ✓ UMAP projection completed in ${timings.umap}ms`);
    printLog(`[${requestId}] Generated ${coordinates3d.length} 3D coordinates`);
    printLog(`[${requestId}] Sample coordinate:`, coordinates3d[0]);

    // Step 6: Attach 3D coordinates to results
    printLog(`[${requestId}] Step 6: Attaching 3D coordinates to results...`);
    const results3d = similarDiscussions.map((result, index) => {
      // Remove embedding/values from response (too large, not needed by client)
      const { embedding, values, ...resultWithoutEmbedding } = result;
      
      return {
        ...resultWithoutEmbedding,
        coordinates3d: coordinates3d[index]
        // hierarchyLevel already added by formatResults
      };
    });
    printLog(`[${requestId}] ✓ Attached coordinates to ${results3d.length} results`);

    // Step 7: Extract axis labels (optional)
    let axisLabels = null;
    if (extractAxisLabels && results3d.length >= 7) {
      printLog(`[${requestId}] Step 7: Extracting axis labels for semantic space...`);
      console.time(`[${requestId}] Axis-Labeling`);
      const labelingStart = Date.now();
      
      try {
        // Find 7 cardinal points: center, +/-X, +/-Y, +/-Z
        const findClosestPoint = (targetX, targetY, targetZ) => {
          let minDist = Infinity;
          let closestIndex = 0;
          
          results3d.forEach((result, index) => {
            const { x, y, z } = result.coordinates3d;
            const dist = Math.sqrt(
              Math.pow(x - targetX, 2) + 
              Math.pow(y - targetY, 2) + 
              Math.pow(z - targetZ, 2)
            );
            if (dist < minDist) {
              minDist = dist;
              closestIndex = index;
            }
          });
          
          return closestIndex;
        };
        
        const cardinalIndices = {
          center: findClosestPoint(0, 0, 0),
          xPositive: findClosestPoint(1, 0, 0),
          xNegative: findClosestPoint(-1, 0, 0),
          yPositive: findClosestPoint(0, 1, 0),
          yNegative: findClosestPoint(0, -1, 0),
          zPositive: findClosestPoint(0, 0, 1),
          zNegative: findClosestPoint(0, 0, -1)
        };
        
        printLog(`[${requestId}] Found cardinal point indices:`, cardinalIndices);
        
        // Extract texts from cardinal points
        const getTextFromResult = (result) => {
          // Use appropriate field based on hierarchyLevel
          let text = '';
          
          switch(result.hierarchyLevel) {
            case 'paragraph':
              text = result.quote || result.text || '';
              break;
            case 'chapter':
              text = result.summary || result.headline || '';
              break;
            case 'episode':
              text = result.description || result.title || '';
              break;
            case 'feed':
              text = result.description || result.title || '';
              break;
            default:
              // Fallback: try all fields
              text = result.quote || result.text || result.summary || result.description || '';
          }
          
          // Final fallback if still empty
          if (!text || text.length < 20) {
            text = `${result.episode || result.title || ''} by ${result.creator || ''}`.trim() || 'No text available';
          }
          
          return text;
        };
        
        const cardinalTexts = {
          center: getTextFromResult(results3d[cardinalIndices.center]),
          xPositive: getTextFromResult(results3d[cardinalIndices.xPositive]),
          xNegative: getTextFromResult(results3d[cardinalIndices.xNegative]),
          yPositive: getTextFromResult(results3d[cardinalIndices.yPositive]),
          yNegative: getTextFromResult(results3d[cardinalIndices.yNegative]),
          zPositive: getTextFromResult(results3d[cardinalIndices.zPositive]),
          zNegative: getTextFromResult(results3d[cardinalIndices.zNegative])
        };
        
        printLog(`[${requestId}] Extracted texts from cardinal points (truncated):`, 
          Object.fromEntries(
            Object.entries(cardinalTexts).map(([k, v]) => [k, v.substring(0, 80) + '...'])
          )
        );
        
        // Log text lengths and hierarchy levels to debug
        printLog(`[${requestId}] Cardinal points metadata:`, 
          Object.fromEntries(
            Object.entries(cardinalIndices).map(([k, idx]) => [
              k, 
              {
                hierarchyLevel: results3d[idx].hierarchyLevel,
                textLength: cardinalTexts[k].length,
                hasQuote: !!results3d[idx].quote,
                hasDescription: !!results3d[idx].description,
                hasSummary: !!results3d[idx].summary
              }
            ])
          )
        );
        
        // Call OpenAI to generate labels
        printLog(`[${requestId}] Calling OpenAI to generate semantic labels...`);
        const labelingPrompt = `You are analyzing a 3D semantic space visualization where similar content clusters together. For each text excerpt below, provide a concise thematic label (1-3 words maximum) that captures its core concept.

1. CENTER (average of all content): "${cardinalTexts.center.substring(0, 300)}"

2. +X AXIS (one semantic extreme): "${cardinalTexts.xPositive.substring(0, 300)}"

3. -X AXIS (opposite semantic extreme): "${cardinalTexts.xNegative.substring(0, 300)}"

4. +Y AXIS (another semantic dimension): "${cardinalTexts.yPositive.substring(0, 300)}"

5. -Y AXIS (opposite dimension): "${cardinalTexts.yNegative.substring(0, 300)}"

6. +Z AXIS (third semantic dimension): "${cardinalTexts.zPositive.substring(0, 300)}"

7. -Z AXIS (opposite dimension): "${cardinalTexts.zNegative.substring(0, 300)}"

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{"center": "label", "xPositive": "label", "xNegative": "label", "yPositive": "label", "yNegative": "label", "zPositive": "label", "zNegative": "label"}`;

        const labelingResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: labelingPrompt }],
          temperature: 0.3,
          max_tokens: 150
        });
        
        const labelsText = labelingResponse.choices[0].message.content.trim();
        printLog(`[${requestId}] Raw OpenAI response:`, labelsText);
        
        axisLabels = JSON.parse(labelsText);
        
        timings.axisLabeling = Date.now() - labelingStart;
        console.timeEnd(`[${requestId}] Axis-Labeling`);
        printLog(`[${requestId}] ✓ Generated axis labels in ${timings.axisLabeling}ms:`, axisLabels);
        
      } catch (error) {
        printLog(`[${requestId}] ✗ Failed to generate axis labels:`, error.message);
        printLog(`[${requestId}] Continuing without axis labels...`);
        timings.axisLabeling = Date.now() - labelingStart;
        // Don't fail the entire request, just skip axis labels
      }
    } else if (extractAxisLabels) {
      printLog(`[${requestId}] Skipping axis labels: need at least 7 results (got ${results3d.length})`);
    }

    // Calculate total time
    timings.total = Date.now() - startTime;

    printLog(`[${requestId}] ========== 3D SEARCH COMPLETED SUCCESSFULLY ==========`);
    printLog(`[${requestId}] Performance breakdown:`);
    printLog(`[${requestId}]   - Query Embedding: ${timings.embedding}ms`);
    printLog(`[${requestId}]   - Pinecone Search: ${timings.search}ms`);
    printLog(`[${requestId}]   - MongoDB Lookup: ${timings.mongoLookup}ms`);
    printLog(`[${requestId}]   - Re-embedding: ${timings.reembedding}ms`);
    printLog(`[${requestId}]   - UMAP Projection: ${timings.umap}ms`);
    if (extractAxisLabels) printLog(`[${requestId}]   - Axis Labeling: ${timings.axisLabeling}ms`);
    printLog(`[${requestId}]   - Total: ${timings.total}ms`);
    printLog(`[${requestId}] Returning ${results3d.length} results with 3D coordinates`);

    // Return results with metadata
    const response = {
      query,
      results: results3d,
      total: results3d.length,
      model: "text-embedding-ada-002",
      metadata: {
        numResults: results3d.length,
        embeddingTimeMs: timings.embedding,
        searchTimeMs: timings.search,
        mongoLookupTimeMs: timings.mongoLookup,
        reembeddingTimeMs: timings.reembedding,
        umapTimeMs: timings.umap,
        axisLabelingTimeMs: timings.axisLabeling,
        totalTimeMs: timings.total,
        fastMode: fastMode,
        umapConfig: fastMode ? 'fast' : 'standard',
        limitCapped: limit !== effectiveLimit,
        requestedLimit: limit,
        effectiveLimit: effectiveLimit,
        approach: 'mongodb-optimized-metadata'
      }
    };
    
    // Add axis labels if generated
    if (axisLabels) {
      response.axisLabels = axisLabels;
    }
    
    res.json(response);

  } catch (error) {
    timings.total = Date.now() - startTime;
    
    printLog(`[${requestId}] ========== 3D SEARCH FAILED ==========`);
    printLog(`[${requestId}] ✗ Error after ${timings.total}ms:`, error.message);
    printLog(`[${requestId}] Error type:`, error.constructor.name);
    printLog(`[${requestId}] Stack trace:`, error.stack);
    
    console.error(`[${requestId}] ERROR: ${error.message}`);
    console.error(`[${requestId}] Stack trace:`, error.stack);
    
    // Determine appropriate error response
    if (error.message.includes('at least 4 points') || error.message.includes('Insufficient results')) {
      printLog(`[${requestId}] Error category: INSUFFICIENT_RESULTS`);
      return res.status(400).json({ 
        error: 'Insufficient results for 3D visualization',
        message: error.message,
        details: error.message 
      });
    } else if (error.message.includes('UMAP') || error.message.includes('projection')) {
      printLog(`[${requestId}] Error category: UMAP_FAILURE`);
      return res.status(500).json({ 
        error: 'Failed to generate 3D projection',
        message: 'The dimensionality reduction algorithm encountered an error. Please try again.',
        details: error.message,
        requestId
      });
    } else {
      printLog(`[${requestId}] Error category: GENERAL_ERROR`);
      return res.status(500).json({ 
        error: 'Failed to perform 3D search',
        message: 'An unexpected error occurred. Please try again.',
        details: error.message,
        requestId
      });
    }
  }
});

router.post('/fetch-research-id', async (req, res) => {
  const requestId = `FETCH-3D-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  let { researchSessionId, fastMode = false, extractAxisLabels = false } = req.body || {};

  printLog(`[${requestId}] ========== FETCH RESEARCH SESSION 3D REQUEST RECEIVED ==========`);
  printLog(`[${requestId}] Raw request body:`, JSON.stringify(req.body));

  if (!researchSessionId || typeof researchSessionId !== 'string') {
    printLog(`[${requestId}] ERROR: Missing or invalid researchSessionId`);
    return res.status(400).json({ error: 'researchSessionId is required' });
  }

  const startTime = Date.now();
  const timings = {
    embedding: 0,
    search: 0,
    reembedding: 0,
    umap: 0,
    axisLabeling: 0,
    total: 0
  };

  try {
    // Load the research session and its stored items
    printLog(`[${requestId}] Step 1: Loading research session ${researchSessionId}...`);
    const session = await ResearchSession.findById(researchSessionId).lean().exec();
    if (!session) {
      printLog(`[${requestId}] ✗ Research session not found`);
      return res.status(404).json({
        error: 'Research session not found',
        details: 'No research session found for this id'
      });
    }

    const rawItems = Array.isArray(session.items) ? session.items : [];

    const items = rawItems
      .map((it) => (it && it.metadata ? it : null))
      .filter(Boolean);

    if (!items.length) {
      printLog(`[${requestId}] ✗ Research session has no items`);
      return res.status(400).json({
        error: 'Empty research session',
        details: 'This research session has no items to project'
      });
    }

    // Enrich results with episode metadata (same as search-quotes-3d Step 3b)
    printLog(`[${requestId}] Step 2: Enriching results with episode metadata where missing...`);
    const similarDiscussions = items.map((item) => {
      const base = item.metadata ? { ...item.metadata } : {};
      const storedCoords = item.coordinates3d || null;
      if (storedCoords && typeof storedCoords === 'object') {
        const x = typeof storedCoords.x === 'number' ? storedCoords.x : null;
        const y = typeof storedCoords.y === 'number' ? storedCoords.y : null;
        const z = typeof storedCoords.z === 'number' ? storedCoords.z : null;
        base.coordinates3d = { x, y, z };
      }
      return base;
    });
    const episodeCache = {};
    const guidsToFetch = new Set();

    similarDiscussions.forEach(result => {
      const guidForResult = result?.additionalFields?.guid;
      const level = result?.hierarchyLevel;

      if (!guidForResult) return;
      if (level !== 'chapter' && level !== 'paragraph') return;

      const missingEpisodeTitle = !result.episode || result.episode === 'Unknown episode';
      const missingEpisodeImage = !result.episodeImage || result.episodeImage === 'Image unavailable';
      const missingAudioUrl = !result.audioUrl || result.audioUrl === 'URL unavailable';

      if (missingEpisodeTitle || missingEpisodeImage || missingAudioUrl) {
        guidsToFetch.add(guidForResult);
      }
    });

    printLog(
      `[${requestId}] Episode enrichment: identified ${guidsToFetch.size} GUIDs needing episode data`
    );

    if (guidsToFetch.size > 0) {
      const guidList = Array.from(guidsToFetch);
      const episodePromises = guidList.map(async guid => {
        try {
          const episodeData = await getEpisodeByGuid(guid);
          if (episodeData) {
            episodeCache[guid] = episodeData;
          } else {
            printLog(`[${requestId}] Episode enrichment: no episode found for guid=${guid}`);
          }
        } catch (e) {
          printLog(
            `[${requestId}] Episode enrichment: error fetching episode for guid=${guid}: ${e.message}`
          );
        }
      });

      await Promise.all(episodePromises);
      printLog(
        `[${requestId}] Episode enrichment: fetched metadata for ${
          Object.keys(episodeCache).length
        } episodes`
      );

      similarDiscussions.forEach(result => {
        const guidForResult = result?.additionalFields?.guid;
        const level = result?.hierarchyLevel;
        if (!guidForResult) return;
        if (level !== 'chapter' && level !== 'paragraph') return;

        const ep = episodeCache[guidForResult];
        if (!ep) return;

        if (!result.episode || result.episode === 'Unknown episode') {
          result.episode = ep.title || result.episode;
        }
        if (!result.episodeImage || result.episodeImage === 'Image unavailable') {
          if (ep.episodeImage) result.episodeImage = ep.episodeImage;
        }
        if (!result.audioUrl || result.audioUrl === 'URL unavailable') {
          if (ep.audioUrl) result.audioUrl = ep.audioUrl;
        }
        if (!result.creator || result.creator === 'Creator not specified') {
          if (ep.creator) result.creator = ep.creator;
        }
        if (!result.description && ep.description) {
          result.description = ep.description;
        }
      });
    }

    if (similarDiscussions.length < 1) {
      printLog(`[${requestId}] ✗ No items after enrichment`);
      return res.status(400).json({
        error: 'No items to project',
        message: 'No valid items found in this research session.',
        resultCount: similarDiscussions.length
      });
    }

    // Helper to ensure we have non-null coordinates, falling back to small random offsets.
    const amplitude = 0.2;
    const randomCoord = () => (Math.random() * 2 * amplitude) - amplitude;

    const ensureCoordinates = (result) => {
      const existing = result.coordinates3d && typeof result.coordinates3d === 'object'
        ? result.coordinates3d
        : {};
      const x = typeof existing.x === 'number' ? existing.x : randomCoord();
      const y = typeof existing.y === 'number' ? existing.y : randomCoord();
      const z = typeof existing.z === 'number' ? existing.z : randomCoord();
      return { ...result, coordinates3d: { x, y, z } };
    };

    // If less than 4, skip UMAP and use stored/randomized coordinates from MongoDB.
    if (similarDiscussions.length < 4) {
      printLog(
        `[${requestId}] ⚠️ Less than 4 items (${similarDiscussions.length}) - skipping UMAP and using stored/randomized coordinates`
      );
      timings.total = Date.now() - startTime;

      const resultsWithCoords = similarDiscussions.map(ensureCoordinates);

      return res.json({
        query: researchSessionId,
        results: resultsWithCoords,
        total: resultsWithCoords.length,
        model: "text-embedding-ada-002",
        metadata: {
          numResults: resultsWithCoords.length,
          embeddingTimeMs: timings.embedding,
          searchTimeMs: timings.search,
          reembeddingTimeMs: timings.reembedding,
          umapTimeMs: timings.umap,
          totalTimeMs: timings.total,
          fastMode,
          umapConfig: 'skipped',
          debugMode: true,
          skippedUMAP: true,
          approach: 'research-session',
          coordinateHint:
            'Some points use randomized coordinates in [-0.2, 0.2]. ' +
            'To control layout, include a coordinatesById map with x,y,z per pineconeId when creating or updating this research session.'
        },
        axisLabels: null
      });
    }

    // Re-embed quotes and run UMAP, same as search-quotes-3d
    printLog(`[${requestId}] Step 3: Re-embedding ${similarDiscussions.length} items...`);

    console.time(`[${requestId}] Re-embedding`);
    const reembedStart = Date.now();

    const texts = similarDiscussions.map(result => result.quote || '');
    printLog(`[${requestId}] Extracted ${texts.length} text snippets`);
    if (texts.length > 0) {
      printLog(
        `[${requestId}] Sample text (first 100 chars): "${(texts[0] || '').substring(0, 100)}..."`
      );
    }

    const batchEmbeddingResponse = await callOpenAIEmbeddingsWithRetry({
      input: texts,
      model: "text-embedding-ada-002",
      requestId,
      description: "research-session 3D batch embeddings"
    });

    const embeddings = batchEmbeddingResponse.data.map(item => item.embedding);
    timings.reembedding = Date.now() - reembedStart;
    console.timeEnd(`[${requestId}] Re-embedding`);

    printLog(`[${requestId}] ✓ Re-embedded ${embeddings.length} texts in ${timings.reembedding}ms`);

    // UMAP projection
    printLog(`[${requestId}] Step 4: Starting UMAP projection to 3D...`);
    printLog(`[${requestId}] UMAP mode: ${fastMode ? 'FAST' : 'STANDARD'}`);
    console.time(`[${requestId}] UMAP-Projection`);
    const umapStart = Date.now();

    const UmapProjector = require('../utils/UmapProjector');
    const projectorConfig = fastMode
      ? UmapProjector.getFastModeConfig()
      : {};

    printLog(`[${requestId}] Creating UMAP projector with config:`, projectorConfig);
    const projector = new UmapProjector(projectorConfig);

    printLog(`[${requestId}] Calling UMAP project() with ${embeddings.length} embeddings...`);
    const coordinates3d = await projector.project(embeddings);

    timings.umap = Date.now() - umapStart;
    console.timeEnd(`[${requestId}] UMAP-Projection`);
    printLog(`[${requestId}] ✓ UMAP projection completed in ${timings.umap}ms`);

    // Attach coordinates
    printLog(`[${requestId}] Step 5: Attaching 3D coordinates to items...`);
    const results3d = similarDiscussions.map((result, index) => ({
      ...result,
      coordinates3d: coordinates3d[index]
    }));

    // Optional axis labels
    let axisLabels = null;
    if (extractAxisLabels && results3d.length >= 7) {
      printLog(`[${requestId}] Step 6: Extracting axis labels for semantic space...`);
      console.time(`[${requestId}] Axis-Labeling`);
      const labelingStart = Date.now();

      try {
        const findClosestPoint = (targetX, targetY, targetZ) => {
          let minDist = Infinity;
          let closestIndex = 0;

          results3d.forEach((result, index) => {
            const { x, y, z } = result.coordinates3d;
            const dist = Math.sqrt(
              Math.pow(x - targetX, 2) +
              Math.pow(y - targetY, 2) +
              Math.pow(z - targetZ, 2)
            );
            if (dist < minDist) {
              minDist = dist;
              closestIndex = index;
            }
          });

          return closestIndex;
        };

        const cardinalIndices = {
          center: findClosestPoint(0, 0, 0),
          xPositive: findClosestPoint(1, 0, 0),
          xNegative: findClosestPoint(-1, 0, 0),
          yPositive: findClosestPoint(0, 1, 0),
          yNegative: findClosestPoint(0, -1, 0),
          zPositive: findClosestPoint(0, 0, 1),
          zNegative: findClosestPoint(0, 0, -1)
        };

        const getTextFromResult = (result) => {
          let text = '';

          switch(result.hierarchyLevel) {
            case 'paragraph':
              text = result.quote || result.text || '';
              break;
            case 'chapter':
              text = result.headline || result.summary || '';
              break;
            case 'episode':
            case 'feed':
            default:
              text = result.description || result.summary || result.headline || result.quote || '';
              break;
          }

          return text || result.quote || '';
        };

        const labelPrompts = {
          center: 'a short phrase describing what these clips have in common',
          xPositive: 'what semantic theme is strongest at the positive X direction?',
          xNegative: 'what semantic theme is strongest at the negative X direction?',
          yPositive: 'what semantic theme is strongest at the positive Y direction?',
          yNegative: 'what semantic theme is strongest at the negative Y direction?',
          zPositive: 'what semantic theme is strongest at the positive Z direction?',
          zNegative: 'what semantic theme is strongest at the negative Z direction?'
        };

        axisLabels = {};

        for (const [axis, index] of Object.entries(cardinalIndices)) {
          const result = results3d[index];
          const text = getTextFromResult(result);

          if (!text) {
            axisLabels[axis] = null;
            continue;
          }

          const labelingResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content:
                  'You are helping label semantic axes in a 3D embedding space of podcast clips. ' +
                  'Given an example clip, respond with a very short 1-3 word label capturing its main theme. ' +
                  'Do not add quotes or extra explanation.'
              },
              {
                role: 'user',
                content: `Example text:\n\n${text}\n\nQuestion: ${labelPrompts[axis]}\n\nAxis label:`
              }
            ],
            max_tokens: 16,
            temperature: 0.4
          });

          const rawLabel = labelingResponse.choices?.[0]?.message?.content || '';
          const firstLine = rawLabel.split('\n')[0].trim();
          axisLabels[axis] = firstLine.replace(/^["']|["']$/g, '').trim();
        }

        timings.axisLabeling = Date.now() - labelingStart;
        console.timeEnd(`[${requestId}] Axis-Labeling`);
      } catch (e) {
        printLog(`[${requestId}] Axis labeling failed: ${e.message}`);
        axisLabels = null;
      }
    }

    timings.total = Date.now() - startTime;

    return res.json({
      query: researchSessionId,
      results: results3d,
      total: results3d.length,
      model: "text-embedding-ada-002",
      metadata: {
        numResults: results3d.length,
        embeddingTimeMs: timings.embedding,
        searchTimeMs: timings.search,
        reembeddingTimeMs: timings.reembedding,
        umapTimeMs: timings.umap,
        axisLabelingTimeMs: timings.axisLabeling,
        totalTimeMs: timings.total,
        fastMode,
        umapConfig: fastMode ? 'fast' : 'standard',
        limitCapped: false,
        requestedLimit: results3d.length,
        effectiveLimit: results3d.length,
        approach: 'research-session'
      },
      axisLabels
    });
  } catch (error) {
    printLog(`[${requestId}] ✗ Error in fetch-research-id: ${error.message}`);
    timings.total = Date.now() - startTime;
    console.error('Fetch research session 3D error:', error);
    return res.status(500).json({
      error: 'Failed to fetch research session in 3D',
      details: error.message
    });
  }
});

} else {
  printLog('[JAMIE-EXPLORE-ROUTES] POST routes DISABLED (search-quotes-3d, fetch-research-id)');
}

// ========== GET ROUTES (always enabled) ==========

router.get('/episode-with-chapters/:guid', async (req, res) => {
  try {
    const { guid } = req.params;
    console.log(`Fetching episode with chapters for GUID: ${guid}`);
    
    // Initialize Pinecone
    const { Pinecone } = require('@pinecone-database/pinecone');
    const pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });
    const index = pinecone.index(process.env.PINECONE_INDEX);
    
    // Step 1: Fetch the episode
    const episodeId = `episode_${guid}`;
    const episodeFetch = await withPineconeTimeout(
      'episode-with-chapters:fetch-episode',
      () => index.fetch([episodeId])
    );
    
    if (!episodeFetch.records || !episodeFetch.records[episodeId]) {
      return res.status(404).json({ 
        error: 'Episode not found',
        guid 
      });
    }
    
    const episode = {
      id: episodeId,
      guid: guid,
      metadata: episodeFetch.records[episodeId].metadata
    };
    
    console.log(`Found episode: ${episode.metadata.title || 'Unknown Title'}`);
    
    // Step 2: Query for all chapters with this guid
    const dummyVector = Array(1536).fill(0);
    const chaptersQuery = await withPineconeTimeout(
      'episode-with-chapters:query-chapters',
      () => index.query({
        vector: dummyVector,
        filter: {
          type: "chapter",
          guid: guid
        },
        topK: 100, // Get up to 100 chapters (should be more than enough)
        includeMetadata: true
      })
    );
    
    // Format chapters
    const chapters = chaptersQuery.matches.map(match => ({
      id: match.id,
      metadata: match.metadata,
      chapterNumber: match.metadata.chapterNumber,
      headline: match.metadata.headline,
      startTime: match.metadata.startTime,
      endTime: match.metadata.endTime
    }));
    
    // Sort chapters by chapter number or start time
    chapters.sort((a, b) => {
      if (a.chapterNumber !== undefined && b.chapterNumber !== undefined) {
        return a.chapterNumber - b.chapterNumber;
      }
      return (a.startTime || 0) - (b.startTime || 0);
    });
    
    console.log(`Found ${chapters.length} chapters for episode`);
    
    res.json({
      success: true,
      guid,
      episode,
      chapters,
      chapterCount: chapters.length
    });
    
  } catch (error) {
    console.error('Error fetching episode with chapters:', error);
    res.status(500).json({ 
      error: 'Failed to fetch episode with chapters',
      details: error.message,
      guid: req.params.guid
    });
  }
});

router.get('/fetch-adjacent-paragraphs', async (req, res) => {
  try {
    const { paragraphId, adjacentSteps = 3 } = req.query;
    
    // Validate required parameter
    if (!paragraphId) {
      return res.status(400).json({ 
        error: 'Missing required parameter: paragraphId',
        example: '/api/fetch-adjacent-paragraphs?paragraphId=0012a7a4-bc1c-11ef-a566-bf3ecfcd8d34_p24&adjacentSteps=3'
      });
    }

    // Parse adjacentSteps as integer
    const steps = parseInt(adjacentSteps, 10);
    if (isNaN(steps) || steps < 0) {
      return res.status(400).json({ 
        error: 'adjacentSteps must be a non-negative number',
        provided: adjacentSteps
      });
    }

    console.log(`Fetching adjacent paragraphs for: ${paragraphId}, steps: ${steps}`);

    // Parse the paragraph ID to extract base GUID and paragraph number
    if (!paragraphId.includes('_p')) {
      return res.status(400).json({ 
        error: 'Invalid paragraph ID format. Expected format: {guid}_p{number}',
        example: '0012a7a4-bc1c-11ef-a566-bf3ecfcd8d34_p24',
        provided: paragraphId
      });
    }

    const lastPIndex = paragraphId.lastIndexOf('_p');
    const baseId = paragraphId.substring(0, lastPIndex);
    const paragraphNumStr = paragraphId.substring(lastPIndex + 2);
    const paragraphNum = parseInt(paragraphNumStr, 10);

    if (isNaN(paragraphNum)) {
      return res.status(400).json({ 
        error: 'Invalid paragraph number. Must be a number after _p',
        provided: paragraphNumStr
      });
    }

    // Calculate range (avoid negative paragraph numbers)
    const startNum = Math.max(0, paragraphNum - steps);
    const endNum = paragraphNum + steps;

    // Generate array of paragraph IDs to fetch
    const paragraphIds = [];
    for (let i = startNum; i <= endNum; i++) {
      paragraphIds.push(`${baseId}_p${i}`);
    }

    console.log(`Fetching paragraph range: ${startNum} to ${endNum} (${paragraphIds.length} total)`);

    // Fetch all paragraphs from MongoDB
    // Note: Don't use .select() with nested fields - just fetch the whole metadataRaw
    const mongoDocs = await JamieVectorMetadata.find({
      pineconeId: { $in: paragraphIds },
      type: 'paragraph'
    }).lean();

    // Create a map for quick lookup
    const docsMap = new Map(mongoDocs.map(doc => [doc.pineconeId, doc]));

    // Process results and maintain order
    const paragraphs = [];
    const missing = [];

    for (const id of paragraphIds) {
      const doc = docsMap.get(id);
      if (doc) {
        const textValue = doc.text || doc.metadataRaw?.text || null;
        paragraphs.push({
          id: id,
          metadata: doc.metadataRaw || {},
          text: textValue,
          start_time: doc.start_time ?? doc.metadataRaw?.start_time ?? null,
          end_time: doc.end_time ?? doc.metadataRaw?.end_time ?? null,
          episode: doc.episode || doc.metadataRaw?.episode || null,
          creator: doc.creator || doc.metadataRaw?.creator || null
        });
      } else {
        missing.push(id);
      }
    }

    console.log(`Found ${paragraphs.length} paragraphs, ${missing.length} missing`);

    // Return structured response
    res.json({
      requestedId: paragraphId,
      adjacentSteps: steps,
      range: {
        start: startNum,
        end: endNum
      },
      paragraphs: paragraphs,
      found: paragraphs.length,
      missing: missing,
      totalRequested: paragraphIds.length
    });

  } catch (error) {
    console.error('Error fetching adjacent paragraphs:', error);
    res.status(500).json({ 
      error: 'Failed to fetch adjacent paragraphs',
      details: error.message
    });
  }
});

router.get('/get-hierarchy', async (req, res) => {
  const requestId = `HIERARCHY-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timings = {
    total: 0,
    mongoLookup: 0,
    mongoChapterQuery: 0,
    formatting: 0
  };
  const startTime = Date.now();
  
  try {
    const { paragraphId, chapterId } = req.query;
    
    printLog(`[${requestId}] ========== GET HIERARCHY REQUEST ==========`);
    printLog(`[${requestId}] paragraphId: ${paragraphId}, chapterId: ${chapterId}`);
    
    // Validate: must provide exactly one of paragraphId or chapterId
    if (!paragraphId && !chapterId) {
      return res.status(400).json({ 
        error: 'Missing required parameter: paragraphId or chapterId',
        examples: [
          '/api/get-hierarchy?paragraphId=b046291e-2e15-4ae5-87e6-4f569283c79a_p6',
          '/api/get-hierarchy?chapterId=b046291e-2e15-4ae5-87e6-4f569283c79a_chunked_chapter_1'
        ]
      });
    }
    
    if (paragraphId && chapterId) {
      return res.status(400).json({ 
        error: 'Cannot provide both paragraphId and chapterId. Choose one.',
        provided: { paragraphId, chapterId }
      });
    }

    const JamieVectorMetadata = require('../models/JamieVectorMetadata');
    
    let paragraph = null;
    let chapter = null;
    let episode = null;
    let feed = null;
    let guid = null;
    let feedId = null;
    let startingPoint = null;

    if (chapterId) {
      // CHAPTER MODE: Start from chapter, go UP only
      printLog(`[${requestId}] Mode: CHAPTER - starting from ${chapterId}`);
      startingPoint = 'chapter';

      // Step 1: Fetch the chapter from MongoDB
      printLog(`[${requestId}] Step 1: Fetching chapter from MongoDB...`);
      const mongoStart = Date.now();
      
      const chapterDoc = await JamieVectorMetadata.findOne({ 
        pineconeId: chapterId 
      })
      .select('pineconeId metadataRaw')
      .lean();
      
      timings.mongoLookup += Date.now() - mongoStart;
      
      if (!chapterDoc || !chapterDoc.metadataRaw) {
        printLog(`[${requestId}] ✗ Chapter not found in MongoDB`);
        return res.status(404).json({ 
          error: 'Chapter not found',
          chapterId 
        });
      }

      chapter = {
        id: chapterId,
        metadata: chapterDoc.metadataRaw
      };
      
      printLog(`[${requestId}] ✓ Chapter found in ${Date.now() - mongoStart}ms`);

      // Extract guid and feedId from chapter
      guid = chapter.metadata.guid;
      feedId = chapter.metadata.feedId;

      if (!guid || !feedId) {
        return res.status(400).json({ 
          error: 'Chapter missing required metadata (guid or feedId)',
          chapterId,
          metadata: chapter.metadata
        });
      }

      printLog(`[${requestId}] Chapter guid: ${guid}, feedId: ${feedId}`);

    } else {
      // PARAGRAPH MODE: Start from paragraph, go UP
      printLog(`[${requestId}] Mode: PARAGRAPH - starting from ${paragraphId}`);
      startingPoint = 'paragraph';

      // Step 1: Fetch the paragraph from MongoDB
      printLog(`[${requestId}] Step 1: Fetching paragraph from MongoDB...`);
      const mongoStart = Date.now();
      
      const paragraphDoc = await JamieVectorMetadata.findOne({ 
        pineconeId: paragraphId 
      })
      .select('pineconeId metadataRaw')
      .lean();
      
      timings.mongoLookup += Date.now() - mongoStart;
      
      if (!paragraphDoc || !paragraphDoc.metadataRaw) {
        printLog(`[${requestId}] ✗ Paragraph not found in MongoDB`);
        return res.status(404).json({ 
          error: 'Paragraph not found',
          paragraphId 
        });
      }

      paragraph = {
        id: paragraphId,
        metadata: paragraphDoc.metadataRaw
      };
      
      printLog(`[${requestId}] ✓ Paragraph found in ${Date.now() - mongoStart}ms`);

      // Extract guid and feedId from paragraph
      guid = paragraph.metadata.guid;
      feedId = paragraph.metadata.feedId;
      const paragraphStartTime = paragraph.metadata.start_time;
      const paragraphEndTime = paragraph.metadata.end_time;

      if (!guid || !feedId) {
        return res.status(400).json({ 
          error: 'Paragraph missing required metadata (guid or feedId)',
          paragraphId,
          metadata: paragraph.metadata
        });
      }

      printLog(`[${requestId}] Paragraph guid: ${guid}, feedId: ${feedId}, time: ${paragraphStartTime}-${paragraphEndTime}`);

      // Step 2: Query MongoDB for chapter using timestamp filter
      printLog(`[${requestId}] Step 2: Querying MongoDB for containing chapter...`);
      const chapterQueryStart = Date.now();
      
      const chapterDoc = await JamieVectorMetadata.findOne({
        type: 'chapter',
        guid: guid,
        start_time: { $lte: paragraphStartTime },
        end_time: { $gte: paragraphEndTime }
      })
      .select('pineconeId metadataRaw')
      .lean();
      
      timings.mongoChapterQuery = Date.now() - chapterQueryStart;

      if (chapterDoc && chapterDoc.metadataRaw) {
        chapter = {
          id: chapterDoc.pineconeId,
          metadata: chapterDoc.metadataRaw
        };
        printLog(`[${requestId}] ✓ Found chapter: ${chapter.id} in ${timings.mongoChapterQuery}ms`);
      } else {
        printLog(`[${requestId}] No chapter found for this paragraph`);
      }
    }

    // COMMON: Fetch episode and feed (going UP) - PARALLEL MongoDB queries
    printLog(`[${requestId}] Step 3: Fetching episode and feed from MongoDB (parallel)...`);
    const episodeFeedStart = Date.now();
    
    const episodeId = `episode_${guid}`;
    const feedIdStr = `feed_${feedId}`;
    
    const [episodeDoc, feedDoc] = await Promise.all([
      JamieVectorMetadata.findOne({ pineconeId: episodeId })
        .select('pineconeId metadataRaw')
        .lean(),
      JamieVectorMetadata.findOne({ pineconeId: feedIdStr })
        .select('pineconeId metadataRaw')
        .lean()
    ]);
    
    timings.mongoLookup += Date.now() - episodeFeedStart;
    printLog(`[${requestId}] ✓ Episode and feed queries completed in ${Date.now() - episodeFeedStart}ms`);
    
    if (episodeDoc && episodeDoc.metadataRaw) {
      episode = {
        id: episodeId,
        metadata: episodeDoc.metadataRaw
      };
      printLog(`[${requestId}] ✓ Found episode: ${episodeId}`);
    } else {
      printLog(`[${requestId}] Episode not found in MongoDB`);
    }
    
    if (feedDoc && feedDoc.metadataRaw) {
      feed = {
        id: feedIdStr,
        metadata: feedDoc.metadataRaw
      };
      printLog(`[${requestId}] ✓ Found feed: ${feedIdStr}`);
    } else {
      printLog(`[${requestId}] Feed not found in MongoDB`);
    }

    // Build hierarchical path string
    printLog(`[${requestId}] Step 4: Building hierarchy path...`);
    const formatStart = Date.now();
    
    let path = '';
    if (feed) path += feed.metadata.title || 'Unknown Feed';
    if (episode) path += ` > ${episode.metadata.title || 'Unknown Episode'}`;
    if (chapter) path += ` > Chapter ${chapter.metadata.chapterNumber || '?'}: ${chapter.metadata.headline || 'Untitled'}`;
    
    timings.formatting = Date.now() - formatStart;
    timings.total = Date.now() - startTime;

    printLog(`[${requestId}] ========== HIERARCHY COMPLETE ==========`);
    printLog(`[${requestId}] Timings: Total=${timings.total}ms, MongoLookup=${timings.mongoLookup}ms, MongoChapterQuery=${timings.mongoChapterQuery}ms, Formatting=${timings.formatting}ms`);

    // Return complete hierarchy with timing info
    res.json({
      ...(paragraphId && { paragraphId }),
      ...(chapterId && { chapterId }),
      startingPoint,
      hierarchy: {
        paragraph,
        chapter,
        episode,
        feed
      },
      path: path || 'Unknown',
      timings  // Include timing breakdown for comparison
    });

  } catch (error) {
    timings.total = Date.now() - startTime;
    printLog(`[${requestId}] ✗ Error after ${timings.total}ms:`, error.message);
    console.error('Error fetching hierarchy:', error);
    res.status(500).json({ 
      error: 'Failed to fetch hierarchy',
      details: error.message
    });
  }
});


module.exports = router;
