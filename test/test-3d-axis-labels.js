#!/usr/bin/env node

/**
 * Test script for 3D Search Axis Labeling
 * 
 * Tests that the axis labeling feature returns meaningful labels for all 7 cardinal directions.
 * A test PASSES only if all 7 axes have non-generic labels (not "Unknown", "N/A", etc.)
 */

const http = require('http');

const PORT = process.env.PORT || 4132;
const HOST = process.env.HOST || 'localhost';

// Test queries that previously had issues
const TEST_QUERIES = [
  {
    name: 'AI Ethics & Regulation',
    query: 'artificial intelligence ethics and regulation',
    limit: 25
  },
  {
    name: 'Bitcoin Economics',
    query: 'bitcoin economics',
    limit: 25
  },
  {
    name: 'Technology Future',
    query: 'technology future',
    limit: 25
  },
  {
    name: 'Economic Policy',
    query: 'economic policy and inflation',
    limit: 25
  }
];

// Words that indicate a weak/failed label
const WEAK_LABEL_INDICATORS = [
  'unknown',
  'n/a',
  'unavailable',
  'no text',
  'no substantial',
  'creator not specified',
  'unknown episode'
];

/**
 * Check if a label is weak/generic
 */
function isWeakLabel(label) {
  if (!label || label.length < 3) return true;
  const lowerLabel = label.toLowerCase();
  return WEAK_LABEL_INDICATORS.some(indicator => lowerLabel.includes(indicator));
}

/**
 * Make HTTP request to 3D search endpoint
 */
function make3DSearchRequest(query, limit) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      query,
      limit,
      extractAxisLabels: true
    });

    const options = {
      hostname: HOST,
      port: PORT,
      path: '/api/search-quotes-3d',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 90000 // 90 second timeout
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Failed to parse JSON: ${err.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Evaluate axis labels quality
 */
function evaluateAxisLabels(axisLabels) {
  if (!axisLabels) {
    return {
      passed: false,
      score: 0,
      weak: [],
      message: 'No axis labels returned'
    };
  }

  const axes = ['center', 'xPositive', 'xNegative', 'yPositive', 'yNegative', 'zPositive', 'zNegative'];
  const weak = [];

  for (const axis of axes) {
    const label = axisLabels[axis];
    if (isWeakLabel(label)) {
      weak.push({ axis, label: label || 'null' });
    }
  }

  const score = 7 - weak.length;
  const passed = weak.length === 0;

  return {
    passed,
    score,
    weak,
    message: passed 
      ? '✅ All 7 axes have meaningful labels' 
      : `❌ ${weak.length} weak labels: ${weak.map(w => w.axis).join(', ')}`
  };
}

/**
 * Run a single test
 */
async function runTest(testCase) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Testing: ${testCase.name}`);
  console.log(`Query: "${testCase.query}"`);
  console.log(`${'='.repeat(70)}`);

  try {
    const startTime = Date.now();
    const response = await make3DSearchRequest(testCase.query, testCase.limit);
    const duration = Date.now() - startTime;

    const results = response.results || [];
    const axisLabels = response.axisLabels;
    const metadata = response.metadata || {};

    console.log(`\n📊 Response Summary:`);
    console.log(`   Results: ${results.length}`);
    console.log(`   Total Time: ${duration}ms`);
    console.log(`   Axis Labeling Time: ${metadata.axisLabelingTimeMs || 'N/A'}ms`);

    if (!axisLabels) {
      console.log(`\n❌ FAILED: No axis labels in response`);
      return false;
    }

    console.log(`\n📍 Axis Labels:`);
    const axes = ['center', 'xPositive', 'xNegative', 'yPositive', 'yNegative', 'zPositive', 'zNegative'];
    const emojis = ['🎯', '➡️ ', '⬅️ ', '⬆️ ', '⬇️ ', '🔼', '🔽'];
    
    axes.forEach((axis, i) => {
      const label = axisLabels[axis] || 'null';
      const weak = isWeakLabel(label);
      const status = weak ? '❌' : '✅';
      console.log(`   ${status} ${emojis[i]} ${axis.padEnd(12)} → "${label}"`);
    });

    const evaluation = evaluateAxisLabels(axisLabels);
    console.log(`\n${evaluation.message}`);
    console.log(`Score: ${evaluation.score}/7`);

    if (evaluation.passed) {
      console.log(`\n✅ PASSED: All axes have meaningful labels`);
    } else {
      console.log(`\n❌ FAILED: ${evaluation.weak.length} weak labels detected`);
      console.log(`Failed axes:`, evaluation.weak.map(w => `${w.axis}="${w.label}"`).join(', '));
    }

    return evaluation.passed;

  } catch (error) {
    console.log(`\n❌ FAILED: ${error.message}`);
    return false;
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`3D SEARCH AXIS LABELING TEST SUITE`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Target: http://${HOST}:${PORT}/api/search-quotes-3d`);
  console.log(`Tests: ${TEST_QUERIES.length}`);
  console.log(`Pass Criteria: All 7 axes must have meaningful labels (not "Unknown", etc.)`);

  const results = [];

  for (const testCase of TEST_QUERIES) {
    const passed = await runTest(testCase);
    results.push({ name: testCase.name, passed });
  }

  // Summary
  console.log(`\n${'='.repeat(70)}`);
  console.log(`TEST SUMMARY`);
  console.log(`${'='.repeat(70)}`);

  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.length - passedCount;

  results.forEach((result, i) => {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${i + 1}. ${status} - ${result.name}`);
  });

  console.log(`\n${passedCount}/${results.length} tests passed`);

  if (failedCount === 0) {
    console.log(`\n🎉 ALL TESTS PASSED! Axis labeling is working reliably.`);
    process.exit(0);
  } else {
    console.log(`\n❌ ${failedCount} test(s) failed. Axis labeling needs improvement.`);
    process.exit(1);
  }
}

// Run tests
console.log('Starting 3D Search Axis Labeling tests...\n');
runAllTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

