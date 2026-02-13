#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SEED TEST DATABASE SCRIPT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Copies the last 100 documents from prod collections to the test database.
 * 
 * Collections copied:
 *   - jamievectormetadata (for search-quotes-3d)
 *   - researchsessions
 *   - sharedresearchsessions
 * 
 * Usage:
 *   node test/new-auth/seed_test_db.js
 * 
 * Requirements:
 *   - MONGO_URI (production)
 *   - MONGO_DEBUG_URI (test database)
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const COLLECTIONS_TO_COPY = [
  'jamieVectorMetadata',
  'researchsessions', 
  'sharedresearchsessions'
];

const DOCS_PER_COLLECTION = 100;

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(color, msg) {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

async function main() {
  log('blue', '═══════════════════════════════════════════════════════════════════════════════');
  log('blue', '                    SEED TEST DATABASE SCRIPT');
  log('blue', '═══════════════════════════════════════════════════════════════════════════════');
  console.log('');
  
  const prodUri = process.env.MONGO_URI;
  const testUri = process.env.MONGO_DEBUG_URI;
  
  if (!prodUri) {
    log('red', '✗ MONGO_URI not set');
    process.exit(1);
  }
  
  if (!testUri) {
    log('red', '✗ MONGO_DEBUG_URI not set');
    process.exit(1);
  }
  
  // Safety check - make sure we're not copying to the same database
  if (prodUri === testUri) {
    log('red', '✗ MONGO_URI and MONGO_DEBUG_URI are the same! Aborting.');
    process.exit(1);
  }
  
  log('yellow', `Copying ${DOCS_PER_COLLECTION} documents per collection...`);
  log('cyan', `Collections: ${COLLECTIONS_TO_COPY.join(', ')}`);
  console.log('');
  
  let prodClient, testClient;
  
  try {
    // Connect to both databases
    log('yellow', 'Connecting to production database...');
    prodClient = new MongoClient(prodUri);
    await prodClient.connect();
    const prodDb = prodClient.db();
    log('green', `✓ Connected to prod: ${prodDb.databaseName}`);
    
    log('yellow', 'Connecting to test database...');
    testClient = new MongoClient(testUri);
    await testClient.connect();
    const testDb = testClient.db();
    log('green', `✓ Connected to test: ${testDb.databaseName}`);
    
    console.log('');
    
    // Copy each collection
    for (const collectionName of COLLECTIONS_TO_COPY) {
      log('blue', `───────────────────────────────────────────────────────────────────────────────`);
      log('blue', `Collection: ${collectionName}`);
      log('blue', `───────────────────────────────────────────────────────────────────────────────`);
      
      const prodCollection = prodDb.collection(collectionName);
      const testCollection = testDb.collection(collectionName);
      
      // Check if prod collection exists and has documents
      const prodCount = await prodCollection.countDocuments();
      if (prodCount === 0) {
        log('yellow', `  ⚠ No documents in prod collection, skipping`);
        continue;
      }
      log('cyan', `  Prod has ${prodCount} documents`);
      
      // Get the last N documents (sorted by _id descending for most recent)
      const docs = await prodCollection
        .find({})
        .sort({ _id: -1 })
        .limit(DOCS_PER_COLLECTION)
        .toArray();
      
      log('cyan', `  Fetched ${docs.length} documents from prod`);
      
      // Clear existing documents in test collection
      const deleteResult = await testCollection.deleteMany({});
      log('yellow', `  Cleared ${deleteResult.deletedCount} existing documents from test`);
      
      // Insert into test collection
      if (docs.length > 0) {
        const insertResult = await testCollection.insertMany(docs);
        log('green', `  ✓ Inserted ${insertResult.insertedCount} documents into test`);
      }
      
      console.log('');
    }
    
    // Summary
    log('blue', '═══════════════════════════════════════════════════════════════════════════════');
    log('blue', '                         COMPLETE');
    log('blue', '═══════════════════════════════════════════════════════════════════════════════');
    log('green', '✓ Test database seeded successfully!');
    console.log('');
    log('yellow', 'You can now run: node test/new-auth/test-real-endpoints.js');
    
  } catch (error) {
    log('red', `\n✗ Error: ${error.message}`);
    console.error(error);
    process.exit(1);
  } finally {
    if (prodClient) await prodClient.close();
    if (testClient) await testClient.close();
  }
}

main();
