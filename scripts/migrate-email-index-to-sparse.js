/**
 * migrate-email-index-to-sparse.js
 *
 * One-shot migration: drops the non-sparse unique index on `email` in the
 * `users` collection so that Mongoose can recreate it as sparse on the next
 * server restart.  This allows multiple OAuth/Nostr users with `email: null`.
 *
 * Usage:
 *   MONGO_URI="<uri>" node scripts/migrate-email-index-to-sparse.js
 *   # or, if .env already has MONGO_URI:
 *   node scripts/migrate-email-index-to-sparse.js
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

async function migrate() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Provide it via .env or environment.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  console.log('Connected to MongoDB.');

  const db = client.db(); // uses the database from the connection URI
  const indexes = await db.collection('users').indexes();
  const emailIdx = indexes.find(i => i.name === 'email_1');

  if (!emailIdx) {
    console.log('No email_1 index found — nothing to do.');
  } else if (emailIdx.sparse) {
    console.log('email_1 is already sparse — nothing to do.');
  } else {
    console.log('Found non-sparse email_1 index. Dropping…');
    await db.collection('users').dropIndex('email_1');
    console.log('Dropped non-sparse email_1 index. Restart the server to recreate it as sparse.');
  }

  await client.close();
  console.log('Disconnected.');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
