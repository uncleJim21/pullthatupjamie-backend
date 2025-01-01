const DEBUG_MODE = false;
const printLog = (...args) => {
  if (DEBUG_MODE) {
    console.log(...args);
  }
};

module.exports = {
  DEBUG_MODE,
  printLog
};