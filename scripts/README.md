# Scripts Directory

This directory contains utility scripts for database migrations and maintenance.

## Migration Scripts

### migrate-permissions-to-entitlements.js

This script migrates existing User.permissions data to the new universal Entitlement system.

**Purpose**: 
- Finds all users with old `permissions` field in the User model
- Creates corresponding Entitlement records for each user
- Preserves usage counts and period information
- Cleans up old permissions data after successful migration

**Usage**:
```bash
# The script automatically loads environment variables from .env file
node scripts/migrate-permissions-to-entitlements.js
```

**Environment Variables Required** (in `.env` file):
- `MONGO_URI`: MongoDB connection string
- `ON_DEMAND_USAGE_LIMIT`: Maximum usage per period (default: 10)
- `ON_DEMAND_PERIOD_DAYS`: Period length in days (default: 30)

**What it does**:
1. Connects to MongoDB
2. Finds all users with `permissions` field
3. For each user:
   - Checks if they already have an entitlement (skips if yes)
   - Creates new Entitlement record with migrated data
   - Preserves usage counts and period information
4. Removes old `permissions` field from User records
5. Provides detailed migration summary

**Safety Features**:
- Skips users who already have entitlements
- Provides detailed logging of all operations
- Handles errors gracefully for individual users
- Shows comprehensive migration summary

**Example Output**:
```
🔄 Starting migration from User.permissions to Entitlement system...
✅ Connected to MongoDB
📊 Found 15 users with old permissions data
✅ Migrated permissions for user: user1@example.com
   - Used: 3/10
   - Period start: 2024-01-01T00:00:00.000Z
   - Next reset: 2024-01-31T00:00:00.000Z
...
📈 Migration Summary:
   ✅ Successfully migrated: 15 users
   ⚠️  Skipped (already migrated): 0 users
   ❌ Errors: 0 users
🧹 Cleaning up old permissions data...
✅ Cleaned up permissions field from 15 users
🎉 Migration completed successfully!
```

This migration should be run once after deploying the new entitlement system to ensure all existing users are properly migrated. 