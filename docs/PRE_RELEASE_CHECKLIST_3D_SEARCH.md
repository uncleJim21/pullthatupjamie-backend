# Pre-Release Checklist: 3D Semantic Search Endpoint

**Feature**: `/api/search-quotes-3d` endpoint for galaxy view visualization
**Target Release**: TBD
**Last Updated**: 2024

---

## 🔒 Security & Rate Limiting

### IP-Based Throttling
- [ ] **CRITICAL**: Implement IP-based rate limiting for `/api/search-quotes` endpoint
  - Current state: Unlimited by design (development only)
  - Required: Prevent DoS while maintaining permissiveness
  - Suggested approach: `express-rate-limit` with IP tracking
  - Suggested limits:
    - `/api/search-quotes`: 60 requests/minute per IP
    - `/api/search-quotes-3d`: 10 requests/minute per IP (more expensive)
  - Consider: Whitelist for known good actors
  - Consider: Cloudflare or nginx upstream rate limiting as alternative

- [ ] Test rate limiting behavior:
  - [ ] Verify limits trigger correctly
  - [ ] Check error messages are clear (429 status)
  - [ ] Ensure legitimate users aren't blocked
  - [ ] Test with multiple IPs (proxy, VPN scenarios)

### Authentication (Current Design)
- [x] Both endpoints remain public (no auth middleware)
- [x] Rate limiting is primary DoS protection
- [ ] Monitor for abuse patterns in first 2 weeks
- [ ] Decision point: Add auth if abuse detected

---

## ⚡ Performance & Optimization

### **CRITICAL: Vector Embedding Strategy Migration**
- [ ] **DECISION REQUIRED**: Migrate from server-side re-embedding to pre-computed vectors
  - **Current Implementation**: Server-side re-embedding (workaround for Pinecone limitation)
  - **Why it exists**: Pinecone index cannot return vector values (`includeValues: true` causes timeouts)
  - **Performance Impact**: 
    - Adds ~500-1500ms latency per request (OpenAI batch embedding API call)
    - Incurs $0.0001 per 1K tokens (e.g., 50 results ≈ 25K tokens ≈ $0.0025 per request)
    - At 1000 requests/day: ~$2.50/day = ~$900/year in embedding costs alone
  - **Scale Limitations**:
    - OpenAI batch limit: 2048 inputs per request (sufficient for now, limit is 50)
    - Rate limits: 3000 RPM on Ada-002 (should be fine for reasonable traffic)
  
  **MIGRATION OPTIONS**:
  
  **Option A: Pre-compute 3D Coordinates (RECOMMENDED)**
  - Store UMAP-projected 3D coordinates directly in Pinecone metadata
  - Pros:
    - Zero embedding cost per request
    - Fast: ~300-500ms response time (no re-embedding step)
    - Scalable to millions of requests
  - Cons:
    - Requires one-time batch processing of entire corpus (~1M+ paragraphs)
    - Need to re-project ALL data when UMAP config changes
    - Storage overhead: 3 floats (12 bytes) per paragraph in Pinecone
    - Questions:
      - [ ] How to handle incremental updates when new content ingested?
      - [ ] Is a single global UMAP projection good enough, or need per-podcast projections?
      - [ ] What if user wants different UMAP config (e.g., different perplexity)?
  
  **Option B: Store Raw Embeddings in Alternative DB**
  - Keep vectors in a separate fast read store (e.g., Redis, PostgreSQL with pgvector)
  - Pinecone returns IDs → fetch vectors from alternative DB → UMAP on server
  - Pros:
    - Eliminates OpenAI re-embedding cost
    - Flexible: can change UMAP config dynamically
    - No full corpus re-processing needed
  - Cons:
    - Still requires UMAP computation on every request (~800ms)
    - Additional infrastructure (Redis/Postgres)
    - Data sync complexity between Pinecone and vector store
  
  **Option C: Hybrid - Cache Re-embedded Vectors**
  - Keep current server-side re-embedding, but cache embeddings in Redis
  - Cache key: SHA-256 hash of paragraph text
  - TTL: 7 days (or indefinite)
  - Pros:
    - Easy to implement (just add caching layer)
    - Gradually builds up cache, eliminating re-embedding for popular results
    - No corpus reprocessing needed
  - Cons:
    - Still incurs cost for cache misses (new/rare content)
    - Requires significant Redis memory (1536 floats × 4 bytes × cache size)
    - Example: 100K cached paragraphs ≈ 600MB Redis memory
  
  **RECOMMENDATION**: 
  - **Short-term (MVP/Beta)**: Keep Option C (current approach + caching) for 1-2 months
    - Monitor: re-embedding cost, cache hit rate, response times
    - Estimated cost: $100-300 during beta (assuming moderate traffic)
  - **Long-term (Production)**: Migrate to Option A (pre-computed coordinates)
    - Implement after beta feedback on UMAP config preferences
    - One-time batch job to project entire corpus
    - Update ingestion pipeline to project new content
  
