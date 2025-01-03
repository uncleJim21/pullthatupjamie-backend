require('dotenv').config();
const DEBUG_MODE = process.env.DEBUG_MODE === 'true'
const printLog = (...args) => {
  if (DEBUG_MODE) {
    console.log(...args);
  }
};

module.exports = {
  DEBUG_MODE,
  printLog
};