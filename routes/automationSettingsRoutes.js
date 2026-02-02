const express = require('express');
const router = express.Router();
const { User } = require('../models/shared/UserSchema');
const { verifyPodcastAdminAuto } = require('../utils/podcastAdminAuth');

// Current schema version for app preferences
const CURRENT_SCHEMA_VERSION = 20250812001;

// REMOVED: Inline verifyPodcastAdminMiddleware - now using consolidated version from utils/podcastAdminAuth.js

/**
 * Helper to find user by identity (supports both userId and email)
 */
async function findUserByIdentity(identity) {
  const { userId, email } = identity;
  
  if (userId) {
    return User.findById(userId).select('+app_preferences');
  }
  if (email) {
    return User.findOne({ email }).select('+app_preferences');
  }
  return null;
}

/**
 * Helper to build update filter for user (supports both userId and email)
 */
function buildUserUpdateFilter(identity) {
  const { userId, email } = identity;
  
  if (userId) {
    return { _id: userId };
  }
  if (email) {
    return { email };
  }
  return null;
}

/**
 * GET /api/automation-settings
 * Retrieve automation settings for a podcast admin
 * The feedId is automatically determined from the admin's token
 */
router.get('/', verifyPodcastAdminAuto, async (req, res) => {
  try {
    const { userId, email, feedId: adminFeedId } = req.podcastAdmin;

    // Find user by identity (supports both userId and email)
    const user = await findUserByIdentity({ userId, email });
    console.log('Found user for automation settings:', user?.email || userId);

    // Get preferences data or use defaults
    const preferencesData = user?.app_preferences?.data || {};
    
    // Ensure required fields exist with defaults
    const scheduledPostSlots = Array.isArray(preferencesData.scheduledPostSlots) 
      ? preferencesData.scheduledPostSlots 
      : [];
    const jamieAssistDefaults = typeof preferencesData.jamieAssistDefaults === 'string' 
      ? preferencesData.jamieAssistDefaults 
      : '';
    const jamieFullAutoEnabled = typeof preferencesData.jamieFullAutoEnabled === 'boolean' 
      ? preferencesData.jamieFullAutoEnabled 
      : false;
    const randomizePostTime = typeof preferencesData.randomizePostTime === 'boolean'
      ? preferencesData.randomizePostTime
      : false;
    
    // Get curation topics (for now, we'll use an empty array as placeholder)
    // This could be extended to store feed-specific topics in the future
    const curationTopics = preferencesData.curationTopics || [];

    // Get platform automation settings
    const twitterOAuthEnabled = typeof preferencesData.twitterOAuthEnabled === 'boolean' 
      ? preferencesData.twitterOAuthEnabled 
      : false;
    const nostrAutomationEnabled = typeof preferencesData.nostrAutomationEnabled === 'boolean' 
      ? preferencesData.nostrAutomationEnabled 
      : false;

    // Build response according to the schema
    const responseData = {
      curationSettings: {
        topics: curationTopics,
        feedId: adminFeedId
      },
      postingStyle: {
        prompt: jamieAssistDefaults
      },
      postingSchedule: {
        scheduledPostSlots: scheduledPostSlots,
        randomizePostTime: randomizePostTime
      },
      automationSettings: {
        twitterOAuthEnabled: twitterOAuthEnabled,
        nostrAutomationEnabled: nostrAutomationEnabled
      },
      automationEnabled: jamieFullAutoEnabled
    };

    res.json({
      success: true,
      data: responseData
    });
  } catch (error) {
    console.error('Error fetching automation settings:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch automation settings',
      code: 500
    });
  }
});

/**
 * POST /api/automation-settings
 * Save/Update automation settings for a podcast admin
 */
