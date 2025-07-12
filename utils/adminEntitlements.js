const { getEntitlementStats, resetEntitlement, updateEntitlementConfig } = require('./entitlements');
const { Entitlement } = require('../models/Entitlement');

/**
 * Get comprehensive entitlement statistics
 */
const getComprehensiveStats = async () => {
    try {
        const stats = await getEntitlementStats();
        
        // Get total counts by type
        const totalCounts = await Entitlement.aggregate([
            {
                $group: {
                    _id: {
                        identifierType: '$identifierType',
                        entitlementType: '$entitlementType'
                    },
                    count: { $sum: 1 }
                }
            }
        ]);
        
        // Get recent activity
        const recentActivity = await Entitlement.find({
            lastUsed: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
        }).sort({ lastUsed: -1 }).limit(10);
        
        return {
            summary: stats,
            totalCounts,
            recentActivity: recentActivity.map(ent => ({
                identifier: ent.identifier,
                identifierType: ent.identifierType,
                entitlementType: ent.entitlementType,
                usedCount: ent.usedCount,
                remainingUsage: ent.remainingUsage,
                lastUsed: ent.lastUsed
            }))
        };
    } catch (error) {
        console.error('Error getting comprehensive stats:', error);
        return null;
    }
};

/**
 * Reset all entitlements for a specific type
 */
const resetAllEntitlements = async (entitlementType) => {
    try {
        const result = await Entitlement.updateMany(
            { entitlementType },
            {
                usedCount: 0,
                periodStart: new Date(),
                lastUsed: new Date(),
                status: 'active'
            }
        );
        
        return {
            success: true,
            modifiedCount: result.modifiedCount,
            message: `Reset ${result.modifiedCount} entitlements for type: ${entitlementType}`
        };
    } catch (error) {
        console.error('Error resetting entitlements:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

/**
 * Get entitlements for a specific identifier
 */
const getEntitlementsForIdentifier = async (identifier, identifierType) => {
    try {
        const entitlements = await Entitlement.find({
            identifier,
            identifierType
        });
        
        return entitlements;
    } catch (error) {
        console.error('Error getting entitlements for identifier:', error);
        return [];
    }
};

/**
 * Update entitlement configuration for a specific identifier
 */
const updateEntitlementForIdentifier = async (identifier, identifierType, entitlementType, updates) => {
    try {
        const result = await updateEntitlementConfig(identifier, identifierType, entitlementType, updates);
        return result;
    } catch (error) {
        console.error('Error updating entitlement:', error);
        return null;
    }
};

/**
 * Clean up expired entitlements (optional maintenance function)
 */
const cleanupExpiredEntitlements = async () => {
    try {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        
        const result = await Entitlement.deleteMany({
            lastUsed: { $lt: thirtyDaysAgo },
            usedCount: 0
        });
        
        return {
            success: true,
            deletedCount: result.deletedCount,
            message: `Cleaned up ${result.deletedCount} expired entitlements`
        };
    } catch (error) {
        console.error('Error cleaning up entitlements:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

module.exports = {
    getComprehensiveStats,
    resetAllEntitlements,
    getEntitlementsForIdentifier,
    updateEntitlementForIdentifier,
    cleanupExpiredEntitlements
}; 