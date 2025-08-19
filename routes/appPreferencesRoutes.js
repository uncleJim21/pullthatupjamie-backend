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

    const mergedPreferences = deepMergeById(existingData, preferences);

    // Persist merged preferences
    const user = await User.findOneAndUpdate(
      { email: req.user.email },
      { 
        $set: {
          'app_preferences.data': mergedPreferences,
          'app_preferences.schemaVersion': CURRENT_SCHEMA_VERSION
        }
      },
      { 
        new: true, 
        select: '+app_preferences',
        upsert: true, // Create app_preferences if it doesn't exist
        setDefaultsOnInsert: true
      }
    );

    console.log('Updated user preferences for:', user.email);

    const responseData = user.app_preferences.data || {};
    if (!Array.isArray(responseData.scheduledPostSlots)) {
      responseData.scheduledPostSlots = [];
    }

    res.json({
      preferences: responseData,
      schemaVersion: user.app_preferences.schemaVersion
    });
  } catch (error) {
    console.error('Error updating user app preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

module.exports = router;