router.post('/', verifyPodcastAdminAuto, async (req, res) => {
  try {
    const { userId, email, feedId: adminFeedId } = req.podcastAdmin;
    const { curationSettings, postingStyle, postingSchedule, automationSettings, automationEnabled } = req.body;

    // Validate request structure
    if (!curationSettings && !postingStyle && !postingSchedule && !automationSettings && typeof automationEnabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Invalid request format. At least one setting must be provided.',
        code: 400
      });
    }

    // No need to validate feedId - it's automatically set from the admin's token

    // Load existing preferences
    const existingUser = await findUserByIdentity({ userId, email });
    const existingData = existingUser?.app_preferences?.data || {};

    // Prepare updates object
    const updates = { ...existingData };

    // Update curation settings
    if (curationSettings) {
      if (Array.isArray(curationSettings.topics)) {
        // Validate topics array
        if (curationSettings.topics.length > 10) {
          return res.status(400).json({
            success: false,
            error: 'Maximum 10 topics allowed',
            code: 400
          });
        }
        
        // Validate each topic is a string
        if (!curationSettings.topics.every(topic => typeof topic === 'string')) {
          return res.status(400).json({
            success: false,
            error: 'All topics must be strings',
            code: 400
          });
        }
        
        updates.curationTopics = curationSettings.topics;
      }
    }

    // Update posting style
    if (postingStyle) {
      if (typeof postingStyle.prompt === 'string') {
        updates.jamieAssistDefaults = postingStyle.prompt;
      } else if (postingStyle.prompt !== undefined) {
        return res.status(400).json({
          success: false,
          error: 'Posting style prompt must be a string',
          code: 400
        });
      }
    }

    // Update posting schedule
    if (postingSchedule) {
      if (Array.isArray(postingSchedule.scheduledPostSlots)) {
        // Validate scheduled post slots structure
        for (const slot of postingSchedule.scheduledPostSlots) {
          if (!slot.id || typeof slot.id !== 'string') {
            return res.status(400).json({
              success: false,
              error: 'Each scheduled slot must have a string id',
              code: 400
            });
          }
          
          if (!Number.isInteger(slot.dayOfWeek) || slot.dayOfWeek < 1 || slot.dayOfWeek > 7) {
            return res.status(400).json({
              success: false,
              error: 'dayOfWeek must be an integer between 1 and 7',
              code: 400
            });
          }
          
          if (typeof slot.time !== 'string' || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(slot.time)) {
            return res.status(400).json({
              success: false,
              error: 'time must be in HH:mm format (24-hour)',
              code: 400
            });
          }
          
          if (typeof slot.enabled !== 'boolean') {
            return res.status(400).json({
              success: false,
              error: 'enabled must be a boolean',
              code: 400
            });
          }
        }
        
        updates.scheduledPostSlots = postingSchedule.scheduledPostSlots;
      }
      
      if (typeof postingSchedule.randomizePostTime === 'boolean') {
        updates.randomizePostTime = postingSchedule.randomizePostTime;
      }
    }

    // Update platform automation settings
    if (automationSettings) {
      if (typeof automationSettings.twitterOAuthEnabled === 'boolean') {
        updates.twitterOAuthEnabled = automationSettings.twitterOAuthEnabled;
      }
      
      if (typeof automationSettings.nostrAutomationEnabled === 'boolean') {
        updates.nostrAutomationEnabled = automationSettings.nostrAutomationEnabled;
      }
    }

    // Update automation enabled flag
    if (typeof automationEnabled === 'boolean') {
      updates.jamieFullAutoEnabled = automationEnabled;
    }

    // Build update filter (supports both userId and email)
    const updateFilter = buildUserUpdateFilter({ userId, email });
    if (!updateFilter) {
      return res.status(400).json({
        success: false,
        error: 'Could not identify user for update',
        code: 400
      });
    }

    const updateOperation = {
      $set: {
        'app_preferences.data': updates,
        'app_preferences.schemaVersion': CURRENT_SCHEMA_VERSION
      }
    };
    const writeOptions = { upsert: true, writeConcern: { w: 'majority' } };
    
    await User.updateMany(updateFilter, updateOperation, writeOptions);

    // Wait briefly to ensure replication
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Read back the updated data
    const updatedUser = await User.findOne(updateFilter)
      .read('primary')
      .select('+app_preferences')
      .lean();

    console.log('Updated automation settings for:', updatedUser?.email || userId);

    const responseData = updatedUser?.app_preferences?.data || {};
    
    // Build response in the same format as GET
    const updatedSettings = {
      curationSettings: {
        topics: responseData.curationTopics || [],
        feedId: adminFeedId
      },
      postingStyle: {
        prompt: responseData.jamieAssistDefaults || ''
      },
      postingSchedule: {
        scheduledPostSlots: responseData.scheduledPostSlots || [],
        randomizePostTime: responseData.randomizePostTime || false
      },
      automationSettings: {
        twitterOAuthEnabled: responseData.twitterOAuthEnabled || false,
        nostrAutomationEnabled: responseData.nostrAutomationEnabled || false
      },
      automationEnabled: responseData.jamieFullAutoEnabled || false
    };

    res.json({
      success: true,
      data: updatedSettings,
      message: 'Automation settings updated successfully'
    });
  } catch (error) {
    console.error('Error updating automation settings:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update automation settings',
      code: 500
    });
  }
});

module.exports = router;
