const express = require('express');
const router = express.Router();
const { verifyToken } = require('../utils/tokenAuth');
const ProPodcastUserPrefs = require('../models/ProPodcastUserPrefs');
const { OpenAI } = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Function to escape special regex characters
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Structured system prompt for preference updates
const PREFERENCE_UPDATE_PROMPT = `You are a preference management assistant. Your task is to interpret natural language requests to update podcast preferences and return a structured JSON response. Be lenient with interpretation when the intent is clear.

RULES:
1. IMPORTANT: Preserve all existing topics unless explicitly asked to remove them
2. Only modify fields that the user explicitly mentions
3. For topics:
   - Make reasonable topic expansions from shorthand or acronyms
   - "preferred_topics" handles variations like:
     * "include", "add", "want", "interested in"
     * "like to hear about", "enjoy"
     * "focus on", "pay attention to"
     * "keep me updated on"
     * "included", "included topics", "include this"
   - "excluded_topics" handles variations like:
     * "exclude", "remove", "don't want"
     * "ban", "block", "disallow"
     * "not interested in", "avoid"
     * "skip", "ignore", "filter out"
     * "excluded", "excluded topics"
   - Maximum 5 topics in each array
   - Expand acronyms and shorthand into meaningful topics:
     * "ccp" → "Chinese Communist Party politics"
     * "btc" → "bitcoin analysis"
     * "eth" → "ethereum developments"
     * "defi" → "decentralized finance"
     * "ai" → "artificial intelligence trends"

RESPONSE FORMAT FOR ADDING TOPICS:
{
    "action": "update",
    "changes": {
        "preferred_topics": ["new topic 1", "new topic 2"],  // Only new topics to add
        "excluded_topics": ["new topic 3"]  // Only new topics to add
    },
    "explanation": "Added X to preferred topics"
}

RESPONSE FORMAT FOR REMOVING TOPICS:
{
    "action": "remove",
    "changes": {
        "preferred_topics": ["topic to remove"],  // Only topics to remove
        "excluded_topics": ["topic to remove"]  // Only topics to remove
    },
    "explanation": "Removed X from preferred topics"
}

EXAMPLES:
User: "add ccp to included"
Response: {
    "action": "update",
    "changes": {
        "preferred_topics": ["Chinese Communist Party politics"]
    },
    "explanation": "Added CCP (Chinese Communist Party politics) to preferred topics"
}

User: "remove politics from preferred"
Response: {
    "action": "remove",
    "changes": {
        "preferred_topics": ["politics"]
    },
    "explanation": "Removed politics from preferred topics"
}

User: "add making fun of progressives"
Response: {
    "action": "update",
    "changes": {
        "preferred_topics": ["progressive political satire"]
    },
    "explanation": "Added progressive political satire to preferred topics"
}

If the request is truly ambiguous (no clear indication of intent), respond with:
{
    "action": "clarify",
    "ambiguity": "Specific description of what needs clarification",
    "options": ["Option 1", "Option 2"],
    "suggestion": "Suggested way to rephrase the request"
}

If the request is invalid or completely unrelated to preferences, respond with:
{
    "action": "error",
    "error": "Specific error message",
    "suggestion": "Suggested correction"
}`;

/**
 * GET /api/user-prefs
 * Get user preferences using JWT token authentication
 * The email is extracted from the JWT token
 */
router.get('/', verifyToken, async (req, res) => {
    try {
        // Email is available from the token verification middleware
        const { email } = req.user;
        console.log('Looking up preferences for email:', email);

        // Find user preferences with escaped email
        const userPrefs = await ProPodcastUserPrefs.findOne({ 
            email: { $regex: `^${escapeRegExp(email)}$`, $options: 'i' }
        })
            .lean()
            .exec();

        console.log('Query result:', userPrefs);

        if (!userPrefs) {
            console.log('No preferences found for email:', email);
            return res.status(404).json({
                error: 'User preferences not found',
                details: 'No preferences found for this user'
            });
        }

        // Return user preferences
        res.json({
            success: true,
            data: userPrefs
        });
    } catch (error) {
        console.error('Error fetching user preferences:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: 'Error fetching user preferences'
        });
    }
});

/**
 * GET /api/user-prefs/:feedId
 * Get user preferences for a specific feed
 */
router.get('/:feedId', verifyToken, async (req, res) => {
    try {
        const { email } = req.user;
        const { feedId } = req.params;
        
        console.log('DEBUG - Token email:', email);
        console.log('DEBUG - Requested feedId:', feedId);

        // Find user preferences with escaped email
        const escapedEmail = escapeRegExp(email);
        console.log('DEBUG - Escaped email:', escapedEmail);
        
        const query = { email: { $regex: `^${escapedEmail}$`, $options: 'i' } };
        console.log('DEBUG - MongoDB query:', JSON.stringify(query));

        // Count total documents in collection
        const totalDocs = await ProPodcastUserPrefs.countDocuments();
        console.log('DEBUG - Total documents in collection:', totalDocs);

        // List all documents to verify data
        const allDocs = await ProPodcastUserPrefs.find({}).lean();
        console.log('DEBUG - All documents:', JSON.stringify(allDocs, null, 2));

        const userPrefs = await ProPodcastUserPrefs.findOne(query)
            .lean()
            .exec();

        console.log('DEBUG - Query result:', JSON.stringify(userPrefs, null, 2));

        if (!userPrefs) {
            console.log('DEBUG - No preferences found for email:', email);
            return res.status(404).json({
                error: 'User preferences not found',
                details: 'No preferences found for this user'
            });
        }

        // Find preferences for the specific feed
        const feedPrefs = userPrefs.podcast_preferences.find(pref => pref.feed_id === feedId);

        console.log('Feed preferences found:', feedPrefs);

        if (!feedPrefs) {
            console.log('No preferences found for feedId:', feedId);
            return res.status(404).json({
                error: 'Feed preferences not found',
                details: 'No preferences found for this feed'
            });
        }

        // Return feed-specific preferences
        res.json({
            success: true,
            data: feedPrefs
        });
    } catch (error) {
        console.error('Error fetching feed preferences:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: 'Error fetching feed preferences'
        });
    }
});

