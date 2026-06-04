/**
 * Tape audit log — captures the FULL pipeline (input → retrieval → synthesis →
 * parsed output) per kind-endpoint request, for offline inspection.
 *
 * Gated behind TAPE_AUDIT_ENABLED=true (default OFF). When on, every stage is
 * written as one JSONL line to TAPE_AUDIT_FILE (default logs/tape-audit.jsonl)
 * and echoed to stdout as `[tape:audit]`. It logs quote text + prompts + model
 * output verbatim, so it is VERBOSE and contains content — DISABLE before prod.
 *
 * A loud boot warning fires on startup whenever it's enabled (see bootWarn).
 */

const fs = require('fs');
const path = require('path');
const { printLog } = require('../../constants');

const ENABLED = process.env.TAPE_AUDIT_ENABLED === 'true';
const FILE = process.env.TAPE_AUDIT_FILE || path.join(process.cwd(), 'logs', 'tape-audit.jsonl');

function isEnabled() { return ENABLED; }

/** Compact a candidate to the audit-relevant fields. */
function slimCandidate(c) {
  if (!c) return null;
  return {
    pineconeId: c.pineconeId,
    creator: c.creator,
    publishedDate: c.publishedDate,
    similarity: c.similarity,
    spanSec: c.spanSec,
    text: c.text,
  };
}

/**
 * Append one audit entry. `stage` ∈ request | retrieval | synthesis | response
 * | cache_hit | error. No-op unless TAPE_AUDIT_ENABLED.
 */
function audit(stage, auditId, payload = {}) {
  if (!ENABLED) return;
  const entry = { ts: new Date().toISOString(), auditId, stage, ...payload };
  let line;
  try { line = JSON.stringify(entry); } catch (_) { line = JSON.stringify({ ts: entry.ts, auditId, stage, error: 'unserializable-payload' }); }
  printLog(`[tape:audit] ${line}`);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFile(FILE, `${line}\n`, () => {});
  } catch (_) { /* best-effort */ }
}

/** Loud one-time startup warning when audit logging is on. */
function bootWarn() {
  if (!ENABLED) return;
  console.warn(
    '\n⚠️  [tape:audit] TAPE_AUDIT_ENABLED=true — full input/intermediate/output '
    + `audit logging is ON → ${FILE}\n`
    + '    It records quote text, prompts, and model output verbatim. '
    + 'DISABLE (unset TAPE_AUDIT_ENABLED) before deploying to production.\n',
  );
}

bootWarn();

module.exports = { audit, isEnabled, slimCandidate, FILE };
