require('dotenv').config();
const neo4jDriver = require('./mentionsNeo4jDriver');

async function setupDatabase() {
    const session = neo4jDriver.session();
    try {
        console.log('Setting up Neo4j database schema...');

        // Create constraints with updated syntax
        console.log('Creating constraints...');
        const constraints = [
            `CREATE CONSTRAINT feed_id_unique IF NOT EXISTS
             FOR (f:Feed) REQUIRE f.feedId IS UNIQUE`,
            
            `CREATE CONSTRAINT feed_guid_unique IF NOT EXISTS
             FOR (f:Feed) REQUIRE f.podcastGuid IS UNIQUE`,
            
            `CREATE CONSTRAINT episode_guid_unique IF NOT EXISTS
             FOR (e:Episode) REQUIRE e.guid IS UNIQUE`,
            
            `CREATE CONSTRAINT sentence_guid_unique IF NOT EXISTS
             FOR (s:Sentence) REQUIRE s.guid IS UNIQUE`
        ];

        for (const constraint of constraints) {
            try {
                await session.run(constraint);
                console.log('Created constraint:', constraint.split('\n')[0]);
            } catch (error) {
                console.error('Error creating constraint:', error.message);
            }
        }

        // Create indexes for better query performance
        console.log('\nCreating indexes...');
        const indexes = [
            `CREATE INDEX feed_id_idx IF NOT EXISTS
             FOR (f:Feed) ON (f.feedId)`,
            
            `CREATE INDEX episode_feed_idx IF NOT EXISTS
             FOR (e:Episode) ON (e.feedId)`,
            
            `CREATE INDEX sentence_episode_idx IF NOT EXISTS
             FOR (s:Sentence) ON (s.episodeGuid)`
        ];

        for (const index of indexes) {
            try {
                await session.run(index);
                console.log('Created index:', index.split('\n')[0]);
            } catch (error) {
                console.error('Error creating index:', error.message);
            }
        }

        // Create vector index for embeddings
        console.log('\nCreating vector index for embeddings...');
        try {
            await session.run(`
                CALL db.index.vector.createNodeIndex(
                    'sentence_embedding_idx',
                    'Sentence',
                    'embedding',
                    1536,
                    'cosine'
                )
            `);
            console.log('Created vector index for embeddings');
        } catch (error) {
            if (error.code === 'Neo.ClientError.Procedure.ProcedureNotFound') {
                console.error('\nWARNING: Vector indexes are not supported in this Neo4j version.');
                console.error('Please ensure you are using Neo4j Enterprise Edition 5.11 or later.');
            } else {
                console.error('Error creating vector index:', error.message);
            }
        }

        // Verify setup
        console.log('\nVerifying database setup...');
        const indexList = await session.run('SHOW INDEXES');
        console.log('\nExisting indexes:');
        indexList.records.forEach(record => {
            console.log(`- ${record.get('name')}: ${record.get('type') || record.get('type')}`);
        });

        const constraintList = await session.run('SHOW CONSTRAINTS');
        console.log('\nExisting constraints:');
        constraintList.records.forEach(record => {
            console.log(`- ${record.get('name')}: ${record.get('type') || record.get('type')}`);
        });

    } catch (error) {
        console.error('Setup failed:', error);
    } finally {
        await session.close();
        await neo4jDriver.close();
    }
}

// Execute setup
console.log('Starting database setup...\n');
setupDatabase()
    .then(() => {
        console.log('\nSetup complete');
        process.exit(0);
    })
    .catch(error => {
        console.error('\nFatal error:', error);
        process.exit(1);
    });