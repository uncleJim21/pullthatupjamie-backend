#!/usr/bin/env node

/**
 * test-3d-search.js
 * 
 * Test script for the /api/search-quotes-3d endpoint
 * Tests various scenarios including edge cases
 */

const axios = require('axios');

// Configuration
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:4132';
const ENDPOINT = `${BASE_URL}/api/search-quotes-3d`;

// Test queries
const TEST_CASES = [
  {
    name: 'Standard Search (100 results)',
    query: 'artificial intelligence',
    limit: 100,
    expectSuccess: true
  },
  {
    name: 'Fast Mode (50 results)',
    query: 'Bitcoin mining',
    limit: 50,
    fastMode: true,
    expectSuccess: true
  },
  {
    name: 'Small Result Set (10 results)',
    query: 'quantum computing blockchain',
    limit: 10,
    expectSuccess: true
  },
  {
    name: 'With Filters (feed + date)',
    query: 'climate change',
    limit: 50,
    feedIds: ['1'],
    minDate: '2024-01-01',
    expectSuccess: true
  },
  {
    name: 'Very Specific Query (likely < 4 results)',
    query: 'xyzabc123nonsense456definitelynotfound',
    limit: 100,
    expectSuccess: false, // Should get 400 error
    expectedError: 'Insufficient results'
  }
];

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function formatTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function runTest(testCase) {
  const { name, expectSuccess, expectedError, ...requestBody } = testCase;
  
  log('blue', `\n${'='.repeat(60)}`);
  log('cyan', `Test: ${name}`);
  log('blue', '='.repeat(60));
  
  console.log('Request:', JSON.stringify(requestBody, null, 2));
  
  const startTime = Date.now();
  
  try {
    const response = await axios.post(ENDPOINT, requestBody, {
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    const totalTime = Date.now() - startTime;
    
    if (!expectSuccess) {
      log('red', `✗ FAILED: Expected error but got success`);
      return { passed: false, error: 'Expected error but got success' };
    }
    
    const data = response.data;
    
    // Validate response structure
    const validations = [
      { check: data.results && Array.isArray(data.results), msg: 'results is array' },
      { check: data.total === data.results.length, msg: 'total matches result count' },
      { check: data.metadata && typeof data.metadata === 'object', msg: 'metadata exists' },
      { check: data.metadata.umapTimeMs > 0, msg: 'UMAP time recorded' },
      { check: data.metadata.totalTimeMs > 0, msg: 'Total time recorded' }
    ];
    
    // Validate first result has 3D coordinates
    if (data.results.length > 0) {
      const firstResult = data.results[0];
      validations.push(
        { check: firstResult.coordinates3d && typeof firstResult.coordinates3d === 'object', msg: 'coordinates3d exists' },
        { check: typeof firstResult.coordinates3d.x === 'number', msg: 'x coordinate is number' },
        { check: typeof firstResult.coordinates3d.y === 'number', msg: 'y coordinate is number' },
        { check: typeof firstResult.coordinates3d.z === 'number', msg: 'z coordinate is number' },
        { check: firstResult.coordinates3d.x >= -1 && firstResult.coordinates3d.x <= 1, msg: 'x in [-1, 1]' },
        { check: firstResult.coordinates3d.y >= -1 && firstResult.coordinates3d.y <= 1, msg: 'y in [-1, 1]' },
        { check: firstResult.coordinates3d.z >= -1 && firstResult.coordinates3d.z <= 1, msg: 'z in [-1, 1]' },
        { check: firstResult.hierarchyLevel, msg: 'hierarchyLevel exists' }
      );
    }
    
    let allPassed = true;
    validations.forEach(v => {
      if (v.check) {
        log('green', `  ✓ ${v.msg}`);
      } else {
        log('red', `  ✗ ${v.msg}`);
        allPassed = false;
      }
    });
    
    // Display performance metrics
    log('yellow', '\nPerformance Metrics:');
    console.log(`  Total Time: ${formatTime(totalTime)}`);
    console.log(`  Embedding: ${formatTime(data.metadata.embeddingTimeMs)}`);
    console.log(`  Search: ${formatTime(data.metadata.searchTimeMs)}`);
    console.log(`  UMAP: ${formatTime(data.metadata.umapTimeMs)}`);
    console.log(`  Results: ${data.total}`);
    console.log(`  Fast Mode: ${data.metadata.fastMode}`);
    
    // Display sample coordinates
    if (data.results.length > 0) {
      log('yellow', '\nSample 3D Coordinates:');
      const samples = data.results.slice(0, 3);
      samples.forEach((r, i) => {
        console.log(`  [${i}] x:${r.coordinates3d.x.toFixed(3)}, y:${r.coordinates3d.y.toFixed(3)}, z:${r.coordinates3d.z.toFixed(3)} | ${r.hierarchyLevel}`);
      });
    }
    
    if (allPassed) {
      log('green', `\n✓ PASSED (${formatTime(totalTime)})`);
      return { passed: true, time: totalTime };
    } else {
      log('red', `\n✗ FAILED: Some validations failed`);
      return { passed: false, error: 'Validation failed' };
    }
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    
    if (expectSuccess) {
      log('red', `✗ FAILED: Unexpected error`);
      console.error('Error:', error.response?.data || error.message);
      return { passed: false, error: error.message };
    } else {
      // Expected error case
      const errorMsg = error.response?.data?.error || error.message;
      
      if (expectedError && !errorMsg.includes(expectedError)) {
        log('red', `✗ FAILED: Wrong error message`);
        console.log(`  Expected: "${expectedError}"`);
        console.log(`  Got: "${errorMsg}"`);
        return { passed: false, error: 'Wrong error message' };
      }
      
      log('green', `✓ PASSED: Got expected error`);
      console.log(`  Error: ${errorMsg}`);
      return { passed: true, time: totalTime };
    }
  }
}

async function runAllTests() {
  log('cyan', '\n' + '='.repeat(60));
  log('cyan', '  3D Search Endpoint Test Suite');
  log('cyan', '='.repeat(60));
  
  const results = [];
  
  for (const testCase of TEST_CASES) {
    const result = await runTest(testCase);
    results.push({ name: testCase.name, ...result });
    
    // Wait a bit between tests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Summary
  log('blue', '\n' + '='.repeat(60));
  log('cyan', '  Test Summary');
  log('blue', '='.repeat(60));
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + (r.time || 0), 0);
  
  results.forEach(r => {
    const status = r.passed ? `${colors.green}✓ PASSED${colors.reset}` : `${colors.red}✗ FAILED${colors.reset}`;
    const time = r.time ? ` (${formatTime(r.time)})` : '';
    console.log(`${status} ${r.name}${time}`);
    if (!r.passed && r.error) {
      console.log(`  Error: ${r.error}`);
    }
  });
  
  log('blue', '='.repeat(60));
  log(failed === 0 ? 'green' : 'yellow', `\nResults: ${passed}/${results.length} passed, ${failed} failed`);
  log('blue', `Total Test Time: ${formatTime(totalTime)}\n`);
  
  // Exit with appropriate code
  process.exit(failed === 0 ? 0 : 1);
}

// Run tests
runAllTests().catch(error => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});

