const express = require('express');
const router = express.Router();
const crypto = require('crypto');

/**
 * POST /api/on-demand/submitOnDemandRun
 * Submit an on-demand run request
 */
router.post('/submit', async (req, res) => {
    try {
        const { message, parameters } = req.body;

        // Validate request body
        if (!message || typeof message !== 'string') {
            return res.status(400).json({
                error: 'Invalid message',
                details: 'Message must be a string'
            });
        }

        if (!parameters || typeof parameters !== 'object') {
            return res.status(400).json({
                error: 'Invalid parameters',
                details: 'Parameters must be an object'
            });
        }

        // Generate a random job ID
        const jobId = crypto.randomBytes(8).toString('hex');

        // For now, just return a success response with the job ID
        res.json({
            success: true,
            jobId: jobId,
            message: 'On-demand run submitted successfully'
        });
    } catch (error) {
        console.error('Error submitting on-demand run:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

/**
 * GET /api/on-demand/getOnDemandJobStatus/:jobId
 * Get status of an on-demand job
 */
router.get('/status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;

        // Validate job ID
        if (!jobId) {
            return res.status(400).json({
                error: 'Missing job ID',
                details: 'Please provide a job ID'
            });
        }

        // Generate a random number using crypto
        const randomValue = crypto.randomInt(1, 100);

        // For now, just return a random status
        res.json({
            success: true,
            jobId: jobId,
            status: randomValue % 3 === 0 ? 'completed' : (randomValue % 3 === 1 ? 'in_progress' : 'pending'),
            randomValue: randomValue,
            message: 'Job status retrieved successfully'
        });
    } catch (error) {
        console.error('Error getting job status:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

module.exports = router; 