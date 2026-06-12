#!/usr/bin/env node
/**
 * Live probe: run the real /api/pull agent twice for the query that was
 * timing out on Nostr (Michael Saylor "we are never selling"), using the
 * same 5-minute budget the Nostr reply worker now passes, and assert
 * both runs succeed with non-empty text.
 *
 *   node scripts/nostr-agent-budget-probe.js
 *
 * NOTE: this hits live services (MongoDB, Pinecone, LLM providers) and
 * costs two real agent runs. It is a manual validation probe, not part
 * of the unit suite. Exits non-zero if either run fails.
 *
 * Reproduces the mention that failed in prod with attemptCount=3 /
 * "agent timeout" (eventId 1d166b0d…), minus the entitlement/zap and
 * relay-publish legs — exactly the agent call in NostrBotReplyService.
 */

require('dotenv').config();
const assert = require('assert');
const mongoose = require('mongoose');
const { runPull } = require('../services/agentPullService');
const { NOSTR_AGENT_TIMEOUT_MS } = require('../utils/NostrBotReplyService');

// The user's note content after the reply worker strips the
// `nostr:npub1…` mention and collapses whitespace.
const QUERY = 'Hey Did when did Micheal Saylor say "we are never selling"';
const AUTHOR_PUBKEY = '59a98c047944f65ea40f3765555ee589bf50363f4f7dcf5594c3584bbb13ff66';
const RUNS = 2;

(async () => {
  const uri = process.env.DEBUG_MODE === 'true' ? process.env.MONGO_DEBUG_URI : process.env.MONGO_URI;
  assert(uri, 'MONGO_URI (or MONGO_DEBUG_URI) must be set in env');

  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log(`[probe] connected to mongo; agent budget = ${NOSTR_AGENT_TIMEOUT_MS}ms (${NOSTR_AGENT_TIMEOUT_MS / 60000}min)`);
  console.log(`[probe] query: ${QUERY}\n`);

  let failures = 0;
  for (let i = 1; i <= RUNS; i++) {
    const started = Date.now();
    let result;
    try {
      result = await runPull({
        message: QUERY,
        identity: {
          tier: 'subscriber',
          identifier: AUTHOR_PUBKEY,
          identifierType: 'npub',
          user: null,
          provider: 'nostr',
          email: null,
        },
        timeoutMs: NOSTR_AGENT_TIMEOUT_MS,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    const ms = Date.now() - started;
    const text = result && typeof result.text === 'string' ? result.text : '';
    const ok = !!(result && result.ok && text.trim().length > 0);

    console.log(
      `[probe] run ${i}/${RUNS}: ok=${ok} elapsed=${(ms / 1000).toFixed(1)}s ` +
      `status=${result && result.status ? result.status : 'n/a'} ` +
      `textLen=${text.length} err=${result && result.error ? result.error : 'none'}`,
    );
    if (ok) {
      console.log(`           preview: ${text.slice(0, 180).replace(/\s+/g, ' ')}…\n`);
    } else {
      failures++;
      console.log('');
    }
  }

  await mongoose.connection.close();

  if (failures > 0) {
    console.error(`[probe] FAIL: ${failures}/${RUNS} runs failed`);
    process.exit(1);
  }
  console.log(`[probe] PASS: ${RUNS}/${RUNS} runs succeeded with non-empty answers`);
  process.exit(0);
})().catch((err) => {
  console.error('[probe] fatal:', err);
  process.exit(1);
});
