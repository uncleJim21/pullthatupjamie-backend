require('dotenv').config();
const neo4j = require('neo4j-driver');

// Get Neo4j connection details from environment variables
const NEO4J_URI = process.env.NEO4J_URI;
const NEO4J_USERNAME = process.env.NEO4J_USERNAME;
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;

if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
    throw new Error('Missing required Neo4j environment variables. Please check your .env file.');
}

// Create a driver instance
const driver = neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD),
    {
        maxConnectionPoolSize: 50,
        connectionAcquisitionTimeout: 30000
    }
);

// Test the connection
driver.verifyConnectivity()
    .then(() => console.log('Connected to Neo4j'))
    .catch(error => {
        console.error('Neo4j connection error:', error);
        process.exit(1);
    });

// Export the driver
module.exports = driver;