- [ ] **DECISION**: Choose migration path (A, B, C, or defer)
- [ ] **ACTION**: If Option A, design batch projection pipeline
- [ ] **ACTION**: If Option B, choose vector store and design sync mechanism
- [ ] **ACTION**: If Option C, implement caching layer (see below)

### Caching Strategy
- [ ] **POST-MVP**: Implement Redis caching for 3D endpoint
  - Cache key: Hash of (query + filters + limit)
  - TTL: 1 hour (balance freshness vs performance)
  - Invalidation: On podcast ingestion (if feasible)
  - Expected cache hit rate: >30%
  - Expected latency improvement: 1.8s → 0.3s on cache hit

- [ ] Measure cache effectiveness:
  - [ ] Track hit/miss ratio
  - [ ] Monitor memory usage (Redis)
  - [ ] Calculate cost/benefit of cache

- [ ] Consider pre-computation for top 20 queries:
  - [ ] Nightly batch job to pre-compute popular searches
  - [ ] Store in cache with 24hr TTL
  - [ ] Potential latency: <500ms for cached queries

### Coordinate Normalization Validation
- [ ] **CRITICAL**: Add degenerate distribution detection
  - Calculate standard deviation per axis
  - If std dev < 0.05 on any axis, log warning
  - If std dev < 0.01 on all axes, return error
  - Suggests embeddings are too similar or UMAP failed

- [ ] Test with edge cases:
  - [ ] All results from same episode (should be clustered)
  - [ ] Very broad query (should be distributed)
  - [ ] Narrow technical query (moderate clustering OK)

---

## 🐛 Error Handling & Edge Cases

### Minimum Results (< 4 points)
- [x] Return 400 error with clear message
- [ ] **POST-MVP**: Evaluate how common this is in production
  - If >5% of requests: Consider fallback strategy
  - Fallback option A: Add dummy points to reach minimum
  - Fallback option B: Return 2D projection instead
  - Fallback option C: Add warning field + return regular search

- [ ] Track metrics:
  - [ ] % of requests with <4 results
  - [ ] Distribution of result counts (histogram)
  - [ ] User feedback on "insufficient results" errors

### UMAP Computation Failures
- [ ] Implement retry logic with exponential backoff
  - Max retries: 2
  - Backoff: 100ms, 500ms
  - Different random seed per retry
  - After max retries: Return 500 with detailed log

- [ ] Handle specific failure modes:
  - [ ] Convergence failure → retry with different params
  - [ ] Out of memory → reduce topK limit automatically
  - [ ] NaN/Inf coordinates → retry or return error
  - [ ] Timeout (>5s) → cancel and return error

- [ ] Comprehensive error logging:
  ```javascript
  {
    error_type: 'umap_failure',
    query_hash: 'abc123',
    result_count: 87,
    umap_params: { nNeighbors: 15, minDist: 0.1 },
    stack_trace: '...',
    timestamp: '...',
    retry_count: 2
  }
  ```

### Pinecone Embedding Retrieval
- [ ] Verify `includeValues: true` works in production
  - Test with various result counts (10, 50, 100, 200)
  - Measure latency impact vs `includeValues: false`
  - Validate embeddings are 1536-dimensional
  - Handle case where Pinecone doesn't return values (fallback)

---

## 📊 Monitoring & Observability

