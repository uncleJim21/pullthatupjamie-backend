const mongoose = require('mongoose');
const JamieFeedbackSchema = new mongoose.Schema({
    email: String,
    feedback: String,
    timestamp: String,
    mode: String,
    status: String,
    state: String
  });
  
const JamieFeedback = mongoose.model("JamieFeedback", JamieFeedbackSchema);

module.exports = {
    JamieFeedback
}