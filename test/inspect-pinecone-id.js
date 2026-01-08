// Simple script to inspect raw Pinecone metadata for a given vector ID.
// Usage:
//   node test/inspect-pinecone-id.js substack:post:181747680_p0

require('dotenv').config();

const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX = process.env.PINECONE_INDEX;

if (!PINECONE_API_KEY || !PINECONE_INDEX) {
  console.error('Missing required Pinecone environment variables (PINECONE_API_KEY, PINECONE_INDEX).');
  process.exit(1);
}

async function inspectId(id) {
  try {
    const pinecone = new Pinecone({
      apiKey: PINECONE_API_KEY,
      fetchApi: fetch,
    });

    const index = pinecone.index(PINECONE_INDEX);

    console.log(`\n🔎 Fetching Pinecone record for ID: ${id}\n`);

    const result = await index.fetch([id]);

    console.log('Raw fetch result:\n');
    console.log(JSON.stringify(result, null, 2));

    const record = result?.records?.[id];
    if (!record) {
      console.log('\n⚠️ No record found for that ID.');
      return;
    }

    console.log('\n=== Metadata only ===\n');
    console.log(JSON.stringify(record.metadata || {}, null, 2));
  } catch (err) {
    console.error('\n❌ Error inspecting Pinecone ID:', err.message);
    console.error(err);
    process.exit(1);
  }
}

const id = process.argv[2] || 'substack:post:181747680_p0';
inspectId(id);


