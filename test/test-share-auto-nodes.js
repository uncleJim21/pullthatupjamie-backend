#!/usr/bin/env node

/**
 * test-share-auto-nodes.js
 *
 * Tests for the POST /api/research-sessions/:id/share endpoint covering:
 *   - Backward compatibility: nodes provided explicitly (frontend path)
 *   - Headless/agent path: nodes omitted, auto-generated from session data
 *
 * Prerequisites:
 *   1. Server running at TEST_BASE_URL (default http://localhost:4132)
 *   2. A JWT for the session owner, or override TEST_SESSION_ID + TEST_CLIENT_ID
 *
 * By default uses a known session (69931f9d502c8522e0478c64) owned by
 * userId 67ec6d7c2aa12b67301f6399. Supply TEST_JWT for that user, or
 * set TEST_SESSION_ID + TEST_CLIENT_ID to use a different session.
 */

const axios = require('axios');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:4132';
const CLIENT_ID = process.env.TEST_CLIENT_ID || null;
const JWT = process.env.TEST_JWT || null;
const SESSION_ID = process.env.TEST_SESSION_ID || '69931f9d502c8522e0478c64';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  dim: '\x1b[2m'
};
const log = (color, msg) => console.log(`${colors[color]}${msg}${colors.reset}`);

let passed = 0;
let failed = 0;
const results = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    results.push({ label, ok: true });
  } else {
    failed++;
    results.push({ label, ok: false });
    log('red', `  ✗ ${label}`);
  }
}

function shareUrl(sessionId) {
  const base = `${BASE_URL}/api/research-sessions/${sessionId}/share`;
  if (CLIENT_ID) return `${base}?clientId=${CLIENT_ID}`;
  return base;
}

function authHeaders() {
  if (JWT) return { Authorization: `Bearer ${JWT}` };
  return {};
}

// ─── Test 1: Backward compat – explicit nodes ───────────────────────────────

async function testExplicitNodes(sessionId) {
  log('blue', '\n── Test 1a: Explicit valid nodes (frontend path) ──');
  try {
    const resp = await axios.post(
      shareUrl(sessionId),
      {
        title: 'Test explicit nodes',
        nodes: [
          { pineconeId: 'fake-id-1', x: 0, y: 0, z: 0, color: '#ff0000' },
          { pineconeId: 'fake-id-2', x: 1, y: 1, z: 1, color: '#00ff00' }
        ]
      },
      { headers: authHeaders() }
    );
    assert(resp.status === 201, 'Returns 201');
    assert(resp.data.success === true, 'success: true');
    assert(typeof resp.data.data.shareId === 'string', 'shareId is string');
    assert(typeof resp.data.data.shareUrl === 'string', 'shareUrl is string');
    assert(resp.data.data.generatedLayout === false, 'generatedLayout is false');
    log('green', '  ✓ All explicit-node assertions passed');
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.details || err.message;
    log('red', `  Request failed (HTTP ${status}): ${detail}`);
    assert(false, `Explicit nodes request should succeed (got ${status})`);
  }
}

async function testExplicitNodesBadPineconeId(sessionId) {
  log('blue', '\n── Test 1b: Explicit nodes – missing pineconeId ──');
  try {
    await axios.post(
      shareUrl(sessionId),
      { nodes: [{ x: 0, y: 0, z: 0, color: '#ff0000' }] },
      { headers: authHeaders() }
    );
    assert(false, 'Should have returned 400');
  } catch (err) {
    assert(err.response?.status === 400, 'Returns 400 for missing pineconeId');
  }
}

async function testExplicitNodesOutOfRange(sessionId) {
  log('blue', '\n── Test 1c: Explicit nodes – out-of-range coordinate ──');
  try {
    await axios.post(
      shareUrl(sessionId),
      { nodes: [{ pineconeId: 'oor-test', x: 999999, y: 0, z: 0, color: '#ff0000' }] },
      { headers: authHeaders() }
    );
    assert(false, 'Should have returned 400');
  } catch (err) {
    assert(err.response?.status === 400, 'Returns 400 for out-of-range coordinate');
  }
}

async function testExplicitNodesDuplicates(sessionId) {
  log('blue', '\n── Test 1d: Explicit nodes – duplicate pineconeIds ──');
  try {
    const resp = await axios.post(
      shareUrl(sessionId),
      {
        title: 'Test dedup',
        nodes: [
          { pineconeId: 'dup-id', x: 0, y: 0, z: 0, color: '#ff0000' },
          { pineconeId: 'dup-id', x: 1, y: 1, z: 1, color: '#00ff00' },
          { pineconeId: 'unique-id', x: 2, y: 2, z: 2, color: '#0000ff' }
        ]
      },
      { headers: authHeaders() }
    );
    assert(resp.status === 201, 'Returns 201 (duplicates de-duped)');
    assert(resp.data.data.generatedLayout === false, 'generatedLayout is false');
    log('green', '  ✓ Duplicate dedup assertions passed');
  } catch (err) {
    assert(false, `Duplicate dedup should succeed: ${err.message}`);
  }
}

// ─── Test 2: Headless path – nodes omitted ──────────────────────────────────

