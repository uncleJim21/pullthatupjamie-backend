const mongoose = require('mongoose');

/**
 * AgentInvoice Schema
 * 
 * Tracks Lightning invoices generated for agent API credit purchases.
 * Replaces the deprecated SQLite invoice-db for agent-specific flows.
 * 
 * Lifecycle: pending → paid (on activation) or auto-deleted (TTL after expiry)
 */
const agentInvoiceSchema = new mongoose.Schema({
  // Payment hash from the Lightning invoice (unique identifier)
  paymentHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // BOLT11 invoice string
  invoiceStr: {
    type: String,
    required: true
  },

  // Amount in satoshis
  amountSats: {
    type: Number,
    required: true
  },

  // USD value in microdollars (1 microdollar = $0.000001) at time of purchase
  amountUsdMicro: {
    type: Number,
    required: true
  },

  // BTC/USD rate used for the conversion at purchase time
  btcUsdRate: {
    type: Number,
    required: true
  },

  // Optional client ID for session linking
  clientId: {
    type: String,
    default: null
  },

  // Invoice status
  status: {
    type: String,
    enum: ['pending', 'paid', 'expired'],
    default: 'pending',
    index: true
  },

  // When the invoice was paid/activated
  paidAt: {
    type: Date,
    default: null
  },

  // When the invoice expires (from bolt11 decode)
  expiresAt: {
    type: Date,
    required: true
  }
}, {
  timestamps: true
});

// TTL index: auto-delete 14 days after expiry
agentInvoiceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

// Compound index for status queries
agentInvoiceSchema.index({ paymentHash: 1, status: 1 });

const AgentInvoice = mongoose.model('AgentInvoice', agentInvoiceSchema);

module.exports = { AgentInvoice };
