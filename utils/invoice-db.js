// invoice-db.js
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

let db;

async function initializeDB() {
  db = await open({
    filename: path.join(process.env.DATABASE_PATH || '.', 'invoices.db'),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      payment_hash TEXT PRIMARY KEY,
      invoice_str TEXT NOT NULL,
      preimage TEXT,
      expires_at INTEGER NOT NULL,
      paid_at INTEGER
    )
  `);

  // Schedule cleanup of old invoices
  setInterval(cleanupOldInvoices, 1000 * 60 * 60); // Run hourly
  return db;
}

async function storeInvoice(paymentHash, invoiceStr, expiryTimestamp) {
  await db.run(
    `INSERT INTO invoices (payment_hash, invoice_str, expires_at) 
     VALUES (?, ?, ?)`,
    [paymentHash, invoiceStr, expiryTimestamp]
  );
}

async function recordPayment(paymentHash, preimage) {
  const now = Math.floor(Date.now() / 1000);
  
  const result = await db.run(
    `UPDATE invoices 
     SET preimage = ?, paid_at = ? 
     WHERE payment_hash = ? 
     AND paid_at IS NULL 
     AND expires_at > ?`,
    [preimage, now, paymentHash, now]
  );
  
  return result.changes > 0;
}

async function isPaymentHashValid(paymentHash) {
  const now = Math.floor(Date.now() / 1000);
  
  const invoice = await db.get(
    `SELECT 1 FROM invoices 
     WHERE payment_hash = ? 
     AND expires_at > ?`,
    [paymentHash, now]
  );
  
  return invoice !== undefined;
}

async function cleanupOldInvoices() {
  const yesterday = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
  
  await db.run(
    `DELETE FROM invoices 
     WHERE expires_at < ? 
     OR (paid_at IS NULL AND expires_at < ?)`,
    [yesterday, yesterday]
  );
}

module.exports = {
  initializeDB,
  storeInvoice,
  recordPayment,
  isPaymentHashValid,
  cleanupOldInvoices
};