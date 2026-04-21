const mongoose = require('mongoose');

const WorkflowSessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['running', 'approval_required', 'complete', 'failed'],
    default: 'running',
  },
  task: {
    type: String,
    required: true,
  },
  workflowType: {
    type: String,
    required: false,
  },
  context: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  iterationCount: {
    type: Number,
    default: 0,
  },
  maxIterations: {
    type: Number,
    default: 10,
  },
  accumulatedResults: {
    type: [mongoose.Schema.Types.Mixed],
    default: [],
  },
  // Planner conversation history for resume
  plannerHistory: {
    type: [mongoose.Schema.Types.Mixed],
    default: [],
  },
  pendingAction: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  approvedActions: {
    type: [String],
    default: [],
  },
  outputFormat: {
    type: String,
    default: 'structured',
  },
  ownerId: {
    type: String,
    required: false,
    index: true,
  },
  taskParserResult: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 60 * 60 * 1000), // 1 hour TTL
    index: { expires: 0 },
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('WorkflowSession', WorkflowSessionSchema);
