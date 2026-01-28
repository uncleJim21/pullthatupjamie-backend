require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('../models/User');
const { Entitlement } = require('../models/Entitlement');

// Connect to MongoDB
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
  console.error('Error: MONGO_URI environment variable is required in .env file');
  process.exit(1);
}

async function migratePermissionsToEntitlements() {
  try {
    console.log('🔄 Starting migration from User.permissions to Entitlement system...');
    
    // Connect to MongoDB
    await mongoose.connect(mongoURI);
    console.log('✅ Connected to MongoDB');

    // Find all users with permissions field
    const usersWithPermissions = await User.find({
      permissions: { $exists: true, $ne: null }
    });

    console.log(`📊 Found ${usersWithPermissions.length} users with old permissions data`);

    if (usersWithPermissions.length === 0) {
      console.log('✅ No users with old permissions found. Migration complete!');
      return;
    }

    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const user of usersWithPermissions) {
      try {
        let permissions = user.permissions;
        
        // Check if this user already has an entitlement
        const existingEntitlement = await Entitlement.findOne({
          identifier: user.email,
          identifierType: 'jwt',
          entitlementType: 'on-demand-run'
        });

        if (existingEntitlement) {
          console.log(`⚠️  User ${user.email} already has entitlement, skipping...`);
          skippedCount++;
          continue;
        }

        // Handle malformed permissions data
        if (!permissions || typeof permissions !== 'object') {
          console.log(`⚠️  User ${user.email} has malformed permissions data, creating default entitlement...`);
          permissions = {};
        }

        // Calculate next reset date with fallback
        const periodLengthDays = parseInt(process.env.ON_DEMAND_PERIOD_DAYS) || 30;
        const periodStart = permissions.periodStart || new Date();
        const nextResetDate = new Date(periodStart);
        nextResetDate.setDate(nextResetDate.getDate() + periodLengthDays);

        // Create new entitlement based on old permissions (with safe defaults)
        const entitlement = new Entitlement({
          identifier: user.email,
          identifierType: 'jwt',
          entitlementType: 'on-demand-run',
          usedCount: permissions.usageThisPeriod || 0,
          maxUsage: parseInt(process.env.ON_DEMAND_USAGE_LIMIT) || 10,
          periodStart: periodStart,
          periodLengthDays: periodLengthDays,
          nextResetDate: nextResetDate,
          lastUsed: new Date(),
          status: 'active'
        });

        await entitlement.save();
        migratedCount++;
        
        console.log(`✅ Migrated permissions for user: ${user.email}`);
        console.log(`   - Used: ${permissions.usageThisPeriod || 0}/${entitlement.maxUsage}`);
        console.log(`   - Period start: ${periodStart}`);
        console.log(`   - Next reset: ${nextResetDate}`);

      } catch (error) {
        console.error(`❌ Error migrating user ${user.email}:`, error.message);
        errorCount++;
      }
    }

    console.log('\n📈 Migration Summary:');
    console.log(`   ✅ Successfully migrated: ${migratedCount} users`);
    console.log(`   ⚠️  Skipped (already migrated): ${skippedCount} users`);
    console.log(`   ❌ Errors: ${errorCount} users`);

    // Optional: Clean up old permissions data
    if (migratedCount > 0) {
      console.log('\n🧹 Cleaning up old permissions data...');
      const updateResult = await User.updateMany(
        { permissions: { $exists: true } },
        { $unset: { permissions: 1 } }
      );
      console.log(`✅ Cleaned up permissions field from ${updateResult.modifiedCount} users`);
    }

    console.log('\n🎉 Migration completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('📪 Database connection closed');
  }
}

// Run the migration
if (require.main === module) {
  migratePermissionsToEntitlements();
}

module.exports = { migratePermissionsToEntitlements }; 