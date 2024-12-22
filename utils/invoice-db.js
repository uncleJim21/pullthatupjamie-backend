// invoice-db.js
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

let db;

async function initializeInvoiceDB() {
  db = await open({
    filename: path.join('./dbs', 'invoices.db'),
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

  // Initial cleanup on startup
  await cleanupExpiredInvoices();
  // Schedule regular cleanup
  setInterval(cleanupExpiredInvoices, 1000 * 60 * 15); // Run every 15 minutes
  console.log('Invoice database initialized');

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
  
  // Only record payment if invoice exists and is not expired
  const result = await db.run(
    `UPDATE invoices 
     SET preimage = ?, paid_at = ? 
     WHERE payment_hash = ? 
     AND paid_at IS NULL 
     AND expires_at > ?`,
    [preimage, now, paymentHash, now]
  );
  
  if (result.changes === 0) {
    // If no update occurred, check if invoice exists to determine why
    const invoice = await db.get(
      'SELECT expires_at, paid_at FROM invoices WHERE payment_hash = ?',
      [paymentHash]
    );
    
    if (!invoice) {
      console.log(`Invoice not found: ${paymentHash}`);
      return false;
    }
    
    if (invoice.paid_at) {
      console.log(`Invoice already paid: ${paymentHash}`);
      return false;
    }
    
    if (invoice.expires_at <= now) {
      console.log(`Invoice expired: ${paymentHash}`);
      // Clean up expired invoice
      await deleteInvoice(paymentHash);
      return false;
    }
  }
  
  return result.changes > 0;
}

async function isPaymentHashValid(paymentHash) {
  const now = Math.floor(Date.now() / 1000);
  
  // Check if invoice exists, is not expired, and not already paid
  const invoice = await db.get(
    `SELECT expires_at, paid_at 
     FROM invoices 
     WHERE payment_hash = ?`,
    [paymentHash]
  );
  
  if (!invoice) {
    return false;
  }
  
  // If expired, delete it and return false
  if (invoice.expires_at <= now) {
    await deleteInvoice(paymentHash);
    return false;
  }
  
  // If already paid, return false
  if (invoice.paid_at) {
    return false;
  }
  
  return true;
}

async function deleteInvoice(paymentHash) {
  await db.run('DELETE FROM invoices WHERE payment_hash = ?', [paymentHash]);
}

async function cleanupExpiredInvoices() {
  const now = Math.floor(Date.now() / 1000);
  
  try {
    const result = await db.run(
      'DELETE FROM invoices WHERE expires_at <= ?',
      [now]
    );
    
    if (result.changes > 0) {
      console.log(`Cleaned up ${result.changes} expired invoices`);
    }
  } catch (error) {
    console.error('Error cleaning up expired invoices:', error);
  }
}

// Optional: Function to get invoice details (useful for debugging)
async function getInvoiceDetails(paymentHash) {
  return await db.get(
    'SELECT * FROM invoices WHERE payment_hash = ?',
    [paymentHash]
  );
}

module.exports = {
  initializeInvoiceDB,
  storeInvoice,
  recordPayment,
  isPaymentHashValid,
  cleanupExpiredInvoices,
  getInvoiceDetails
};