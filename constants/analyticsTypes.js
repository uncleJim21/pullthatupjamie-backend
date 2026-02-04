/**
 * Analytics Event Type Constants
 * 
 * All allowed event types for the analytics system.
 * Events not in this list will be rejected by the API.
 */

// Client-side events (emitted by frontend)
const CLIENT_EVENT_TYPES = {
  // Authentication events
  AUTH_MODAL_OPENED: 'auth_modal_opened',
  AUTH_COMPLETED: 'auth_completed',
  AUTH_ABANDONED: 'auth_abandoned',
  
  // Checkout/upgrade events
  CHECKOUT_OPENED: 'checkout_opened',
  CHECKOUT_COMPLETED: 'checkout_completed',
  CHECKOUT_ABANDONED: 'checkout_abandoned',
  
  // Quota/friction events
  QUOTA_EXCEEDED_SHOWN: 'quota_exceeded_shown',
  QUOTA_EXCEEDED_ACTION: 'quota_exceeded_action',
  
  // Journey events
  WIZARD_STEP_REACHED: 'wizard_step_reached',
  PROCESSING_COMPLETED: 'processing_completed'
};

// Server-side events (emitted by backend)
const SERVER_EVENT_TYPES = {
  ENTITLEMENT_CONSUMED: 'entitlement_consumed',
  ENTITLEMENT_DENIED: 'entitlement_denied'
};

// Combined list for validation
const ALL_EVENT_TYPES = [
  ...Object.values(CLIENT_EVENT_TYPES),
  ...Object.values(SERVER_EVENT_TYPES)
];

// Valid tiers
const VALID_TIERS = ['anonymous', 'registered', 'subscriber', 'admin'];

// Valid environments
const VALID_ENVIRONMENTS = ['dev', 'staging', 'prod'];

module.exports = {
  CLIENT_EVENT_TYPES,
  SERVER_EVENT_TYPES,
  ALL_EVENT_TYPES,
  VALID_TIERS,
  VALID_ENVIRONMENTS
};
