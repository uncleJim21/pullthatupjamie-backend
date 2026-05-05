const mongoose = require('mongoose');

// Persisted copy of the per-request `agentLog` object that
// routes/agentChatRoutes.js already builds and writes to logs/agent/*.json.
// Schema is intentionally permissive (Mixed for round/tool details) so it
// stays in sync with agentLog without requiring a schema migration every
// time a new field is added inline. Keep file writes as the source of
// truth; this collection exists to make the same data queryable.
const AgentRunLogSchema = new mongoose.Schema({
  requestId:        { type: String, required: true, index: true },
  sessionId:        { type: String, index: true },
  startedAt:        { type: Date,   required: true },
  completedAt:      { type: Date },
  latencyMs:        { type: Number, index: true },

  // Routing / config snapshot
  intent:           { type: String, index: true },
  model:            { type: String, index: true },
  modelKey:         { type: String, index: true },
  provider:         { type: String },
  synthesisModel:   { type: String, default: null },
  synthesisModelKey:{ type: String, default: null },
  executionProfile: { type: String, index: true }, // 'fast' | 'deep' | etc
  streaming:        { type: Boolean },
  compactResults:   { type: Boolean },
  compactHistory:   { type: Boolean },
  bypassTriage:     { type: Boolean },

  // Caller identity (best-effort; varies by entry point)
  ip:               { type: String },
  entitlementType:  { type: String, index: true }, // 'pull' | 'free-tier' | etc
  entitlementSource:{ type: String },               // 'nostr-bot' | 'web' | etc

  // The user input + final answer
  query:            { type: String },
  finalText:        { type: String },

  // Round-by-round trace + per-call tool details
  rounds:           { type: [mongoose.Schema.Types.Mixed], default: [] },

  // Final summary (cost, tokens, tool call list, completion reason)
  summary:          { type: mongoose.Schema.Types.Mixed, default: null },

  // Synthesis recovery details when Tier 1 was unsatisfactory
  synthesisRecovery:{ type: mongoose.Schema.Types.Mixed, default: null },

  // Triage classifier token usage (when triage ran)
  classifierTokens: { type: mongoose.Schema.Types.Mixed, default: null },

  // Populated when the request errored before completing
  error:            { type: String, default: null, index: true },
}, {
  timestamps: true,
  // Permissive container — agentLog gains fields organically; we don't
  // want strict mode silently dropping them.
  strict: false,
});

// 90-day TTL — these docs are large (full round trace, tool inputs,
// final text). Adjust here if you ever want longer retention.
AgentRunLogSchema.index({ startedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Compound indexes for common dashboard slices
AgentRunLogSchema.index({ intent: 1, startedAt: -1 });
AgentRunLogSchema.index({ modelKey: 1, startedAt: -1 });
AgentRunLogSchema.index({ error: 1, startedAt: -1 });

module.exports = mongoose.model('AgentRunLog', AgentRunLogSchema);
