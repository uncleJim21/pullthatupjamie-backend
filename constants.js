require('dotenv').config();
const DEBUG_MODE = process.env.DEBUG_MODE === 'true'
const SCHEDULER_ENABLED = process.env.DISABLE_SCHEDULER !== 'true' // Enable scheduler by default unless explicitly disabled

const SCHEDULED_INGESTOR_TIMES = process.env.SCHEDULED_INGESTOR_TIMES ? 
  process.env.SCHEDULED_INGESTOR_TIMES.split(',').map(time => time.trim()) : 
  ['16:35'];

const printLog = (...args) => {
  if (DEBUG_MODE) {
    console.log(...args);
  }
};

module.exports = {
  DEBUG_MODE,
  SCHEDULER_ENABLED,
  SCHEDULED_INGESTOR_TIMES,
  printLog
};