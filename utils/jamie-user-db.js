// utils/jamie-db.js
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

let sqliteDb;

async function initializeJamieUserDB() {
    sqliteDb = await open({
        filename: path.join('.', 'jamie-user.db'),
        driver: sqlite3.Database,
    });

    await sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS jamie_users (
            square_id TEXT PRIMARY KEY,
            subscription_status TEXT DEFAULT 'inactive',
            last_validated INTEGER,
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
    `);

    console.log('Initialized Jamie users DB');
    return sqliteDb;
}

// Helper function to get user by square_id
async function getJamieUser(squareId) {
    return await sqliteDb.get(
        'SELECT * FROM jamie_users WHERE square_id = ?',
        [squareId]
    );
}

// Helper function to create or update user
async function upsertJamieUser(squareId, status = 'inactive') {
    const now = Math.floor(Date.now() / 1000);
    await sqliteDb.run(
        `INSERT INTO jamie_users (square_id, subscription_status, last_validated) 
         VALUES (?, ?, ?)
         ON CONFLICT(square_id) 
         DO UPDATE SET subscription_status = ?, last_validated = ?`,
        [squareId, status, now, status, now]
    );
}

// Helper to update subscription status
async function updateSubscriptionStatus(squareId, status) {
    const now = Math.floor(Date.now() / 1000);
    await sqliteDb.run(
        `UPDATE jamie_users 
         SET subscription_status = ?, last_validated = ? 
         WHERE square_id = ?`,
        [status, now, squareId]
    );
}


const squareRequestMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Basic ')) {
        return next();
    }

    try {
        console.log('[INFO] Square request middleware started');
        const base64Credentials = authHeader.split(' ')[1];
        const [email] = Buffer.from(base64Credentials, 'base64').toString('ascii').split(':');

        if (!email) {
            console.log('[INFO] No email provided in Basic auth');
            return next();
        }

        const user = await withTimeout(
            getJamieUser(email),
            5000
        );

        if (!user) {
            console.log(`[INFO] No record found for email: ${email}`);
            return next();
        }

        if (user.subscription_status !== 'active') {
            console.log(`[INFO] Inactive subscription for email: ${email}`);
            return next();
        }

        console.log(`[INFO] Valid Square auth for email: ${email}`);
        
        // Set both email and auth properties to ensure proper recognition
        req.auth = {
            email,
            username: process.env.ANON_AUTH_USERNAME,
            password: process.env.ANON_AUTH_PW,
            isValidSquareAuth: true  // Add flag to explicitly mark Square auth
        };

        // Call next() directly, don't cascade to free middleware
        next();
        return; // Important: return here to prevent further middleware execution
    } catch (err) {
        console.error('[ERROR] Square middleware error:', err);
        return next();
    }
};

// Add wrapper for SQLite operations with timeout if not already present
const withTimeout = (promise, timeoutMs) => {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Operation timed out')), timeoutMs)
        ),
    ]);
};

module.exports = {
    initializeJamieUserDB,
    getJamieUser,
    upsertJamieUser,
    updateSubscriptionStatus,
    squareRequestMiddleware,
    db: () => sqliteDb
};