async function testOmittedNodes(sessionId) {
  log('blue', '\n── Test 2a: Nodes omitted (headless agent path) ──');
  try {
    const resp = await axios.post(
      shareUrl(sessionId),
      { title: 'Test auto-generated layout' },
      { headers: authHeaders() }
    );
    assert(resp.status === 201, 'Returns 201');
    assert(resp.data.success === true, 'success: true');
    assert(resp.data.data.generatedLayout === true, 'generatedLayout is true');
    assert(typeof resp.data.data.shareId === 'string', 'shareId is string');
    assert(typeof resp.data.data.shareUrl === 'string', 'shareUrl is string');
    log('green', `  ✓ Auto-generated share: ${resp.data.data.shareUrl}`);
    return resp.data.data;
  } catch (err) {
    const detail = err.response?.data?.details || err.message;
    log('red', `  Request failed: ${detail}`);
    assert(false, `Omitted nodes request should succeed: ${detail}`);
    return null;
  }
}

async function testEmptyNodesArray(sessionId) {
  log('blue', '\n── Test 2b: nodes: [] (empty array treated as omitted) ──');
  try {
    const resp = await axios.post(
      shareUrl(sessionId),
      { title: 'Test empty array', nodes: [] },
      { headers: authHeaders() }
    );
    assert(resp.status === 201, 'Returns 201');
    assert(resp.data.data.generatedLayout === true, 'generatedLayout is true');
    log('green', '  ✓ Empty array treated as omitted');
  } catch (err) {
    const detail = err.response?.data?.details || err.message;
    assert(false, `Empty array should auto-generate: ${detail}`);
  }
}

async function testNullNodes(sessionId) {
  log('blue', '\n── Test 2c: nodes: null ──');
  try {
    const resp = await axios.post(
      shareUrl(sessionId),
      { title: 'Test null nodes', nodes: null },
      { headers: authHeaders() }
    );
    assert(resp.status === 201, 'Returns 201');
    assert(resp.data.data.generatedLayout === true, 'generatedLayout is true');
    log('green', '  ✓ null nodes treated as omitted');
  } catch (err) {
    const detail = err.response?.data?.details || err.message;
    assert(false, `null nodes should auto-generate: ${detail}`);
  }
}

// ─── Test 3: Round-trip – verify shared session is fetchable ────────────────

async function testRoundTrip(shareData) {
  if (!shareData) {
    log('yellow', '\n── Test 3: Skipped (no shareData from test 2a) ──');
    return;
  }
  log('blue', '\n── Test 3: Round-trip – GET shared session ──');
  try {
    const resp = await axios.get(
      `${BASE_URL}/api/shared-research-sessions/${shareData.shareId}`
    );
    assert(resp.status === 200, 'GET shared session returns 200');
    const data = resp.data.data || resp.data;
    const nodes = data.nodes || [];
    assert(nodes.length > 0, 'Shared session has nodes');

    if (nodes.length > 0) {
      const first = nodes[0];
      assert(typeof first.pineconeId === 'string', 'Node has pineconeId');
      assert(typeof first.x === 'number' && Number.isFinite(first.x), 'x is finite number');
      assert(typeof first.y === 'number' && Number.isFinite(first.y), 'y is finite number');
      assert(typeof first.z === 'number' && Number.isFinite(first.z), 'z is finite number');
      assert(typeof first.color === 'string' && first.color.startsWith('#'), 'color is hex');
    }
    log('green', `  ✓ Shared session has ${nodes.length} valid nodes`);
  } catch (err) {
    const detail = err.response?.data?.details || err.message;
    assert(false, `Round-trip GET should succeed: ${detail}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  log('blue', '═══════════════════════════════════════════════════');
  log('blue', '  Share Endpoint: Auto-Generated Nodes Test Suite  ');
  log('blue', '═══════════════════════════════════════════════════');
  log('dim', `  Server: ${BASE_URL}`);
  log('dim', `  Auth: ${JWT ? 'JWT' : CLIENT_ID ? `clientId=${CLIENT_ID}` : 'none (will 400)'}`);

  const sessionId = SESSION_ID;
  log('dim', `  SessionId: ${sessionId}`);

  if (!JWT && !CLIENT_ID) {
    log('red', '\n  ERROR: Set TEST_JWT or TEST_CLIENT_ID so the server can resolve ownership.');
    process.exit(1);
  }

  // Backward compatibility tests
  await testExplicitNodes(sessionId);
  await testExplicitNodesBadPineconeId(sessionId);
  await testExplicitNodesOutOfRange(sessionId);
  await testExplicitNodesDuplicates(sessionId);

  // Headless / agent path
  const shareData = await testOmittedNodes(sessionId);
  await testEmptyNodesArray(sessionId);
  await testNullNodes(sessionId);

  // Round-trip
  await testRoundTrip(shareData);

  // Summary
  log('blue', '\n═══════════════════════════════════════════════════');
  log('blue', '  Results');
  log('blue', '═══════════════════════════════════════════════════');
  results.forEach(({ label, ok }) => {
    log(ok ? 'green' : 'red', `  ${ok ? '✓' : '✗'} ${label}`);
  });
  log('blue', `\n  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
  log('blue', '═══════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  log('red', `Unhandled error: ${err.message}`);
  process.exit(1);
});
