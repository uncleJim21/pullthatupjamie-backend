/**
 * test-umap-projector.js
 * 
 * Unit tests for UmapProjector utility
 */

const UmapProjector = require('../utils/UmapProjector');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function assert(condition, message) {
  if (condition) {
    log('green', `  ✓ ${message}`);
    return true;
  } else {
    log('red', `  ✗ ${message}`);
    return false;
  }
}

// Generate random embeddings for testing
function generateRandomEmbeddings(count, dimensions = 1536) {
  const embeddings = [];
  for (let i = 0; i < count; i++) {
    const embedding = [];
    for (let j = 0; j < dimensions; j++) {
      embedding.push(Math.random() * 2 - 1); // Range [-1, 1]
    }
    embeddings.push(embedding);
  }
  return embeddings;
}

async function testBasicProjection() {
  log('cyan', '\nTest: Basic UMAP Projection (10 points)');
  log('cyan', '='.repeat(50));
  
  let passed = true;
  
  try {
    const embeddings = generateRandomEmbeddings(10);
    const projector = new UmapProjector();
    
    const start = Date.now();
    const coordinates = await projector.project(embeddings);
    const time = Date.now() - start;
    
    passed = assert(Array.isArray(coordinates), 'Returns array') && passed;
    passed = assert(coordinates.length === 10, 'Returns 10 coordinates') && passed;
    passed = assert(coordinates[0].x !== undefined, 'Coordinate has x') && passed;
    passed = assert(coordinates[0].y !== undefined, 'Coordinate has y') && passed;
    passed = assert(coordinates[0].z !== undefined, 'Coordinate has z') && passed;
    
    // Check normalization to [-1, 1]
    const inRange = coordinates.every(c => 
      c.x >= -1 && c.x <= 1 &&
      c.y >= -1 && c.y <= 1 &&
      c.z >= -1 && c.z <= 1
    );
    passed = assert(inRange, 'All coordinates in [-1, 1] range') && passed;
    
    console.log(`  Time: ${time}ms`);
    
  } catch (error) {
    log('red', `  ✗ Error: ${error.message}`);
    passed = false;
  }
  
  return passed;
}

async function testLargeProjection() {
  log('cyan', '\nTest: Large UMAP Projection (100 points)');
  log('cyan', '='.repeat(50));
  
  let passed = true;
  
  try {
    const embeddings = generateRandomEmbeddings(100);
    const projector = new UmapProjector();
    
    const start = Date.now();
    const coordinates = await projector.project(embeddings);
    const time = Date.now() - start;
    
    passed = assert(coordinates.length === 100, 'Returns 100 coordinates') && passed;
    passed = assert(time < 5000, `Completes in <5s (${time}ms)`) && passed;
    
    // Check for reasonable distribution
    const xValues = coordinates.map(c => c.x);
    const xRange = Math.max(...xValues) - Math.min(...xValues);
    passed = assert(xRange > 0.1, `Has reasonable spread (x range: ${xRange.toFixed(2)})`) && passed;
    
    console.log(`  Time: ${time}ms`);
    console.log(`  Sample coordinate: x:${coordinates[0].x.toFixed(3)}, y:${coordinates[0].y.toFixed(3)}, z:${coordinates[0].z.toFixed(3)}`);
    
  } catch (error) {
    log('red', `  ✗ Error: ${error.message}`);
    passed = false;
  }
  
  return passed;
}

async function testFastMode() {
  log('cyan', '\nTest: Fast Mode Configuration');
  log('cyan', '='.repeat(50));
  
  let passed = true;
  
  try {
    const embeddings = generateRandomEmbeddings(50);
    
    // Standard mode
    const standardProjector = new UmapProjector();
    const standardStart = Date.now();
    await standardProjector.project(embeddings);
    const standardTime = Date.now() - standardStart;
    
    // Fast mode
    const fastConfig = UmapProjector.getFastModeConfig();
    const fastProjector = new UmapProjector(fastConfig);
    const fastStart = Date.now();
    await fastProjector.project(embeddings);
    const fastTime = Date.now() - fastStart;
    
    passed = assert(fastTime < standardTime * 1.2, `Fast mode faster or similar (standard: ${standardTime}ms, fast: ${fastTime}ms)`) && passed;
    
    console.log(`  Standard time: ${standardTime}ms`);
    console.log(`  Fast time: ${fastTime}ms`);
    console.log(`  Speedup: ${((standardTime / fastTime - 1) * 100).toFixed(1)}%`);
    
  } catch (error) {
    log('red', `  ✗ Error: ${error.message}`);
    passed = false;
  }
  
  return passed;
}

