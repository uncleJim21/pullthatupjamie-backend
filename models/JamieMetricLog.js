const mongoose = require('mongoose');

const JamieMetricLogSchema = new mongoose.Schema({
  userId: String,
  timestamp: Date,
  mode: String,
  dailyRequestCount: Number,
});

async function getDailyRequestCount(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const count = await JamieMetricLog.countDocuments({
    userId: userId,
    timestamp: {
      $gte: startOfDay,
      $lte: endOfDay
    }
  });

  return count;
}

const JamieMetricLog = mongoose.model("JamieMetricLog", JamieMetricLogSchema);

module.exports = {
  getDailyRequestCount,
  JamieMetricLog
}