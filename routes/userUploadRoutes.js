const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * Validate upload file name
 * Pattern from videoEditRoutes.js
 */
function validateUploadFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    return { ok: false, code: 'empty', message: 'File name is required' };
  }

  const trimmed = fileName.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: 'empty', message: 'File name cannot be empty' };
  }

  if (trimmed.length > 255) {
    return { ok: false, code: 'too_long', message: 'File name must be 255 characters or less' };
  }

  // Check for path traversal attempts
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    return { ok: false, code: 'invalid_chars', message: 'File name cannot contain path separators' };
  }

  // Ensure it has a file extension
  if (!trimmed.includes('.')) {
    return { ok: false, code: 'missing_extension', message: 'File name must have an extension' };
  }

  return { ok: true };
}

/**
 * POST /api/user/upload/presigned-url
 * Generate presigned URL for file upload (no podcast required)
 * Pattern from videoEditRoutes.js but uses authenticateToken
 */
router.post('/presigned-url', authenticateToken, async (req, res) => {
  try {
    const { fileName, fileType, acl = 'public-read', cacheControl = false } = req.body;

    if (!fileName || !fileType) {
      return res.status(400).json({ error: "File name and type are required" });
    }

    // Validate file name
    const fileNameCheck = validateUploadFileName(fileName);
    if (!fileNameCheck.ok) {
      return res.status(400).json({
        error: "invalid_filename",
        code: fileNameCheck.code,
        message: fileNameCheck.message,
        hint: "Try a simpler name like my-image.jpg"
      });
    }

    // Validate allowed file types
    const allowedFileTypes = [
      // Image formats (most common for social media)
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp',
      'image/svg+xml', 'image/x-icon',
      // Video formats
      'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 
      'video/x-flv', 'video/x-matroska', 'video/3gpp', 'video/3gpp2', 'video/x-m4v',
      'video/mpeg', 'video/avi', 'video/mov', 'video/x-ms-wmv', 'video/x-ms-asf',
      // Audio formats
      'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 
      'audio/aac', 'audio/flac', 'audio/x-ms-wma', 'audio/vnd.wav', 'audio/basic',
      'audio/x-aiff', 'audio/x-m4a', 'audio/x-matroska', 'audio/xm', 'audio/midi',
    ];

    if (!allowedFileTypes.includes(fileType)) {
      return res.status(400).json({ 
        error: "File type not allowed",
        allowedTypes: allowedFileTypes
      });
    }

    // Get user ID for file organization
    const { User } = require('../models/shared/UserSchema');
    let user = null;
    
    if (req.user.email) {
      user = await User.findOne({ email: req.user.email }).select('_id');
    } else if (req.user.provider && req.user.providerId) {
      user = await User.findOne({
        'authProvider.provider': req.user.provider,
        'authProvider.providerId': req.user.providerId
      }).select('_id');
    } else if (req.user.id) {
      user = await User.findById(req.user.id).select('_id');
    }

    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    const userId = user._id.toString();

    // Generate unique file key
    const { v4: uuidv4 } = require('uuid');
    const uniqueId = uuidv4();
    const key = `user-uploads/${userId}/${uniqueId}/${fileName}`;

    // Get bucket and region from env
    const bucketName = process.env.SPACES_CLIP_BUCKET_NAME;
    const region = process.env.SPACES_REGION || 'nyc3';
    const endpoint = process.env.SPACES_ENDPOINT || 'https://nyc3.digitaloceanspaces.com';

    if (!bucketName) {
      return res.status(503).json({ error: "Upload service not configured" });
    }

    // Generate presigned URL using AWS SDK
    const AWS = require('aws-sdk');
    const spacesEndpoint = new AWS.Endpoint(endpoint);
    const s3 = new AWS.S3({
      endpoint: spacesEndpoint,
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET,
      region
    });

    const params = {
      Bucket: bucketName,
      Key: key,
      Expires: 300, // 5 minutes
      ACL: acl,
      ContentType: fileType
    };

    // Add cache control if requested
    if (cacheControl) {
      const cacheControlValue = typeof cacheControl === 'string' 
        ? cacheControl 
        : 'public, max-age=31536000, immutable';
      params.CacheControl = cacheControlValue;
    }

    const uploadUrl = await s3.getSignedUrlPromise('putObject', params);
    const publicUrl = `https://${bucketName}.${endpoint.replace('https://', '')}/${key}`;

    res.json({
      uploadUrl,
      key,
      publicUrl,
      cacheControl: params.CacheControl || null
    });

  } catch (error) {
    console.error('Error generating presigned URL:', error);
    res.status(500).json({
      error: 'Failed to generate upload URL',
      message: error.message
    });
  }
});

module.exports = router;
