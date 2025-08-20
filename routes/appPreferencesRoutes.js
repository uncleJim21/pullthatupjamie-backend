const express = require('express');
const router = express.Router();
const { User } = require('../models/User');
const { authenticateToken } = require('../middleware/authMiddleware');

// Current schema version (YYYYMMDDXXX format)
const CURRENT_SCHEMA_VERSION = 20250812001;

// Deep merge helper that merges arrays of objects by "id" when present,
// otherwise replaces arrays. Objects are merged recursively.
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMergeById(base, incoming) {
  if (Array.isArray(base) && Array.isArray(incoming)) {
    const incomingAllHaveId = incoming.every(item => isPlainObject(item) && 'id' in item);
    const baseAllHaveId = base.every(item => isPlainObject(item) && 'id' in item);

    if (incomingAllHaveId && baseAllHaveId) {
      const mergedMap = new Map();
      // Seed with base by id
      for (const item of base) {
        mergedMap.set(item.id, item);
      }
      // Merge/insert incoming by id
      for (const item of incoming) {
        const existing = mergedMap.get(item.id);
        if (existing) {
          mergedMap.set(item.id, deepMergeById(existing, item));
        } else {
          mergedMap.set(item.id, item);
        }
      }
      return Array.from(mergedMap.values());
    }
    // Fallback: replace arrays that don't have id semantics
    return incoming;
  }

  if (isPlainObject(base) && isPlainObject(incoming)) {
    const result = { ...base };
    for (const key of Object.keys(incoming)) {
      if (key in base) {
        result[key] = deepMergeById(base[key], incoming[key]);
      } else {
        result[key] = incoming[key];
      }
    }
    return result;
  }

  // Primitive or differing types -> take incoming
  return incoming;
}

/**
 * GET /api/preferences
 * Retrieve user app preferences
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Find user by email from token
    const user = await User.findOne({ email: req.user.email }).select('+app_preferences');
    console.log('Found user:', user?.email);

    // Return default preferences if no preferences exist yet
    if (!user?.app_preferences) {
      return res.json({
        preferences: { scheduledPostSlots: [] },
        schemaVersion: CURRENT_SCHEMA_VERSION
      });
    }

    const preferencesData = user.app_preferences.data || {};
    if (!Array.isArray(preferencesData.scheduledPostSlots)) {
      preferencesData.scheduledPostSlots = [];
    }
    if (typeof preferencesData.jamieFullAutoEnabled !== 'boolean') {
      preferencesData.jamieFullAutoEnabled = false;
    }

    res.json({
      preferences: preferencesData,
      schemaVersion: user.app_preferences.schemaVersion || CURRENT_SCHEMA_VERSION
    });
  } catch (error) {
    console.error('Error fetching user app preferences:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

/**
 * PUT /api/preferences
 * Update user app preferences (partial updates supported)
 */
router.put('/', authenticateToken, async (req, res) => {
  try {
    const { preferences, schemaVersion } = req.body;

    if (!preferences || typeof preferences !== 'object') {
      return res.status(400).json({ 
        error: 'Invalid preferences format',
        message: 'Preferences must be an object'
      });
    }

    // Load existing preferences to perform a deep merge
    const existingUser = await User.findOne({ email: req.user.email }).select('+app_preferences');
    const existingData = existingUser?.app_preferences?.data || {};

    // Ensure scheduledPostSlots exists as array on base before merging
    if (!Array.isArray(existingData.scheduledPostSlots)) {
      existingData.scheduledPostSlots = [];
    }

    let mergedPreferences = deepMergeById(existingData, preferences);

    // Special-case: treat scheduledPostSlots as authoritative replacement to allow deletions
    if (Object.prototype.hasOwnProperty.call(preferences, 'scheduledPostSlots')) {
      if (preferences.scheduledPostSlots == null) {
        mergedPreferences.scheduledPostSlots = [];
      } else if (Array.isArray(preferences.scheduledPostSlots)) {
        mergedPreferences.scheduledPostSlots = preferences.scheduledPostSlots;
      } else {
        return res.status(400).json({
          error: 'Invalid preferences format',
          message: 'scheduledPostSlots must be an array or null'
        });
      }
    }

    // Special-case: primitive replacement for jamieAssistDefaults when provided
    if (Object.prototype.hasOwnProperty.call(preferences, 'jamieAssistDefaults')) {
      if (preferences.jamieAssistDefaults == null || typeof preferences.jamieAssistDefaults === 'string') {
        mergedPreferences.jamieAssistDefaults = preferences.jamieAssistDefaults || '';
      } else {
        return res.status(400).json({
          error: 'Invalid preferences format',
          message: 'jamieAssistDefaults must be a string or null'
        });
      }
    }

    // Special-case: boolean replacement for jamieFullAutoEnabled when provided
    if (Object.prototype.hasOwnProperty.call(preferences, 'jamieFullAutoEnabled')) {
      if (preferences.jamieFullAutoEnabled == null) {
        mergedPreferences.jamieFullAutoEnabled = false;
      } else if (typeof preferences.jamieFullAutoEnabled === 'boolean') {
        mergedPreferences.jamieFullAutoEnabled = preferences.jamieFullAutoEnabled;
      } else {
        return res.status(400).json({
          error: 'Invalid preferences format',
          message: 'jamieFullAutoEnabled must be a boolean or null'
        });
      }
    }

    // Persist merged preferences with strong write concern, then re-read fresh from DB
    // Update all docs that match this email in case of accidental duplicates
    const updateFilter = { email: req.user.email };
    const updateOperation = {
      $set: {
        'app_preferences.data': mergedPreferences,
        'app_preferences.schemaVersion': CURRENT_SCHEMA_VERSION
      }
    };
    const writeOptions = { upsert: true, writeConcern: { w: 'majority' } };
    const writeResult = await User.updateMany(updateFilter, updateOperation, writeOptions);

    // Wait briefly to ensure replication and read-after-write visibility even under lag
    await new Promise(resolve => setTimeout(resolve, 1000));

    const user = await User.findOne({ email: req.user.email })
      .read('primary')
      .select('+app_preferences')
      .lean();

    console.log('Updated user preferences for:', user?.email);

    const responseData = user?.app_preferences?.data || {};
    if (!Array.isArray(responseData.scheduledPostSlots)) {
      responseData.scheduledPostSlots = [];
    }

    // Provide a read-back snapshot as a separate field for verification
    const readbackData = responseData;
    let response = {
      preferences: responseData,
      schemaVersion: user?.app_preferences?.schemaVersion || CURRENT_SCHEMA_VERSION,
    }
    if (process.env.DEBUG_MODE === 'true') {
      response.dbReadbackPreferences = readbackData;
      response.debugWrite = {
        filter: updateFilter,
        set: updateOperation.$set,
        result: writeResult
      }
    }

    res.json(response);
  } catch (error) {
    console.error('Error updating user app preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

module.exports = router;