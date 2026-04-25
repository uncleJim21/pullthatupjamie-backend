require('dotenv').config();
const DEBUG_MODE = process.env.DEBUG_MODE === 'true'
// VERBOSE_LOGGING enables printLog output WITHOUT switching the Mongo
// connection to MONGO_DEBUG_URI. Useful when you want to see internal
// search/triage/agent traces against the prod DB. DEBUG_MODE still
// implies verbose logging (back-compat) and additionally swaps the DB.
const VERBOSE_LOGGING = DEBUG_MODE || process.env.VERBOSE_LOGGING === 'true'
const SCHEDULER_ENABLED = process.env.DISABLE_SCHEDULER !== 'true' // Enable scheduler by default unless explicitly disabled

const SCHEDULED_INGESTOR_TIMES = process.env.SCHEDULED_INGESTOR_TIMES ? 
  process.env.SCHEDULED_INGESTOR_TIMES.split(',').map(time => time.trim()) : 
  ['16:35'];

const printLog = (...args) => {
  if (VERBOSE_LOGGING) {
    console.log(...args);
  }
};

module.exports = {
  DEBUG_MODE,
  VERBOSE_LOGGING,
  SCHEDULER_ENABLED,
  SCHEDULED_INGESTOR_TIMES,
  printLog
};