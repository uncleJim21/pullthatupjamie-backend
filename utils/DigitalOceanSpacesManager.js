const { 
    S3Client, 
    PutObjectCommand, 
    GetObjectCommand, 
    DeleteObjectCommand 
  } = require("@aws-sdk/client-s3");
  
  class DigitalOceanSpacesManager {
    constructor(spacesEndpoint, accessKeyId, secretAccessKey) {
      // Validate credentials
      if (!spacesEndpoint || !accessKeyId || !secretAccessKey) {
        throw new Error('Missing required credentials for DigitalOcean Spaces');
      }
  
      // Clean and validate endpoint
      this.spacesEndpoint = spacesEndpoint.replace(/^https?:\/\//, '');
      
      // Configure S3 client with specific settings for DO Spaces
      this.s3Client = new S3Client({
        endpoint: `https://${this.spacesEndpoint}`,
        region: "us-east-1",
        credentials: {
          accessKeyId: accessKeyId,
          secretAccessKey: secretAccessKey
        },
        forcePathStyle: true, // Required for DigitalOcean Spaces
      });
  
      // Test credentials on instantiation
      this.testConnection();
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
        await this.s3Client.send(command);
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
  
      const params = {
        Bucket: bucketName,
        Key: fileName,
        Body: fileContent,
        ContentType: contentType || 'application/octet-stream',
        ACL: "public-read"
      };
  
      try {
        const command = new PutObjectCommand(params);
        await this.s3Client.send(command);
        return `https://${bucketName}.${this.spacesEndpoint}/${fileName}`;
      } catch (error) {
        console.error("Error uploading file:", error.message);
        if (error.name === 'NoSuchBucket') {
          throw new Error(`Bucket ${bucketName} does not exist`);
        }
        throw new Error(`Failed to upload file: ${error.message}`);
      }
    }
  
    async getFileAsBuffer(bucketName, fileName) {
      if (!bucketName || !fileName) {
        throw new Error('Bucket name and file name are required');
      }
  
      const params = {
        Bucket: bucketName,
        Key: fileName
      };
  
      try {
        const command = new GetObjectCommand(params);
        const response = await this.s3Client.send(command);
        
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
        throw error;
      }
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
        await this.s3Client.send(command);
      } catch (error) {
        console.error("Error deleting file:", error.message);
        throw new Error(`Failed to delete file: ${error.message}`);
      }
    }
  }
  
  module.exports = DigitalOceanSpacesManager;