/**
 * POST /api/user-prefs/:feedId/update
 * Update user preferences using natural language input
 */
router.post('/:feedId/update', verifyToken, async (req, res) => {
    try {
        const { email } = req.user;
        const { feedId } = req.params;
        const { userInput } = req.body;

        if (!userInput) {
            return res.status(400).json({
                error: 'Missing user input',
                details: 'Please provide your preference update request'
            });
        }

        // Get current preferences
        const userPrefs = await ProPodcastUserPrefs.findOne({ 
            email: { $regex: `^${escapeRegExp(email)}$`, $options: 'i' }
        }).lean();

        if (!userPrefs) {
            return res.status(404).json({
                error: 'User preferences not found',
                details: 'No preferences found for this user'
            });
        }

        // Find current feed preferences
        const currentFeedPrefs = userPrefs.podcast_preferences.find(pref => pref.feed_id === feedId);

        if (!currentFeedPrefs) {
            return res.status(404).json({
                error: 'Feed preferences not found',
                details: 'No preferences found for this feed'
            });
        }

        // Construct the user message with current preferences context
        const userMessage = `Current preferences for feed ${feedId}:
${JSON.stringify(currentFeedPrefs, null, 2)}

User request: ${userInput}

Please analyze this request and provide appropriate preference updates.`;

        // Get LLM interpretation of the update request
        const completion = await openai.chat.completions.create({
            model: "gpt-4-turbo-preview",
            messages: [
                { role: "system", content: PREFERENCE_UPDATE_PROMPT },
                { role: "user", content: userMessage }
            ],
            temperature: 0.1 // Low temperature for consistent, conservative updates
        });

        const llmResponse = JSON.parse(completion.choices[0].message.content);

        // Handle clarification needed
        if (llmResponse.action === "clarify") {
            return res.status(202).json({
                status: 'clarification_needed',
                ambiguity: llmResponse.ambiguity,
                options: llmResponse.options,
                suggestion: llmResponse.suggestion
            });
        }

        // Handle error response from LLM
        if (llmResponse.action === "error") {
            return res.status(400).json({
                error: llmResponse.error,
                suggestion: llmResponse.suggestion
            });
        }

        // Apply the updates
        const updatedPrefs = {
            ...currentFeedPrefs
        };

        // Handle array fields specially to preserve existing items
        if (llmResponse.changes.preferred_topics) {
            // If it's a removal request, remove specific topics
            if (llmResponse.action === "remove") {
                updatedPrefs.preferred_topics = currentFeedPrefs.preferred_topics.filter(
                    topic => !llmResponse.changes.preferred_topics.includes(topic)
                );
            } else {
                // For additions, combine existing and new topics, maintain uniqueness
                updatedPrefs.preferred_topics = Array.from(new Set([
                    ...currentFeedPrefs.preferred_topics || [],
                    ...llmResponse.changes.preferred_topics
                ])).slice(0, 5); // Keep max 5 topics
            }
        }

        if (llmResponse.changes.excluded_topics) {
            // If it's a removal request, remove specific topics
            if (llmResponse.action === "remove") {
                updatedPrefs.excluded_topics = currentFeedPrefs.excluded_topics.filter(
                    topic => !llmResponse.changes.excluded_topics.includes(topic)
                );
            } else {
                // For additions, combine existing and new topics, maintain uniqueness
                updatedPrefs.excluded_topics = Array.from(new Set([
                    ...currentFeedPrefs.excluded_topics || [],
                    ...llmResponse.changes.excluded_topics
                ])).slice(0, 5); // Keep max 5 topics
            }
        }

        // Handle non-array fields normally
        if (llmResponse.changes.notification_frequency) {
            updatedPrefs.notification_frequency = llmResponse.changes.notification_frequency;
        }
        if (typeof llmResponse.changes.is_favorite === 'boolean') {
            updatedPrefs.is_favorite = llmResponse.changes.is_favorite;
        }
        if (typeof llmResponse.changes.is_excluded === 'boolean') {
            updatedPrefs.is_excluded = llmResponse.changes.is_excluded;
        }

        // Validate notification frequency
        if (updatedPrefs.notification_frequency && 
            !["never", "daily", "weekly", "monthly"].includes(updatedPrefs.notification_frequency)) {
            return res.status(400).json({
                error: 'Invalid notification frequency',
                details: 'Frequency must be: never, daily, weekly, or monthly'
            });
        }

        // Update the database
        const result = await ProPodcastUserPrefs.updateOne(
            { 
                email: { $regex: `^${escapeRegExp(email)}$`, $options: 'i' },
                "podcast_preferences.feed_id": feedId
            },
            { 
                $set: { "podcast_preferences.$": updatedPrefs }
            }
        );

        if (result.modifiedCount === 0) {
            return res.status(500).json({
                error: 'Update failed',
                details: 'No changes were made to the preferences'
            });
        }

        res.json({
            success: true,
            data: {
                updated: updatedPrefs,
                explanation: llmResponse.explanation
            }
        });

    } catch (error) {
        console.error('Error updating preferences:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

module.exports = router; 