### Metrics to Implement
- [ ] **Latency metrics**:
  - [ ] `api.search_3d.latency.p50`
  - [ ] `api.search_3d.latency.p95`
  - [ ] `api.search_3d.latency.p99`
  - [ ] `api.search_3d.umap_time` (separate from total)
  - [ ] `api.search_3d.pinecone_time`
  - [ ] `api.search_3d.embedding_time`

- [ ] **Usage metrics**:
  - [ ] `api.search_3d.requests_per_minute`
  - [ ] `api.search_3d.result_count` (histogram)
  - [ ] `api.search_3d.cache_hit_rate` (when caching added)
  - [ ] `api.search_3d.error_rate` by type

- [ ] **Resource metrics**:
  - [ ] `system.cpu.usage` during UMAP
  - [ ] `system.memory.usage` peak
  - [ ] `api.search_3d.concurrent_requests`

### Alerts to Set Up
- [ ] Latency p95 >3 seconds (warning)
- [ ] Latency p95 >5 seconds (critical)
- [ ] Error rate >5% over 5min window (warning)
- [ ] Error rate >10% over 5min window (critical)
- [ ] Memory usage >80% (warning)
- [ ] Concurrent requests >4 sustained (warning - need scaling)
- [ ] Rate limit hits >100/hour per IP (potential abuse)

### Logging Requirements
- [ ] Log every request with:
  ```javascript
  {
    timestamp: '2024-03-15T10:30:00Z',
    query_hash: 'sha256_hash', // For privacy
    result_count: 100,
    umap_time_ms: 1234,
    search_time_ms: 456,
    total_time_ms: 1690,
    user_ip_hash: 'ip_hash', // Hashed for privacy
    cache_hit: false,
    filters: {
      feedIds: [1, 2, 3],
      minDate: '2024-01-01',
      maxDate: '2024-12-31'
    }
  }
  ```

- [ ] Log errors with full context:
  - Stack traces
  - Input parameters (sanitized)
  - System state (CPU, memory)
  - Retry attempts

---

## 🧪 Testing Requirements

### Load Testing
- [ ] Single request latency test:
  - [ ] 10 results: <1s
  - [ ] 50 results: <1.5s
  - [ ] 100 results: <2.5s
  - [ ] 200 results: <4s

- [ ] Concurrent request handling:
  - [ ] 2 simultaneous: No degradation
  - [ ] 3 simultaneous: <10% degradation
  - [ ] 4 simultaneous: Should queue (test gracefully)
  - [ ] 10 simultaneous: Rate limit should protect

- [ ] Memory leak test:
  - [ ] Run 1000 requests sequentially
  - [ ] Memory should return to baseline
  - [ ] No accumulation over time

### Edge Case Testing
- [ ] Insufficient results (<4):
  - [ ] Verify 400 response
  - [ ] Check error message clarity
  - [ ] Frontend handles gracefully

- [ ] Very narrow query (all same episode):
  - [ ] UMAP should still work
  - [ ] Coordinates should cluster (not degenerate)
  - [ ] Verify visualization is useful

- [ ] Very broad query (random results):
  - [ ] Coordinates should be distributed
  - [ ] Verify no axis domination
  - [ ] Check for reasonable spread

- [ ] Filters that yield no results:
  - [ ] Return empty array
  - [ ] Don't attempt UMAP
  - [ ] Fast response (<500ms)

- [ ] Special characters in query:
  - [ ] Test with emoji, unicode, SQL injection attempts
  - [ ] Verify sanitization works
  - [ ] No errors or security issues

### Integration Testing
- [ ] Test full flow end-to-end:
  - [ ] Frontend → Backend → Pinecone → UMAP → Response
  - [ ] Verify 3D coordinates render correctly
  - [ ] Check hierarchyLevel coloring works
  - [ ] Test "search from point" feature

---

## 📝 Documentation

### API Documentation
- [ ] Update API docs (Swagger/OpenAPI):
  - [ ] New endpoint `/api/search-quotes-3d`
  - [ ] Request schema
  - [ ] Response schema (with new fields)
  - [ ] Error responses
  - [ ] Rate limiting info

- [ ] Add code examples:
  - [ ] curl example
  - [ ] JavaScript fetch example
  - [ ] Python requests example

