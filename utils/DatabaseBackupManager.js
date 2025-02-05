// db-backup-manager.js
const fs = require('fs').promises;
const path = require('path');
const DigitalOceanSpacesManager = require('./DigitalOceanSpacesManager');

class DatabaseBackupManager {
  constructor(config) {
    // Validate required configuration
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

    // Validate required credentials
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
  }

  async initialize() {
    try {
      console.log('Initializing database backup system...');
      await this.checkAndRestoreBackups();
      this.startPeriodicBackup();
      console.log('Database backup system initialized successfully');
    } catch (error) {
      console.error('Error initializing database backup system:', error);
      throw error;
    }
  }

  async checkAndRestoreBackups() {
    for (const [dbName, localPath] of Object.entries(this.dbPaths)) {
      try {
        // Check if local database exists
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
  }

  async checkAndRestoreIfNewer(dbName, localPath) {
    try {
      const backupKey = `db-backups/${dbName}-${this.getDateString()}`;
      const localStats = await fs.stat(localPath);
      
      // Try to get the backup file's metadata
      try {
        const backupBuffer = await this.spacesManager.getFileAsBuffer(
          this.bucketName,
          backupKey
        );
        
        // If backup exists and is newer, restore it
        const backupStats = await fs.stat(backupBuffer);
        if (backupStats.mtime > localStats.mtime) {
          console.log(`Backup of ${dbName} is newer, restoring...`);
          await this.restoreFromBackup(dbName, localPath);
        }
      } catch (error) {
        // If backup doesn't exist, that's fine
        console.log(`No newer backup found for ${dbName}`);
      }
    } catch (error) {
      console.error(`Error checking backup age for ${dbName}:`, error);
    }
  }

  async restoreFromBackup(dbName, localPath) {
    try {
      const backupKey = `db-backups/${dbName}-${this.getDateString()}`;
      const backupBuffer = await this.spacesManager.getFileAsBuffer(
        this.bucketName,
        backupKey
      );
      
      await fs.writeFile(localPath, backupBuffer);
      console.log(`Successfully restored ${dbName} from backup`);
    } catch (error) {
      console.error(`Error restoring ${dbName} from backup:`, error);
      throw error;
    }
  }

  startPeriodicBackup() {
    // Perform initial backup
    this.performBackup();

    // Schedule periodic backups
    setInterval(() => {
      this.performBackup();
    }, this.backupInterval);
  }

  async performBackup() {
    for (const [dbName, localPath] of Object.entries(this.dbPaths)) {
      try {
        const fileContent = await fs.readFile(localPath);
        const backupKey = `db-backups/${dbName}-${this.getDateString()}`;
        
        await this.spacesManager.uploadFile(
          this.bucketName,
          backupKey,
          fileContent,
          'application/x-sqlite3',
          this.spacesEndpoint
        );

        console.log(`Successfully backed up ${dbName} to ${backupKey}`);
      } catch (error) {
        console.error(`Error backing up ${dbName}:`, error);
      }
    }
  }

  getDateString() {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  // Optional: Method to force an immediate backup
  async forceBackup() {
    await this.performBackup();
  }
}

module.exports = DatabaseBackupManager;