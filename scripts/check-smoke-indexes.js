require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  const conn = await mongoose.connect(process.env.MONGO_URI);
  const colls = ['jamieVectorMetadataChapterSmoke', 'jamieVectorMetadataChapterTest'];
  for (const name of colls) {
    const c = conn.connection.db.collection(name);
    const total = await c.countDocuments();
    let indexes = [];
    try {
      indexes = await c.aggregate([{ $listSearchIndexes: {} }]).toArray();
    } catch (e) {
      indexes = [{ name: '(error: ' + e.message + ')' }];
    }
    console.log(`${name}:  docs=${total}`);
    for (const idx of indexes) {
      console.log(`  - "${idx.name}"  status=${idx.status || '?'}  queryable=${idx.queryable}`);
    }
    if (indexes.length === 0) console.log('  (no Atlas Search indexes)');
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
