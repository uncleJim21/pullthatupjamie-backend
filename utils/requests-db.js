require('dotenv').config();
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

let sqliteDb;

async function initializeRequestsDB() {
    sqliteDb = await open({
        filename: path.join('.', 'requests.db'),
        driver: sqlite3.Database,
    });

    await sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS ip_requests (
            ip TEXT PRIMARY KEY,
            request_count INTEGER DEFAULT 0,
            week_start INTEGER
        )
    `);

    console.log('Initialized requests DB');
    return sqliteDb;
}

// Helper function to get the start of the current week
const getCurrentWeekStart = () => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    now.setDate(now.getDate() - now.getDay()); // Set to Sunday
    return Math.floor(now.getTime() / 1000); // Convert to Unix timestamp
};

// Wrapper for SQLite operations with timeout
const withTimeout = (promise, timeoutMs) => {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Operation timed out')), timeoutMs)
        ),
    ]);
};

// Middleware to track free requests
const freeRequestMiddleware = async (req, res, next) => {
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 
                 req.headers['x-real-ip'] || 
                 req.ip ||
                 req.connection.remoteAddress;
    const currentWeekStart = getCurrentWeekStart();

    try {
        console.log(`[INFO] Free request middleware started for IP: ${clientIp}`);

        const row = await withTimeout(
            sqliteDb.get(
                `SELECT * FROM ip_requests WHERE ip = ?`,
                [clientIp]
            ),
            5000 // 5 seconds timeout
        );

        if (!row) {
            console.log(`[INFO] No record found for IP: ${clientIp}, creating a new one.`);
            await sqliteDb.run(
                `INSERT INTO ip_requests (ip, request_count, week_start) VALUES (?, 1, ?)`,
                [clientIp, currentWeekStart]
            );
        } else if (row.week_start < currentWeekStart) {
            console.log(`[INFO] Resetting request count for new week for IP: ${clientIp}`);
            await sqliteDb.run(
                `UPDATE ip_requests SET request_count = 1, week_start = ? WHERE ip = ?`,
                [currentWeekStart, clientIp]
            );
        } else if (row.request_count >= process.env.MAX_FREE_REQUESTS_PER_WEEK) {
            console.log(`[INFO] Free request limit exceeded for IP: ${clientIp}`);
            return res.status(429).json({ error: 'Free request limit exceeded' });
        } else {
            console.log(`[INFO] Incrementing request count for IP: ${clientIp}`);
            await sqliteDb.run(
                `UPDATE ip_requests SET request_count = request_count + 1 WHERE ip = ?`,
                [clientIp]
            );
        }

        console.log(`[INFO] Free request processed for IP: ${clientIp}`);

        // Attach default authentication details for free tier
        req.auth = {
            username: process.env.ANON_AUTH_USERNAME || 'default_user',
            password: process.env.ANON_AUTH_PW || 'default_pass',
        };

        next();
    } catch (err) {
        console.error(`[ERROR] Middleware error for IP: ${clientIp}:`, err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

// Endpoint to check free request eligibility
const checkFreeEligibility = async (req, res) => {
    const clientIp =
        req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const currentWeekStart = getCurrentWeekStart();

    console.log(`[INFO] Received request from IP: ${clientIp}`);
    console.log(`[DEBUG] Current week start timestamp: ${currentWeekStart}`);

    try {
        const row = await withTimeout(
            sqliteDb.get(
                `SELECT * FROM ip_requests WHERE ip = ?`,
                [clientIp]
            ),
            5000 // 5 seconds timeout
        );

        if (!row || row.week_start < currentWeekStart) {
            console.log(
                '[INFO] IP is eligible for free requests (new record or new week).'
            );
            return res.json({
                eligible: true,
                remainingRequests: process.env.MAX_FREE_REQUESTS_PER_WEEK,
            });
        }

        const remainingRequests = Math.max(
            process.env.MAX_FREE_REQUESTS_PER_WEEK - row.request_count,
            0
        );

        if (remainingRequests > 0) {
            console.log(`[INFO] IP is eligible with ${remainingRequests} remaining requests.`);
        } else {
            console.log('[INFO] IP has exceeded the free request limit.');
        }

        res.json({ eligible: remainingRequests > 0, remainingRequests });
    } catch (err) {
        console.error('[ERROR] Eligibility check database error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    freeRequestMiddleware,
    checkFreeEligibility,
    initializeRequestsDB,
};