### Internal Documentation
- [ ] Architecture diagram showing UMAP flow
- [ ] Performance characteristics document
- [ ] Troubleshooting guide for common issues
- [ ] Monitoring dashboard setup guide

### Frontend Integration Guide
- [ ] How to call the new endpoint
- [ ] How to render 3D coordinates
- [ ] How to handle errors
- [ ] How to show loading states (1-2s latency)

---

## 🚀 Deployment

### Pre-Deployment Checklist
- [ ] All tests passing (unit, integration, load)
- [ ] Feature flag implemented and OFF by default
- [ ] Monitoring and alerts configured
- [ ] Documentation complete
- [ ] Rate limiting tested and working
- [ ] Error handling tested with all edge cases

### Deployment Plan
1. **Week 1: Internal Testing**
   - [ ] Deploy to staging environment
   - [ ] Team testing with real data (1 week)
   - [ ] Fix bugs discovered
   - [ ] Performance tuning based on staging data

2. **Week 2: Soft Launch (Production, Flag OFF)**
   - [ ] Deploy to production with feature flag OFF
   - [ ] Enable for internal users only (whitelist IPs)
   - [ ] Monitor for 48 hours
   - [ ] Tune UMAP parameters if needed
   - [ ] Verify no impact on regular search endpoint

3. **Week 3: Beta (10% rollout)**
   - [ ] Enable for 10% of users (A/B test)
   - [ ] Collect user feedback surveys
   - [ ] Monitor error rates, latency, usage
   - [ ] A/B test metrics: time on page, engagement

4. **Week 4+: General Availability**
   - [ ] Enable for all users (100% rollout)
   - [ ] Make galaxy view discoverable (UI placement)
   - [ ] Continue monitoring for 2 weeks
   - [ ] Iterate based on feedback

### Rollback Plan
- [ ] Feature flag can instantly disable endpoint
- [ ] Rollback procedure documented
- [ ] Contact list for escalation
- [ ] Criteria for triggering rollback:
  - Error rate >20%
  - Latency p95 >10 seconds
  - System instability (CPU/memory)
  - Critical bug discovered

---

## 🎯 Success Criteria

### Technical Success Metrics
- [ ] ✅ Latency p95 <2.5 seconds (target: 1.8s)
- [ ] ✅ Error rate <1%
- [ ] ✅ No memory leaks over 7 days
- [ ] ✅ No impact on regular search endpoint performance
- [ ] ✅ Rate limiting prevents abuse (0 incidents)

### Product Success Metrics
- [ ] % of search users who try galaxy view: >20%
- [ ] % who use it regularly (>1x per week): >5%
- [ ] User satisfaction score: >4/5
- [ ] Bug reports <10 in first month
- [ ] Feature requests collected for Phase 2

### Post-Launch Review (4 weeks)
- [ ] Review all metrics vs targets
- [ ] Collect user feedback (qualitative)
- [ ] Identify optimization opportunities
- [ ] Plan Phase 2 features based on data
- [ ] Decision: Keep, iterate, or deprecate?

---

## 🔮 Future Enhancements (Post-MVP)

### Phase 2: Optimization
- [ ] Redis caching implementation
- [ ] Pre-computation for top 20 queries
- [ ] Fast mode option (nNeighbors: 8)
- [ ] Query parameter for coordinate determinism

### Phase 3: Advanced Features
- [ ] "Search from this point" using result's embedding
- [ ] Support for different hierarchy levels (chapter, episode)
- [ ] Animation/transitions between searches
- [ ] Save/share galaxy view state (URL params)

### Phase 4: Scale Improvements
- [ ] Horizontal scaling if traffic grows
- [ ] Python microservice for faster UMAP (if needed)
- [ ] Hybrid pre-computation strategy
- [ ] WebGL optimization for rendering

---

## 📞 Contact & Escalation

- **Feature Owner**: TBD
- **Tech Lead**: TBD
- **On-Call**: TBD
- **Slack Channel**: TBD

---

## Sign-Off

- [ ] Engineering Lead Approval
- [ ] Product Manager Approval
- [ ] Security Review Complete
- [ ] Performance Testing Complete
- [ ] Documentation Complete

**Date**: _______________
**Approved By**: _______________