async function testMinimumPoints() {
  log('cyan', '\nTest: Minimum Points Requirement (< 4 points)');
  log('cyan', '='.repeat(50));
  
  let passed = true;
  
  try {
    const embeddings = generateRandomEmbeddings(3);
    const projector = new UmapProjector();
    
    try {
      await projector.project(embeddings);
      log('red', '  ✗ Should have thrown error for <4 points');
      passed = false;
    } catch (error) {
      passed = assert(error.message.includes('at least 4 points'), 'Throws error for <4 points') && passed;
      console.log(`  Error message: ${error.message}`);
    }
    
  } catch (error) {
    log('red', `  ✗ Unexpected error: ${error.message}`);
    passed = false;
  }
  
  return passed;
}

async function testDeterminism() {
  log('cyan', '\nTest: Deterministic Results (same seed = same output)');
  log('cyan', '='.repeat(50));
  
  let passed = true;
  
  try {
    const embeddings = generateRandomEmbeddings(20);
    const projector1 = new UmapProjector({ randomState: 42 });
    const projector2 = new UmapProjector({ randomState: 42 });
    
    const coords1 = await projector1.project(embeddings);
    const coords2 = await projector2.project(embeddings);
    
    // Check if coordinates are similar (allowing for small floating point differences)
    const similar = coords1.every((c1, i) => {
      const c2 = coords2[i];
      const diff = Math.sqrt(
        Math.pow(c1.x - c2.x, 2) +
        Math.pow(c1.y - c2.y, 2) +
        Math.pow(c1.z - c2.z, 2)
      );
      return diff < 0.01; // Allow 1% difference
    });
    
    passed = assert(similar, 'Same seed produces similar results') && passed;
    
    if (similar) {
      console.log(`  Max difference: < 0.01 (acceptable)`);
    } else {
      console.log(`  Results differ significantly`);
    }
    
  } catch (error) {
    log('red', `  ✗ Error: ${error.message}`);
    passed = false;
  }
  
  return passed;
}

async function testInvalidInput() {
  log('cyan', '\nTest: Invalid Input Handling');
  log('cyan', '='.repeat(50));
  
  let passed = true;
  
  try {
    const projector = new UmapProjector();
    
    // Test empty array
    try {
      await projector.project([]);
      log('red', '  ✗ Should throw error for empty array');
      passed = false;
    } catch (error) {
      passed = assert(error.message.includes('non-empty'), 'Throws error for empty array') && passed;
    }
    
    // Test null
    try {
      await projector.project(null);
      log('red', '  ✗ Should throw error for null');
      passed = false;
    } catch (error) {
      passed = assert(error.message.includes('non-empty'), 'Throws error for null') && passed;
    }
    
  } catch (error) {
    log('red', `  ✗ Unexpected error: ${error.message}`);
    passed = false;
  }
  
  return passed;
}

async function runAllTests() {
  log('cyan', '\n' + '='.repeat(60));
  log('cyan', '  UMAP Projector Unit Tests');
  log('cyan', '='.repeat(60));
  
  const tests = [
    { name: 'Basic Projection', fn: testBasicProjection },
    { name: 'Large Projection', fn: testLargeProjection },
    { name: 'Fast Mode', fn: testFastMode },
    { name: 'Minimum Points', fn: testMinimumPoints },
    { name: 'Determinism', fn: testDeterminism },
    { name: 'Invalid Input', fn: testInvalidInput }
  ];
  
  const results = [];
  
  for (const test of tests) {
    try {
      const passed = await test.fn();
      results.push({ name: test.name, passed });
    } catch (error) {
      log('red', `  Fatal error in test: ${error.message}`);
      results.push({ name: test.name, passed: false });
    }
  }
  
  // Summary
  log('cyan', '\n' + '='.repeat(60));
  log('cyan', '  Test Summary');
  log('cyan', '='.repeat(60));
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  results.forEach(r => {
    const status = r.passed ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    console.log(`${status} ${r.name}`);
  });
  
  log('cyan', '='.repeat(60));
  log(failed === 0 ? 'green' : 'yellow', `\nResults: ${passed}/${results.length} passed, ${failed} failed\n`);
  
  process.exit(failed === 0 ? 0 : 1);
}

// Run tests
runAllTests().catch(error => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});

