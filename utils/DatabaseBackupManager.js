// db-backup-manager.js
// =============================================================================
// DEPRECATED: SQLite Database Backup Manager
// =============================================================================
// This backup manager was designed for SQLite databases which have been removed
// due to security vulnerabilities in the sqlite3 dependency chain.
//
// STATUS: Disabled - no SQLite databases remain to backup
//
// NOTE: MongoDB handles its own backups through Atlas or mongodump.
// If you need application-level backups, consider:
// - MongoDB Atlas automated backups
// - mongodump scheduled via cron
// - A new backup utility for MongoDB collections
// =============================================================================

const fs = require('fs').promises;
const path = require('path');
const DigitalOceanSpacesManager = require('./DigitalOceanSpacesManager');

class DatabaseBackupManager {
  constructor(config) {
    // DEPRECATED: SQLite databases have been removed
    console.warn('[DEPRECATED] DatabaseBackupManager: SQLite databases have been removed.');
    console.warn('[DEPRECATED] This backup manager is now a no-op. Use MongoDB backup solutions instead.');
    
    // Keep minimal config for compatibility but don't actually do anything
    this.disabled = true;
    
    /*
    // Original implementation - kept for reference
    if (!config) {
      throw new Error('Configuration object is required');
    }

    const {
      spacesEndpoint,
      accessKeyId,
      secretAccessKey,
      bucketName,
      backupInterval = 1000 * 60 * 60 * 1, // Default: 1 hours
      dbPaths = {
        'invoices.db': path.join('.', 'invoices.db'),
        'jamie-user.db': path.join('.', 'jamie-user.db'),
        'requests.db': path.join('.', 'requests.db')
      }
    } = config;

    if (!spacesEndpoint || !accessKeyId || !secretAccessKey || !bucketName) {
      throw new Error('Missing required DigitalOcean Spaces credentials. Check your environment variables.');
    }

    this.spacesManager = new DigitalOceanSpacesManager(
        spacesEndpoint,
        accessKeyId,
        secretAccessKey,
        {
            maxRetries: 3,
            baseDelay: 1000,
            maxDelay: 10000,
            timeout: 30000
        }
    );
    this.bucketName = bucketName;
    this.backupInterval = backupInterval;
    this.dbPaths = dbPaths;
    this.spacesEndpoint = spacesEndpoint;
    */
  }

  async initialize() {
    if (this.disabled) {
      console.log('[DEPRECATED] DatabaseBackupManager.initialize() - no-op, SQLite removed');
      return;
    }
    
    /*
    try {
      console.log('Initializing database backup system...');
      await this.checkAndRestoreBackups();
      this.startPeriodicBackup();
      console.log('Database backup system initialized successfully');
    } catch (error) {
      console.error('Error initializing database backup system:', error);
      throw error;
    }
    */
  }

  async checkAndRestoreBackups() {
    if (this.disabled) return;
    
    /*
    for (const [dbName, localPath] of Object.entries(this.dbPaths)) {
      try {
        const localExists = await fs.access(localPath)
          .then(() => true)
          .catch(() => false);

        if (!localExists) {
          console.log(`Local database ${dbName} not found, attempting to restore from backup...`);
          await this.restoreFromBackup(dbName, localPath);
        } else {
          console.log(`Local database ${dbName} exists, checking if backup is newer...`);
          await this.checkAndRestoreIfNewer(dbName, localPath);
        }
      } catch (error) {
        console.error(`Error checking/restoring backup for ${dbName}:`, error);
      }
    }
    */
  }

  async checkAndRestoreIfNewer(dbName, localPath) {
    if (this.disabled) return;
    // Original implementation removed - SQLite deprecated
  }

  async restoreFromBackup(dbName, localPath) {
    if (this.disabled) return;
    // Original implementation removed - SQLite deprecated
  }

  startPeriodicBackup() {
    if (this.disabled) return;
    // Original implementation removed - SQLite deprecated
  }

  async performBackup() {
    if (this.disabled) return;
    // Original implementation removed - SQLite deprecated
  }

  getDateString() {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  async forceBackup() {
    if (this.disabled) {
      console.log('[DEPRECATED] DatabaseBackupManager.forceBackup() - no-op, SQLite removed');
      return;
    }
  }
}

module.exports = DatabaseBackupManager;
