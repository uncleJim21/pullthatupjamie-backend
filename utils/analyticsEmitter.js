/**
 * Analytics Emitter
 * 
 * Shared validation and emission logic for analytics events.
 * Used by both the /api/analytics endpoint and internal server-side emission.
 */

const { AnalyticsEvent } = require('../models/AnalyticsEvent');
const { ALL_EVENT_TYPES, VALID_TIERS, VALID_ENVIRONMENTS } = require('../constants/analyticsTypes');

// UUID v4 regex pattern
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Max properties size (10KB)
const MAX_PROPERTIES_SIZE = 10 * 1024;

/**
 * Get server environment based on DEBUG_MODE
 * @returns {'dev' | 'prod'}
 */
function getServerEnvironment() {
  return process.env.DEBUG_MODE === 'true' ? 'dev' : 'prod';
}

/**
 * Validate an analytics event
 * 
 * @param {Object} event - The event to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateEvent(event) {
  // Required fields
  if (!event.type) {
    return { valid: false, error: 'Missing required field: type' };
  }
  if (!event.session_id) {
    return { valid: false, error: 'Missing required field: session_id' };
  }
  if (!event.timestamp) {
    return { valid: false, error: 'Missing required field: timestamp' };
  }
  if (!event.tier) {
    return { valid: false, error: 'Missing required field: tier' };
  }
  if (!event.environment) {
    return { valid: false, error: 'Missing required field: environment' };
  }
  
  // Validate event type
  if (!ALL_EVENT_TYPES.includes(event.type)) {
    return { valid: false, error: `Invalid event type: ${event.type}` };
  }
  
  // Validate session_id format (UUID v4)
  if (!UUID_REGEX.test(event.session_id)) {
    return { valid: false, error: 'Invalid session_id format (expected UUID v4)' };
  }
  
  // Validate timestamp (ISO 8601)
  const timestamp = new Date(event.timestamp);
  if (isNaN(timestamp.getTime())) {
    return { valid: false, error: 'Invalid timestamp format (expected ISO 8601)' };
  }
  
  // Validate tier
  if (!VALID_TIERS.includes(event.tier)) {
    return { valid: false, error: `Invalid tier: ${event.tier}` };
  }
  
  // Validate environment
  if (!VALID_ENVIRONMENTS.includes(event.environment)) {
    return { valid: false, error: `Invalid environment: ${event.environment}` };
  }
  
  // Validate properties size
  if (event.properties) {
    const propsSize = JSON.stringify(event.properties).length;
    if (propsSize > MAX_PROPERTIES_SIZE) {
      return { valid: false, error: `Properties exceed max size (${propsSize} > ${MAX_PROPERTIES_SIZE})` };
    }
  }
  
  return { valid: true };
}

/**
 * Emit an analytics event (internal server-side use)
 * 
 * Used by entitlement middleware to emit events without HTTP overhead.
 * Validates and writes directly to MongoDB.
 * 
 * @param {Object} event - The event to emit
 * @returns {Promise<boolean>} - True if emitted successfully
 */
async function emitEvent(event) {
  try {
    const validation = validateEvent(event);
    if (!validation.valid) {
      console.warn('[Analytics] Invalid event:', validation.error, event.type);
      return false;
    }
    
    await AnalyticsEvent.create({
      type: event.type,
      session_id: event.session_id,
      timestamp: new Date(event.timestamp),
      tier: event.tier,
      environment: event.environment,
      properties: event.properties || {},
      server_timestamp: new Date()
    });
    
    return true;
  } catch (error) {
    // Analytics should never break the main flow
    console.error('[Analytics] Failed to emit event:', error.message);
    return false;
  }
}

/**
 * Emit a server-side event with minimal input
 * 
 * Convenience wrapper for entitlement middleware.
 * Automatically sets environment and timestamp.
 * 
 * @param {string} type - Event type
 * @param {string} sessionId - Session ID from X-Analytics-Session header
 * @param {string} tier - User tier
 * @param {Object} properties - Event properties
 * @returns {Promise<boolean>}
 */
async function emitServerEvent(type, sessionId, tier, properties = {}) {
  // If no session ID provided, skip silently (client didn't send header)
  if (!sessionId) {
    return false;
  }
  
  return emitEvent({
    type,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    tier,
    environment: getServerEnvironment(),
    properties
  });
}

module.exports = {
  validateEvent,
  emitEvent,
  emitServerEvent,
  getServerEnvironment,
  UUID_REGEX,
  MAX_PROPERTIES_SIZE
};
