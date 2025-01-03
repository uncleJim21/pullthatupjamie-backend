// rate-limited-invoice.js
class RateLimitedInvoiceGenerator {
  constructor() {
    this.lastInvoiceTime = 0;
    this.minIntervalMs = 300; // Minimum 1 second between requests
    this.retryDelayMs = 2000;  // Start with 2 second retry delay
    this.maxRetries = 3;
  }

  async generateInvoiceWithBackoff(generateFn) {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        // Ensure minimum time between requests
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastInvoiceTime;
        if (timeSinceLastRequest < this.minIntervalMs) {
          await new Promise(resolve => 
            setTimeout(resolve, this.minIntervalMs - timeSinceLastRequest)
          );
        }

        const result = await generateFn();
        this.lastInvoiceTime = Date.now();
        return result;
      } catch (error) {
        console.log(`Invoice generation attempt ${attempt + 1} failed:`, error.message);
        
        if (attempt < this.maxRetries - 1) {
          // Exponential backoff
          const backoffTime = this.retryDelayMs * Math.pow(2, attempt);
          console.log(`Waiting ${backoffTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoffTime));
        } else {
          throw error;
        }
      }
    }
  }

  async generateInvoicePool(poolSize, generateFn) {
    const invoices = [];
    
    // Generate invoices sequentially with rate limiting
    for (let i = 0; i < poolSize; i++) {
      try {
        const invoice = await this.generateInvoiceWithBackoff(generateFn);
        invoices.push(invoice);
      } catch (error) {
        console.error(`Failed to generate invoice ${i + 1}/${poolSize}:`, error);
        // Continue with partial pool rather than failing completely
        break;
      }
    }

    return invoices;
  }
}

module.exports = { RateLimitedInvoiceGenerator };