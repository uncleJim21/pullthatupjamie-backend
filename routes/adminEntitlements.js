const express = require('express');
const router = express.Router();
const { getComprehensiveStats, resetAllEntitlements, getEntitlementsForIdentifier, updateEntitlementForIdentifier, cleanupExpiredEntitlements } = require('../utils/adminEntitlements');

/**
 * GET /api/admin/entitlements/stats
 * Get comprehensive entitlement statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await getComprehensiveStats();
        
        if (!stats) {
            return res.status(500).json({
                success: false,
                error: 'Failed to retrieve entitlement statistics'
            });
        }
        
        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Error getting entitlement stats:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

/**
 * POST /api/admin/entitlements/reset
 * Reset all entitlements for a specific type
 */
router.post('/reset', async (req, res) => {
    try {
        const { entitlementType } = req.body;
        
        if (!entitlementType) {
            return res.status(400).json({
                success: false,
                error: 'entitlementType is required'
            });
        }
        
        const result = await resetAllEntitlements(entitlementType);
        
        res.json({
            success: result.success,
            ...result
        });
    } catch (error) {
        console.error('Error resetting entitlements:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

/**
 * GET /api/admin/entitlements/identifier/:identifierType/:identifier
 * Get entitlements for a specific identifier
 */
router.get('/identifier/:identifierType/:identifier', async (req, res) => {
    try {
        const { identifierType, identifier } = req.params;
        
        const entitlements = await getEntitlementsForIdentifier(identifier, identifierType);
        
        res.json({
            success: true,
            identifier,
            identifierType,
            entitlements
        });
    } catch (error) {
        console.error('Error getting entitlements for identifier:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

/**
 * PUT /api/admin/entitlements/update
 * Update entitlement configuration for a specific identifier
 */
router.put('/update', async (req, res) => {
    try {
        const { identifier, identifierType, entitlementType, updates } = req.body;
        
        if (!identifier || !identifierType || !entitlementType || !updates) {
            return res.status(400).json({
                success: false,
                error: 'identifier, identifierType, entitlementType, and updates are required'
            });
        }
        
        const result = await updateEntitlementForIdentifier(identifier, identifierType, entitlementType, updates);
        
        if (!result) {
            return res.status(404).json({
                success: false,
                error: 'Entitlement not found'
            });
        }
        
        res.json({
            success: true,
            entitlement: result
        });
    } catch (error) {
        console.error('Error updating entitlement:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

/**
 * POST /api/admin/entitlements/cleanup
 * Clean up expired entitlements
 */
router.post('/cleanup', async (req, res) => {
    try {
        const result = await cleanupExpiredEntitlements();
        
        res.json({
            success: result.success,
            ...result
        });
    } catch (error) {
        console.error('Error cleaning up entitlements:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

module.exports = router; 