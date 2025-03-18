const { 
    S3Client, 
    PutObjectCommand, 
    GetObjectCommand, 
    DeleteObjectCommand 
  } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  
  class DigitalOceanSpacesManager {
    constructor(spacesEndpoint, accessKeyId, secretAccessKey, options = {}) {
        // Validate credentials
        if (!spacesEndpoint || !accessKeyId || !secretAccessKey) {
            throw new Error('Missing required credentials for DigitalOcean Spaces');
        }
    
        // Clean and validate endpoint
        this.spacesEndpoint = spacesEndpoint.replace(/^https?:\/\//, '');
        
        // Store credentials for creating new clients
        this.credentials = {
            accessKeyId,
            secretAccessKey
        };
        
        // Set retry options with defaults
        this.retryOptions = {
            maxRetries: options.maxRetries || 3,
            baseDelay: options.baseDelay || 1000,
            maxDelay: options.maxDelay || 10000,
            timeout: options.timeout || 30000
        };
    
        // Create initial client
        this.createClient();
    
        // Test credentials on instantiation
        this.testConnection();
    }

      createClient() {
          return new S3Client({
              endpoint: `https://${this.spacesEndpoint}`,
              region: "us-east-1",
              credentials: this.credentials,
              forcePathStyle: true,
          });
      }
  
    async testConnection() {
      try {
        // Attempt a simple operation to verify credentials
        const command = new PutObjectCommand({
          Bucket: 'test-connection',
          Key: 'test.txt',
          Body: 'test'
        });
        
        // We expect this to fail with a NoSuchBucket error, but not a credentials error
        const client = this.createClient();
        await client.send(command);
      } catch (error) {
        if (error.name === 'InvalidAccessKeyId' || error.name === 'SignatureDoesNotMatch') {
          throw new Error('Invalid DigitalOcean Spaces credentials');
        }
        // Other errors (like NoSuchBucket) are expected and can be ignored for this test
      }
    }
  
    async uploadFile(bucketName, fileName, fileContent, contentType) {
      if (!bucketName || !fileName) {
          throw new Error('Bucket name and file name are required');
      }
  
      let attempt = 0;
      let lastError;
  
      while (attempt < this.retryOptions.maxRetries) {
          try {
              // Create a new client for this specific attempt
              const client = this.createClient();
  
              const params = {
                  Bucket: bucketName,
                  Key: fileName,
                  Body: fileContent,
                  ContentType: contentType || 'application/octet-stream',
                  ACL: "public-read"
              };
  
              // Create upload promise with new client
              const uploadPromise = async () => {
                  const command = new PutObjectCommand(params);
                  await client.send(command);
                  return `https://${bucketName}.${this.spacesEndpoint}/${fileName}`;
              };
  
              // Create timeout promise
              const timeoutPromise = new Promise((_, reject) => {
                  setTimeout(() => reject(new Error('Upload timeout')), 
                      this.retryOptions.timeout);
              });
  
              // Race between upload and timeout
              const result = await Promise.race([uploadPromise(), timeoutPromise]);
              return result;
  
          } catch (error) {
              lastError = error;
              attempt++;
  
              if (attempt === this.retryOptions.maxRetries) {
                  console.error(`All retry attempts exhausted for ${fileName}`, error);
                  break;
              }
  
              // Calculate exponential backoff with jitter
              const jitter = Math.random() * 1000;
              const delay = Math.min(
                  this.retryOptions.baseDelay * Math.pow(2, attempt) + jitter,
                  this.retryOptions.maxDelay
              );
  
              console.log(`Upload attempt ${attempt} failed for ${fileName}. Retrying in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
          }
      }
  
      // If we get here, all retries failed
      if (lastError?.name === 'NoSuchBucket') {
          throw new Error(`Bucket ${bucketName} does not exist`);
      }
      throw new Error(`Failed to upload file after ${this.retryOptions.maxRetries} attempts: ${lastError?.message}`);
  }
  
    async getFileAsBuffer(bucketName, fileName) {
        if (!bucketName || !fileName) {
            throw new Error('Bucket name and file name are required');
        }
    
        const params = {
            Bucket: bucketName,
            Key: fileName
        };
    
        let attempt = 0;
        let lastError;
    
        while (attempt < this.retryOptions.maxRetries) {
            try {
                const client = this.createClient();
                const command = new GetObjectCommand(params);
                
                const response = await client.send(command);
                
                // Convert the readable stream to a buffer
                const chunks = [];
                for await (const chunk of response.Body) {
                    chunks.push(chunk);
                }
                
                return Buffer.concat(chunks);
                
            } catch (error) {
                if (error.name === 'NoSuchKey') {
                    throw new Error(`File ${fileName} not found in bucket ${bucketName}`);
                }
    
                lastError = error;
                attempt++;
    
                if (attempt === this.retryOptions.maxRetries) {
                    break;
                }
    
                const jitter = Math.random() * 1000;
                const delay = Math.min(
                    this.retryOptions.baseDelay * Math.pow(2, attempt) + jitter,
                    this.retryOptions.maxDelay
                );
    
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    
        throw new Error(`Failed to get file after ${this.retryOptions.maxRetries} attempts: ${lastError?.message}`);
    }
  
    async deleteFile(bucketName, fileName) {
      if (!bucketName || !fileName) {
        throw new Error('Bucket name and file name are required');
      }
  
      const params = {
        Bucket: bucketName,
        Key: fileName
      };
  
      try {
        const command = new DeleteObjectCommand(params);
        const client = this.createClient();
        await client.send(command);
      } catch (error) {
        console.error("Error deleting file:", error.message);
        throw new Error(`Failed to delete file: ${error.message}`);
      }
    }

    async generatePresignedUploadUrl(bucketName, key, contentType, expiresIn = 3600, maxSizeBytes = 1024 * 1024 * 100, acl = null) {
      console.log(`Generating pre-signed URL for ${bucketName}/${key} (contentType: ${contentType}, acl: ${acl || 'none'})`);
      
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        ContentType: contentType,
      });

      // Only add ACL if specified (some buckets might restrict ACL)
      if (acl) {
        console.log(`Setting ACL to ${acl}`);
        command.input.ACL = acl;
      }

      // Set configuration for the signed URL
      const signedUrlOptions = { 
        expiresIn
      };

      // Note: We intentionally don't set ContentLength in the command
      // as it can cause issues with curl and other HTTP clients
      // maxSizeBytes is just used for client-side validation

      try {
        console.log(`Creating S3 client for endpoint: https://${this.spacesEndpoint}`);
        const client = this.createClient();
        const url = await getSignedUrl(client, command, signedUrlOptions);
        console.log(`Generated pre-signed URL successfully: ${url.substring(0, 100)}...`);
        return url;
      } catch (error) {
        console.error("Error generating pre-signed URL:", error);
        throw error;
      }
    }
  }

  
  
  module.exports = DigitalOceanSpacesManager;