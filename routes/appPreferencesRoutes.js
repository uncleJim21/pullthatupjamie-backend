const express = require('express');
const router = express.Router();
const { User } = require('../models/User');
const { authenticateToken } = require('../middleware/authMiddleware');

// Current schema version (YYYYMMDDXXX format)
const CURRENT_SCHEMA_VERSION = 20250812001;

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
        preferences: {},
        schemaVersion: CURRENT_SCHEMA_VERSION
      });
    }

    res.json({
      preferences: user.app_preferences.data || {},
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

    // Find and update user preferences
    const user = await User.findOneAndUpdate(
      { email: req.user.email },
      { 
        $set: {
          'app_preferences.data': preferences,
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

    res.json({
      preferences: user.app_preferences.data,
      schemaVersion: user.app_preferences.schemaVersion
    });
  } catch (error) {
    console.error('Error updating user app preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

module.exports = router;